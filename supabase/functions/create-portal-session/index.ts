import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
    if (!token) return new Response("Missing access token", { status: 401, headers: corsHeaders });

    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const { return_url, subscription_id } = await req.json();
    if (!return_url) return new Response("Missing return_url", { status: 400, headers: corsHeaders });

    // stripe_customer_id を profiles から取得
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", user.id)
      .single();

    if (!profile?.stripe_customer_id) {
      return new Response("No Stripe customer found", { status: 404, headers: corsHeaders });
    }

    // Stripe Billing Portal Session を作成（REST API直接呼び出し）
    const params = new URLSearchParams({
      customer: profile.stripe_customer_id,
      return_url,
    });

    // subscription_id が渡された場合はサブスク更新画面に直行
    if (subscription_id) {
      params.append("flow_data[type]", "subscription_update");
      params.append("flow_data[subscription_update][subscription]", subscription_id);
    }

    const stripeRes = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) {
      console.error("Stripe error:", session);
      return new Response("Stripe error: " + (session.error?.message ?? "unknown"), { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });

  } catch (err) {
    console.error("create-portal-session error:", err);
    return new Response("Internal error", { status: 500, headers: corsHeaders });
  }
});
