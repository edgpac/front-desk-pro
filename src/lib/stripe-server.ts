import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Prices defined inline at session-creation time (no pre-created Stripe
// Product/Price IDs needed in the dashboard) — mirrors pricing.tsx exactly.
// Exported so api.stripe.webhook.tsx can map a subscription's unit_amount
// back to a plan id for lifecycle events (renewals, plan changes) that
// don't otherwise carry a plan the way a fresh checkout's metadata does.
export const PLAN_PRICE_CENTS: Record<"solo" | "crew", number> = {
  solo: 1999,
  crew: 3999,
};

const PLAN_LABEL: Record<"solo" | "crew", string> = {
  solo: "Job It Ready Solo",
  crew: "Job It Ready Crew",
};

// Reverse of PLAN_PRICE_CENTS — lifecycle events (renewals, plan changes,
// cancellations) carry a Subscription object with a real unit_amount, but
// no guarantee of a fresh, accurate `plan` metadata field the way a brand
// new checkout does. Matching on price is the source of truth; metadata is
// only a fallback. Exported so api.stripe.webhook.tsx and the one-time
// reconciliation script (scripts/reconcile-subscription-metadata.ts) share
// exactly one definition of "how do we compute a plan from a real Stripe
// subscription" rather than risking the two drifting apart.
const PRICE_CENTS_TO_PLAN = Object.fromEntries(
  Object.entries(PLAN_PRICE_CENTS).map(([plan, cents]) => [cents, plan as "solo" | "crew"]),
) as Record<number, "solo" | "crew">;

export function resolvePlanFromSubscription(
  subscription: Stripe.Subscription,
): "solo" | "crew" | null {
  const price = subscription.items.data[0]?.price;
  // createCheckoutSession always creates sessions in "usd" — this check
  // exists so a same-numbered amount in a different currency (e.g. a
  // subscription created directly in the Stripe dashboard, or a future
  // multi-currency path) can never be silently misread as a real plan by
  // coincidence of cents alone. Nothing in this app currently creates a
  // non-USD subscription, but unit_amount is a bare integer with no
  // currency dimension of its own, so this guard costs nothing and removes
  // a latent (if currently unreachable) ambiguity.
  const matchedPlan =
    price?.currency === "usd" && price.unit_amount != null
      ? PRICE_CENTS_TO_PLAN[price.unit_amount]
      : undefined;
  if (matchedPlan) return matchedPlan;
  const metaPlan = subscription.metadata?.["plan"];
  return metaPlan === "solo" || metaPlan === "crew" ? metaPlan : null;
}

function getStripe(): Stripe {
  const key = process.env["STRIPE_SECRET_KEY"];
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set on the server. Add it to .env.");
  }
  return new Stripe(key);
}

export type CheckoutInput = { plan: "solo" | "crew" };

// Extracted from createCheckoutSession's handler so it's testable with a
// fake supabase/stripe client — this codebase has no infrastructure for
// invoking a createServerFn-wrapped handler directly outside a real
// TanStack Start request (confirmed by inspection before choosing this
// approach, not assumed), so the handler below is now a thin shim over
// this plain function.
export async function performCreateCheckoutSession(
  supabase: SupabaseClient,
  userId: string,
  stripe: Stripe,
  siteUrl: string,
  data: CheckoutInput,
): Promise<{ url: string }> {
  // The authenticated user's email comes straight from the verified
  // Supabase session on the server — the browser never has to ask for it
  // again, and it can't be spoofed the way a plain form field could.
  const { data: userData, error } = await supabase.auth.getUser();
  if (error || !userData?.user?.email) {
    throw new Error("Couldn't read your account email — try logging in again.");
  }

  // Reuse the same Stripe Customer across a user's whole lifetime (created
  // once, first time they ever check out) instead of letting each Checkout
  // Session implicitly create a new one from customer_email — otherwise a
  // second signup (e.g. resubscribing after a cancellation) would silently
  // fork into a second, disconnected Stripe customer. Every customer we
  // create carries metadata.userId, which is how the webhook resolves
  // lifecycle events (renewals, cancellations, failed payments — anything
  // that isn't the checkout flow itself) back to this Supabase user.
  // Read from subscription_state (the authoritative table, RLS-scoped to
  // the caller's own row), not app_metadata — see entitlements-server.ts's
  // note. A client-forged stripeCustomerId used to let an attacker point
  // this (and getMyBillingInfo/createBillingPortalSession below) at an
  // arbitrary real Stripe customer; only server code holding the
  // service-role key can ever write this table.
  const { data: stateRow } = await supabase
    .from("subscription_state")
    .select("stripe_customer_id")
    .maybeSingle();
  let customerId = stateRow?.stripe_customer_id ?? undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: userData.user.email,
      metadata: { userId },
    });
    customerId = customer.id;
  }

  // Hard server-side guard, checked against Stripe itself rather than
  // trusting anything the client believes about its own plan state — a
  // stale page, a double-click, or navigating back mid-transition could
  // otherwise still reach this function while a subscription already
  // exists, creating a second one instead of changing the first. Plan
  // changes belong in the Stripe portal ("Change plan" on the billing
  // page); this function is only for a genuinely new subscriber.
  const existingSubscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 10,
  });
  const hasLiveSubscription = existingSubscriptions.data.some(
    (sub) => sub.status !== "canceled" && sub.status !== "incomplete_expired",
  );
  if (hasLiveSubscription) {
    throw new Error(
      'You already have a subscription — use "Change plan" instead of starting a new one.',
    );
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: userId,
    line_items: [
      {
        price_data: {
          currency: "usd",
          recurring: { interval: "month" },
          product_data: { name: PLAN_LABEL[data.plan] },
          unit_amount: PLAN_PRICE_CENTS[data.plan],
        },
        quantity: 1,
      },
    ],
    metadata: { userId, plan: data.plan },
    // Stamped onto the Subscription object itself too (not just the
    // Checkout Session, which the webhook never sees again) — this is
    // what lets customer.subscription.updated/.deleted resolve straight
    // to a userId without an extra Stripe API round-trip on every event.
    subscription_data: { metadata: { userId, plan: data.plan } },
    success_url: `${siteUrl}/dashboard/settings/billing?checkout=success`,
    cancel_url: `${siteUrl}/dashboard/settings/billing`,
  });

  if (!session.url) throw new Error("Stripe didn't return a checkout URL.");
  return { url: session.url };
}

