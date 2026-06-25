// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { stripe, supabaseAdmin, corsHeaders } from "../_shared/config.ts";

// APP_ENV=dev のときはテスト用 Price ID を使用、それ以外は Secrets の値を使用
const APP_ENV = Deno.env.get("APP_ENV") ?? "prod";
const IS_DEV  = APP_ENV === "dev";

const PRICE_IDS: Record<string, string> = {
  standard: IS_DEV
    ? "price_1THEGUFip1mPhO1Uc5TEVzwG"               // テスト環境
    : Deno.env.get("STANDARD_PRICE_ID") ?? "",         // 本番環境
  premium: IS_DEV
    ? "price_1THEE4Fip1mPhO1U0NawHmJz"                // テスト環境
    : Deno.env.get("PREMIUM_PRICE_ID")  ?? "",         // 本番環境
};

const TRIAL_DAYS = 7; // 無料トライアル日数

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : authHeader.trim();

    if (!token) {
      return new Response("Missing access token", { status: 401, headers: corsHeaders });
    }

    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) {
      console.error("auth.getUser error:", userError);
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }

    const userId    = user.id;
    const userEmail = user.email ?? undefined;

    const { user_id: bodyUserId, plan, success_url, cancel_url } = await req.json();

    if (!plan || !success_url || !cancel_url) {
      return new Response("Missing plan or redirect URLs", { status: 400, headers: corsHeaders });
    }
    if (!["standard", "premium"].includes(plan)) {
      return new Response("Invalid plan. Must be 'standard' or 'premium'", { status: 400, headers: corsHeaders });
    }
    if (bodyUserId && bodyUserId !== userId) {
      return new Response("user_id mismatch", { status: 403, headers: corsHeaders });
    }

    const priceId = PRICE_IDS[plan];
    if (!priceId) {
      console.error(`PRICE_ID for plan "${plan}" is not set (APP_ENV=${APP_ENV})`);
      return new Response(`Price ID for "${plan}" is not configured on server`, { status: 500, headers: corsHeaders });
    }

    const { data: profile, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id, stripe_subscription_id, tier, is_active")
      .eq("id", userId)
      .single();

    if (profErr) {
      console.warn("profiles select error:", profErr);
    }

    // ── トライアル判定 ──────────────────────────────────
    // stripe_subscription_id が存在する = 実際に決済完了済み = トライアルなし
    // checkout画面を開いてキャンセルした場合は stripe_subscription_id が null のまま = トライアル対象
    const isFirstTime = !(profile?.stripe_subscription_id);

    // ── Stripe顧客IDを取得 or 作成 ──────────────────
    // ⚠️ stripe_customer_id の DB書き込みはここでは行わない。
    //    webhook (checkout.session.completed) のタイミングで書く。
    //    こうすることで「画面を開いただけ = 課金歴あり」という誤判定を防ぐ。
    let stripeCustomerId: string | null = profile?.stripe_customer_id ?? null;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: userEmail,
        metadata: { supabase_user_id: userId },
      });
      stripeCustomerId = customer.id;
    }

    const subscriptionData: any = {
      metadata: { user_id: userId, plan },
    };

    if (isFirstTime) {
      subscriptionData.trial_period_days = TRIAL_DAYS;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      metadata: { user_id: userId, plan },
      subscription_data: subscriptionData,
      success_url,
      cancel_url,
      payment_method_types: ["card"],
    });

    return new Response(
      JSON.stringify({ url: session.url, has_trial: isFirstTime }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );

  } catch (err) {
    console.error("create-checkout-session error:", err);
    return new Response("Error creating session", { status: 500, headers: corsHeaders });
  }
});
