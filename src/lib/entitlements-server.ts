import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Single source of truth for what each plan actually unlocks. Add new
// features here as they're built — never scatter `plan === "crew"` checks
// across routes/components; everything asks hasFeature()/myPlanHasFeature()
// instead. This is what keeps entitlements sane once there are more plans,
// usage limits, or seats than just two flags.
export type PlanId = "solo" | "crew";
export type Feature = "csvExport";

const PLAN_FEATURES: Record<PlanId, Record<Feature, boolean>> = {
  solo: { csvExport: false },
  crew: { csvExport: true },
};

// Reads the authenticated user's real, current plan straight from their own
// Supabase auth metadata (written by api.stripe.webhook.tsx on checkout,
// renewals, cancellations, failed payments, and plan changes) — never
// trusts anything a client claims about its own plan. subscriptionStatus
// must be exactly "active"; anything else (or missing entirely) has no
// entitlements.
export async function getMyPlan(supabase: SupabaseClient): Promise<PlanId | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const meta = data.user.user_metadata as { plan?: string; subscriptionStatus?: string };
  if (meta.subscriptionStatus !== "active") return null;
  if (meta.plan !== "solo" && meta.plan !== "crew") return null;
  return meta.plan;
}

// The one function every feature check should actually call — server-side,
// on the real request, never the UI's own idea of what plan it's showing.
export async function myPlanHasFeature(supabase: SupabaseClient, feature: Feature): Promise<boolean> {
  const plan = await getMyPlan(supabase);
  if (!plan) return false;
  return PLAN_FEATURES[plan][feature];
}

// Client-callable wrapper around getMyPlan — for chrome that just needs to
// know "does this user have an active plan, and which one" (e.g. the
// sidebar) without pulling in stripe-server.ts's real Stripe API calls
// (payment method, invoices) the way the full billing page does.
export const getMyPlanSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ plan: PlanId | null }> => {
    return { plan: await getMyPlan(context.supabase) };
  });
