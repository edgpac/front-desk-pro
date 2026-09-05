import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

// A genuine raw HTTP endpoint (not a createServerFn) — Stripe's servers POST
// here directly, and signature verification needs the exact raw request
// body, which the createServerFn RPC layer isn't built to hand over.
export const Route = createFileRoute("/api/stripe/webhook")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const stripeSecretKey = process.env["STRIPE_SECRET_KEY"];
        const webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];
        if (!stripeSecretKey || !webhookSecret) {
          console.error("Stripe webhook received but STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET aren't set.");
          return new Response("Webhook not configured", { status: 500 });
        }

        const signature = request.headers.get("stripe-signature");
        const rawBody = await request.text();
        if (!signature) {
          return new Response("Missing stripe-signature header", { status: 400 });
        }

        const stripe = new Stripe(stripeSecretKey);
        let event: Stripe.Event;
        try {
          event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
        } catch (err) {
          console.error("Stripe webhook signature verification failed:", err);
          return new Response("Invalid signature", { status: 400 });
        }

        if (event.type === "checkout.session.completed") {
          const session = event.data.object as Stripe.Checkout.Session;
          const userId = session.client_reference_id || session.metadata?.["userId"];
          const plan = session.metadata?.["plan"];

          if (!userId) {
            console.error("Checkout completed but no userId on the session — can't attach a plan.");
            return new Response(JSON.stringify({ received: true }), { status: 200 });
          }

          const supabaseUrl = process.env["SUPABASE_URL"];
          const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
          if (!supabaseUrl || !serviceRoleKey) {
            console.error(
              "Checkout completed but SUPABASE_SERVICE_ROLE_KEY isn't set — can't record the subscription.",
            );
            return new Response(JSON.stringify({ received: true }), { status: 200 });
          }

          const admin = createClient(supabaseUrl, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
          });

          const { error } = await admin.auth.admin.updateUserById(userId, {
            user_metadata: {
              plan,
              subscriptionStatus: "active",
              stripeCustomerId: session.customer,
            },
          });
          if (error) {
            console.error("Failed to record subscription on the user:", error);
          }
        }

        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
