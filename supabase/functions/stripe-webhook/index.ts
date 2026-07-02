// Stripe Webhook Handler
// イベント: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
// profiles.tier を正しいプラン名（'light' | 'standard'）で更新する
// 注意: Stripe SDK は使わず Web Crypto API で署名検証（Supabase Edge Runtime 互換）

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

// APP_ENV=dev のときはテスト用 Webhook Secret、それ以外は本番用
const APP_ENV = Deno.env.get("APP_ENV") ?? "prod";
const IS_DEV  = APP_ENV === "dev";
const WEBHOOK_SECRET = IS_DEV
  ? (Deno.env.get("STRIPE_WEBHOOK_SECRET_TEST") ?? "")
  : (Deno.env.get("STRIPE_WEBHOOK_SECRET_LIVE") ?? "");

// Stripe Price ID → プラン名のマッピング（本番・テスト両対応）
const PRICE_TO_PLAN: Record<string, string> = {
  // テスト環境
  "price_1To2nhFip1mPhO1UJQNLkKdZ": "light",
  "price_1To2oGFip1mPhO1UvhtEvSit": "standard",
};

// Web Crypto API による Stripe webhook 署名検証
async function verifyStripeSignature(
  body: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  // sig header: "t=timestamp,v1=sig1,v1=sig2,..."
  const parts = sigHeader.split(",");
  const tPart = parts.find((p) => p.startsWith("t="));
  const v1Parts = parts.filter((p) => p.startsWith("v1="));
  if (!tPart || v1Parts.length === 0) return false;

  const timestamp = tPart.slice(2);
  const payload = `${timestamp}.${body}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return v1Parts.some((p) => p.slice(3) === sigHex);
}

function getPlanFromSubscriptionData(sub: Record<string, unknown>): string {
  // 1. サブスクリプションメタデータから plan を読む
  const metadata = sub.metadata as Record<string, string> | undefined;
  if (metadata?.plan) return metadata.plan;

  // 2. Price ID から plan を特定
  const items = sub.items as { data: Array<{ price: { id: string } }> } | undefined;
  const priceId = items?.data[0]?.price?.id;
  if (priceId && PRICE_TO_PLAN[priceId]) return PRICE_TO_PLAN[priceId];

  // 3. 環境変数から Price ID を動的に読む
  const lightPriceId = Deno.env.get("LIGHT_PRICE_ID") ?? "";
  const stdPriceId   = Deno.env.get("STANDARD_PRICE_ID") ?? "";
  if (priceId) {
    if (priceId === lightPriceId) return "light";
    if (priceId === stdPriceId)   return "standard";
  }

  console.warn("Could not determine plan from subscription:", sub.id, "price:", priceId);
  return "standard";
}

serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  const body = await req.text();

  const valid = await verifyStripeSignature(body, sig, WEBHOOK_SECRET);
  if (!valid) {
    console.error("Webhook signature verification failed");
    return new Response("Webhook Error: invalid signature", { status: 400 });
  }

  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(body);
  } catch (err) {
    console.error("JSON parse error:", err);
    return new Response("Invalid JSON", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "subscription") break;

        const metadata = session.metadata as Record<string, string> | undefined;
        const userId = metadata?.user_id || (session.client_reference_id as string | undefined);
        if (!userId) { console.error("No user_id in session metadata"); break; }

        const plan = metadata?.plan || "standard";

        const subscriptionId = typeof session.subscription === "string"
          ? session.subscription
          : (session.subscription as { id: string } | null)?.id;

        const stripeCustomerId = typeof session.customer === "string"
          ? session.customer
          : (session.customer as { id: string } | null)?.id;

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
        const sub = event.data.object;
        const metadata = sub.metadata as Record<string, string> | undefined;
        const userId = metadata?.user_id;
        const status = sub.status as string;
        const isActive = status === "active" || status === "trialing";
        const plan = getPlanFromSubscriptionData(sub);

        if (!userId) {
          const custId = typeof sub.customer === "string"
            ? sub.customer
            : (sub.customer as { id: string } | null)?.id;
          const { data: profile } = await supabaseAdmin
            .from("profiles")
            .select("id")
            .eq("stripe_customer_id", custId)
            .maybeSingle();
          if (!profile) { console.error("No profile for customer:", custId); break; }

          await supabaseAdmin.from("profiles").update({
            tier: isActive ? plan : "free",
            is_active: isActive,
          }).eq("id", profile.id);
          break;
        }

        const { error } = await supabaseAdmin.from("profiles").update({
          tier: isActive ? plan : "free",
          is_active: isActive,
        }).eq("id", userId);
        if (error) console.error("profiles update error (subscription.updated):", error);
        else console.log(`User ${userId} → tier=${isActive ? plan : "free"}, is_active=${isActive}`);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const metadata = sub.metadata as Record<string, string> | undefined;
        const userId = metadata?.user_id;

        if (!userId) {
          const custId = typeof sub.customer === "string"
            ? sub.customer
            : (sub.customer as { id: string } | null)?.id;
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
