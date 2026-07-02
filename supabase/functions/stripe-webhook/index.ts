// Stripe Webhook Handler
// イベント: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
// profiles.tier を正しいプラン名（'light' | 'standard'）で更新する

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
  httpClient: Stripe.createFetchHttpClient(),
});

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

// Stripe Price ID → プラン名のマッピング（本番・テスト両対応）
const PRICE_TO_PLAN: Record<string, string> = {
  // テスト環境
  "price_1To2nhFip1mPhO1UJQNLkKdZ": "light",
  "price_1To2oGFip1mPhO1UvhtEvSit": "standard",
};

async function getPlanFromSubscription(subscription: Stripe.Subscription): Promise<string> {
  // 1. サブスクリプションメタデータから plan を読む（最も信頼性が高い）
  if (subscription.metadata?.plan) {
    return subscription.metadata.plan;
  }

  // 2. Price ID から plan を特定
  const priceId = subscription.items.data[0]?.price?.id;
  if (priceId && PRICE_TO_PLAN[priceId]) {
    return PRICE_TO_PLAN[priceId];
  }

  // 3. 環境変数から Price ID を動的に読む
  const lightPriceId  = Deno.env.get("LIGHT_PRICE_ID") ?? "";
  const stdPriceId    = Deno.env.get("STANDARD_PRICE_ID") ?? "";
  if (priceId) {
    if (priceId === lightPriceId)  return "light";
    if (priceId === stdPriceId)    return "standard";
  }

  // 4. フォールバック（どうしても特定できない場合は standard にしない）
  console.warn("Could not determine plan from subscription:", subscription.id, "price:", priceId);
  return "standard";
}

serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  let event: Stripe.Event;
  try {
    const body = await req.text();
    event = await stripe.webhooks.constructEventAsync(body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== "subscription") break;

        const userId = session.metadata?.user_id || session.client_reference_id;
        if (!userId) { console.error("No user_id in session metadata"); break; }

        // plan はセッションメタデータから取得
        const plan = session.metadata?.plan || "standard";

        // サブスクリプション情報を取得
        const subscriptionId = typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;

        const subscription = subscriptionId
          ? await stripe.subscriptions.retrieve(subscriptionId)
          : null;
        const stripeCustomerId = typeof session.customer === "string"
          ? session.customer
          : session.customer?.id;

        const { error } = await supabaseAdmin.from("profiles").update({
          tier: plan,
          is_active: true,
          stripe_customer_id: stripeCustomerId ?? null,
          stripe_subscription_id: subscriptionId ?? null,
        }).eq("id", userId);

        if (error) console.error("profiles update error (checkout.session.completed):", error);
        else console.log(`User ${userId} → tier=${plan}`);
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;

        // user_id はサブスクリプションメタデータから
        const userId = sub.metadata?.user_id;
        if (!userId) {
          // customer_id 経由で検索
          const custId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
          const { data: profile } = await supabaseAdmin
            .from("profiles")
            .select("id")
            .eq("stripe_customer_id", custId)
            .maybeSingle();
          if (!profile) { console.error("No profile for customer:", custId); break; }

          const plan = await getPlanFromSubscription(sub);
          const isActive = sub.status === "active" || sub.status === "trialing";
          await supabaseAdmin.from("profiles").update({
            tier: isActive ? plan : "free",
            is_active: isActive,
          }).eq("id", profile.id);
          break;
        }

        const plan = await getPlanFromSubscription(sub);
        const isActive = sub.status === "active" || sub.status === "trialing";
        const { error } = await supabaseAdmin.from("profiles").update({
          tier: isActive ? plan : "free",
          is_active: isActive,
        }).eq("id", userId);
        if (error) console.error("profiles update error (subscription.updated):", error);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const userId = sub.metadata?.user_id;

        if (!userId) {
          const custId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
          const { data: profile } = await supabaseAdmin
            .from("profiles")
            .select("id")
            .eq("stripe_customer_id", custId)
            .maybeSingle();
          if (profile) {
            await supabaseAdmin.from("profiles").update({ tier: "free", is_active: false }).eq("id", profile.id);
          }
          break;
        }

        const { error } = await supabaseAdmin.from("profiles").update({
          tier: "free",
          is_active: false,
        }).eq("id", userId);
        if (error) console.error("profiles update error (subscription.deleted):", error);
        else console.log(`User ${userId} → tier=free (subscription deleted)`);
        break;
      }

      default:
        console.log("Unhandled event type:", event.type);
    }
  } catch (err) {
    console.error("Error processing webhook:", err);
    return new Response("Internal error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
