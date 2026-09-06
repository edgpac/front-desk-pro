import { createServerFn } from "@tanstack/react-start";
import Stripe from "stripe";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Prices defined inline at session-creation time (no pre-created Stripe
// Product/Price IDs needed in the dashboard) — mirrors pricing.tsx exactly.
const PLAN_PRICE_CENTS: Record<"solo" | "crew", number> = {
  solo: 800,
  crew: 1900,
};

const PLAN_LABEL: Record<"solo" | "crew", string> = {
  solo: "FrontDesk Solo",
  crew: "FrontDesk Crew",
};

function getStripe(): Stripe {
  const key = process.env["STRIPE_SECRET_KEY"];
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set on the server. Add it to .env.");
  }
  return new Stripe(key);
}

export type CheckoutInput = { plan: "solo" | "crew" };

export const createCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: CheckoutInput) => input)
  .handler(async ({ data, context }) => {
    const stripe = getStripe();

    // The authenticated user's email comes straight from the verified
    // Supabase session on the server — the browser never has to ask for it
    // again, and it can't be spoofed the way a plain form field could.
    const { data: userData, error } = await context.supabase.auth.getUser();
    if (error || !userData?.user?.email) {
      throw new Error("Couldn't read your account email — try logging in again.");
    }

    const siteUrl = process.env["SITE_URL"] || "http://localhost:8080";

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: userData.user.email,
      client_reference_id: context.userId,
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
      metadata: { userId: context.userId, plan: data.plan },
      success_url: `${siteUrl}/dashboard/settings/billing?checkout=success`,
      cancel_url: `${siteUrl}/dashboard/settings/billing`,
    });

    if (!session.url) throw new Error("Stripe didn't return a checkout URL.");
    return { url: session.url };
  });

export type BillingInfo = {
  plan: "solo" | "crew" | null;
  subscriptionStatus: string | null;
  paymentMethod: { brand: string; last4: string } | null;
  invoices: Array<{ id: string; date: string; amount: string; plan: string; hostedUrl: string | null }>;
};

// api.stripe.webhook.tsx writes {plan, subscriptionStatus, stripeCustomerId}
// onto the Supabase auth user's own metadata on checkout.session.completed —
// this is the read side of that, which nothing called until now (billing
// settings just showed hardcoded mock invoices regardless of whether anyone
// had actually subscribed).
export const getMyBillingInfo = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BillingInfo> => {
    const { data: userData, error } = await context.supabase.auth.getUser();
    if (error || !userData?.user) {
      throw new Error("Couldn't read your account — try logging in again.");
    }

    const metadata = userData.user.user_metadata ?? {};
    const plan = (metadata["plan"] as "solo" | "crew" | undefined) ?? null;
    const subscriptionStatus = (metadata["subscriptionStatus"] as string | undefined) ?? null;
    const stripeCustomerId = metadata["stripeCustomerId"] as string | undefined;

    if (!stripeCustomerId) {
      return { plan, subscriptionStatus, paymentMethod: null, invoices: [] };
    }

    const stripe = getStripe();
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
  });

// Real "manage billing" — replaces a fake "isn't wired up yet" toast, and is
// what actually makes good on the signup page's "cancel from the billing
// page" promise: Stripe's own hosted Customer Portal handles cancellation,
// card updates, and invoice history without FrontDesk needing to build any
// of that UI itself.
export const createBillingPortalSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: userData, error } = await context.supabase.auth.getUser();
    const stripeCustomerId = userData?.user?.user_metadata?.["stripeCustomerId"] as string | undefined;
    if (error || !stripeCustomerId) {
      throw new Error("No billing account on file yet — pick a plan first.");
    }

    const stripe = getStripe();
    const siteUrl = process.env["SITE_URL"] || "http://localhost:8080";

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
  });
