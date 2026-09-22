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

type SubscriptionMeta = { plan?: string; subscriptionStatus?: string };

// The one authoritative definition of "does this JIR account have an active
// subscription" — written by api.stripe.webhook.tsx on checkout, renewals,
// cancellations, failed payments, and plan changes. subscriptionStatus must
// be exactly "active"; anything else (or missing entirely — canceled,
// past_due, unpaid, never subscribed) has none. Every check in this file,
// and anything gating the public quote/widget intake by subscription state,
// goes through this — never a second, separately-maintained copy of the rule.
function isActiveSubscriptionMeta(meta: SubscriptionMeta): meta is { plan: PlanId; subscriptionStatus: "active" } {
  if (meta.subscriptionStatus !== "active") return false;
  return meta.plan === "solo" || meta.plan === "crew";
}

// Reads the authenticated user's real, current plan straight from their own
// Supabase auth metadata — never trusts anything a client claims about its
// own plan.
export async function getMyPlan(supabase: SupabaseClient): Promise<PlanId | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const meta = data.user.user_metadata as SubscriptionMeta;
  return isActiveSubscriptionMeta(meta) ? meta.plan : null;
}

// Admin-side equivalent of getMyPlan's check, for a business owner who isn't
// the caller — the public quote/widget intake is anonymous, so there's no
// session to read the tenant owner's plan from the normal way. Takes an
// already-created admin (service-role) client rather than creating its own,
// so callers that already have one (public-lead-server.ts's getAdminClient)
// don't need a second Supabase client per request.
export async function hasActiveSubscriptionForOwner(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data?.user) return false;
  return isActiveSubscriptionMeta(data.user.user_metadata as SubscriptionMeta);
}

// Convenience wrapper for callers that only have a tenant slug and haven't
// already fetched the tenant row (getQuoteEstimate/getFollowUpAnswer take no
// tenant data at all otherwise — see estimate-server.ts). Deliberately
// throws the exact same message whether the slug doesn't exist or the
// subscription just isn't active — the public response must never let a
// visitor distinguish "wrong link" from "this business canceled."
export async function requireActiveSubscriptionForSlug(admin: SupabaseClient, slug: string): Promise<void> {
  const { data: tenant, error } = await admin.from("tenants").select("user_id").eq("slug", slug).single();
  const active = !error && tenant ? await hasActiveSubscriptionForOwner(admin, tenant["user_id"] as string) : false;
  if (!active) {
    throw new Error("This business's estimate service is currently unavailable.");
  }
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