export const createCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: CheckoutInput) => input)
  .handler(async ({ data, context }) => {
    const siteUrl = process.env["SITE_URL"] || "http://localhost:8080";
    return performCreateCheckoutSession(
      context.supabase,
      context.userId,
      getStripe(),
      siteUrl,
      data,
    );
  });

export type BillingInfo = {
  plan: "solo" | "crew" | null;
  subscriptionStatus: string | null;
  paymentMethod: { brand: string; last4: string } | null;
  invoices: Array<{
    id: string;
    date: string;
    amount: string;
    plan: string;
    hostedUrl: string | null;
  }>;
};

// write_authoritative_subscription_state writes {plan, subscription_status,
// stripe_customer_id} into subscription_state on checkout.session.completed
// and every other subscription lifecycle event — this is the read side of
// that, via the caller's own RLS-scoped client (not app_metadata — see
// entitlements-server.ts's note). Extracted to a plain function for the
// same testability reason as performCreateCheckoutSession above.
export async function performGetMyBillingInfo(
  supabase: SupabaseClient,
  stripe: Stripe,
): Promise<BillingInfo> {
  const { data: stateRow, error } = await supabase
    .from("subscription_state")
    .select("plan, subscription_status, stripe_customer_id")
    .maybeSingle();
  if (error) {
    throw new Error("Couldn't read your account — try logging in again.");
  }

  const plan = (stateRow?.plan as "solo" | "crew" | null | undefined) ?? null;
  const subscriptionStatus = stateRow?.subscription_status ?? null;
  const stripeCustomerId = stateRow?.stripe_customer_id ?? undefined;

  if (!stripeCustomerId) {
    return { plan, subscriptionStatus, paymentMethod: null, invoices: [] };
  }

  const [paymentMethods, invoices] = await Promise.all([
    stripe.paymentMethods.list({ customer: stripeCustomerId, type: "card", limit: 1 }),
    stripe.invoices.list({ customer: stripeCustomerId, limit: 10 }),
  ]);

  const card = paymentMethods.data[0]?.card;

  return {
    plan,
    subscriptionStatus,
    paymentMethod: card ? { brand: card.brand, last4: card.last4 } : null,
    invoices: invoices.data.map((inv) => ({
      id: inv.number || inv.id || "",
      date: inv.created
        ? new Date(inv.created * 1000).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : "",
      amount: `$${(inv.total / 100).toFixed(2)}`,
      plan: inv.lines.data[0]?.description || (plan ? PLAN_LABEL[plan] : ""),
      hostedUrl: inv.hosted_invoice_url ?? null,
    })),
  };
}

export const getMyBillingInfo = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BillingInfo> => {
    return performGetMyBillingInfo(context.supabase, getStripe());
  });

// Real "manage billing" — replaces a fake "isn't wired up yet" toast, and is
// what actually makes good on the signup page's "cancel from the billing
// page" promise: Stripe's own hosted Customer Portal handles cancellation,
// card updates, and invoice history without Job It Ready needing to build any
// of that UI itself.
// Extracted for the same testability reason as the two functions above.
export async function performCreateBillingPortalSession(
  supabase: SupabaseClient,
  stripe: Stripe,
  siteUrl: string,
): Promise<{ url: string }> {
  // subscription_state, not app_metadata — see entitlements-server.ts's note.
  const { data: stateRow, error } = await supabase
    .from("subscription_state")
    .select("stripe_customer_id")
    .maybeSingle();
  const stripeCustomerId = stateRow?.stripe_customer_id ?? undefined;
  if (error || !stripeCustomerId) {
    throw new Error("No billing account on file yet — pick a plan first.");
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${siteUrl}/dashboard/settings/billing`,
    });
    return { url: session.url };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    throw new Error(
      message.includes("configuration")
        ? "The Stripe customer portal hasn't been configured yet — set up a default configuration in the Stripe dashboard first."
        : "Couldn't open the billing portal — try again.",
    );
  }
}

export const createBillingPortalSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const siteUrl = process.env["SITE_URL"] || "http://localhost:8080";
    return performCreateBillingPortalSession(context.supabase, getStripe(), siteUrl);
  });
