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
