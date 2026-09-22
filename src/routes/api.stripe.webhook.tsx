import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";

import { PLAN_PRICE_CENTS } from "@/lib/stripe-server";

type Plan = "solo" | "crew";

// Reverse of PLAN_PRICE_CENTS — lifecycle events (renewals, plan changes,
// cancellations) carry a Subscription object with a real unit_amount, but
// no guarantee of a fresh, accurate `plan` metadata field the way a brand
// new checkout does. Matching on price is the source of truth; metadata is
// only a fallback (see resolvePlan below).
const PRICE_CENTS_TO_PLAN = Object.fromEntries(
  Object.entries(PLAN_PRICE_CENTS).map(([plan, cents]) => [cents, plan as Plan]),
) as Record<number, Plan>;

function getAdminClient() {
  const supabaseUrl = process.env["SUPABASE_URL"];
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Every event below needs to resolve back to a Supabase user id. Subscription
// events carry it directly, stamped at creation/plan-change time
// (createCheckoutSession's subscription_data.metadata, changeMyPlan's
// metadata) — that's tried first since it needs no extra API call. Anything
// without it (invoices, or a subscription that predates this change) falls
// back to the Stripe Customer's own metadata.userId, set once when the
// customer is first created — never re-derived from email, which isn't
// guaranteed stable/unique the way a Stripe id is.
async function resolveUserId(
  stripe: Stripe,
  customerId: string | Stripe.Customer | Stripe.DeletedCustomer | null,
  subscriptionMetadataUserId?: string,
): Promise<string | null> {
  if (subscriptionMetadataUserId) return subscriptionMetadataUserId;
  if (!customerId) return null;
  const id = typeof customerId === "string" ? customerId : customerId.id;
  const customer = await stripe.customers.retrieve(id);
  if (customer.deleted) return null;
  return (customer.metadata?.["userId"] as string | undefined) ?? null;
}

function resolvePlan(subscription: Stripe.Subscription): Plan | null {
  const amount = subscription.items.data[0]?.price?.unit_amount;
  if (amount != null && PRICE_CENTS_TO_PLAN[amount]) return PRICE_CENTS_TO_PLAN[amount];
  const metaPlan = subscription.metadata?.["plan"];
  return metaPlan === "solo" || metaPlan === "crew" ? metaPlan : null;
}

// Supabase's admin updateUserById replaces user_metadata wholesale, not a
// merge — without reading the current value first, every subscription event
// would silently wipe out unrelated fields already on the user (name/phone,
// written at signup). Always read-then-spread, never write a bare literal.
async function writeSubscriptionState(
  admin: SupabaseClient,
  userId: string,
  fields: { plan?: Plan | null; subscriptionStatus: string; stripeCustomerId?: string | undefined },
) {
  const { data: existing, error: readError } = await admin.auth.admin.getUserById(userId);
  if (readError || !existing?.user) {
    console.error("Stripe webhook: could not read user before writing subscription state:", userId, readError);
    return;
  }

  const { error } = await admin.auth.admin.updateUserById(userId, {
    user_metadata: {
      ...existing.user.user_metadata,
      ...(fields.plan !== undefined ? { plan: fields.plan } : {}),
      subscriptionStatus: fields.subscriptionStatus,
      ...(fields.stripeCustomerId ? { stripeCustomerId: fields.stripeCustomerId } : {}),
    },
  });
  if (error) {
    console.error("Stripe webhook: failed to write subscription state for user:", userId, error);
  }
}

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

        const admin = getAdminClient();
        if (!admin) {
          console.error(`Stripe webhook (${event.type}) received but Supabase admin client isn't configured.`);
          return new Response(JSON.stringify({ received: true }), { status: 200 });
        }

        // Every handler below only ever logs and returns — a bug in our own
        // processing must never surface as a non-200 to Stripe, or Stripe
        // will keep retrying the same event indefinitely against a webhook
        // that can never succeed. Signature verification above is the only
        // thing allowed to reject a delivery.
        try {
          if (event.type === "checkout.session.completed") {
            const session = event.data.object as Stripe.Checkout.Session;
            const userId = session.client_reference_id || session.metadata?.["userId"];
            const plan = session.metadata?.["plan"] as Plan | undefined;

            if (!userId) {
              console.error("Checkout completed but no userId on the session — can't attach a plan.");
              return new Response(JSON.stringify({ received: true }), { status: 200 });
            }

            // Checkout completing doesn't always mean the subscription is
            // immediately active (e.g. a card requiring 3D Secure can leave
            // it "incomplete") — read the real subscription status instead
            // of assuming "active".
            let status = "active";
            if (typeof session.subscription === "string") {
              const subscription = await stripe.subscriptions.retrieve(session.subscription);
              status = subscription.status;
            }

            await writeSubscriptionState(admin, userId, {
              plan: plan ?? null,
              subscriptionStatus: status,
              stripeCustomerId: typeof session.customer === "string" ? session.customer : undefined,
            });
          } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
            // Covers renewals settling back to "active", a failed renewal
            // moving to "past_due"/"unpaid", a plan change (Solo <-> Crew,
            // via changeMyPlan), and a cancellation scheduled for period end
            // (status stays "active" until it actually ends — see .deleted).
            const subscription = event.data.object as Stripe.Subscription;
            const userId = await resolveUserId(stripe, subscription.customer, subscription.metadata?.["userId"]);
            if (!userId) {
              console.error(`Stripe webhook (${event.type}): could not resolve a userId for subscription`, subscription.id);
              return new Response(JSON.stringify({ received: true }), { status: 200 });
            }

            await writeSubscriptionState(admin, userId, {
              plan: resolvePlan(subscription),
              subscriptionStatus: subscription.status,
            });
          } else if (event.type === "customer.subscription.deleted") {
            // The subscription has actually ended (immediate cancellation,
            // or the end of a period that was set to cancel). Plan is left
            // as the last known value — only subscriptionStatus gates
            // entitlements (see entitlements-server.ts), so this alone is
            // enough to revoke access.
            const subscription = event.data.object as Stripe.Subscription;
            const userId = await resolveUserId(stripe, subscription.customer, subscription.metadata?.["userId"]);
            if (!userId) {
              console.error("Stripe webhook (subscription.deleted): could not resolve a userId for subscription", subscription.id);
              return new Response(JSON.stringify({ received: true }), { status: 200 });
            }

            await writeSubscriptionState(admin, userId, { subscriptionStatus: "canceled" });
          } else if (event.type === "invoice.payment_failed") {
            // Fires immediately on a failed renewal charge, ahead of (and
            // redundantly with) the subscription.updated that follows —
            // handled here too so access is revoked as soon as possible
            // rather than waiting on a second event to arrive.
            const invoice = event.data.object as Stripe.Invoice;
            const userId = await resolveUserId(stripe, invoice.customer);
            if (!userId) {
              console.error("Stripe webhook (invoice.payment_failed): could not resolve a userId for invoice", invoice.id);
              return new Response(JSON.stringify({ received: true }), { status: 200 });
            }

            await writeSubscriptionState(admin, userId, { subscriptionStatus: "past_due" });
          }
        } catch (err) {
          console.error(`Stripe webhook (${event.type}) processing failed:`, err);
        }

        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
