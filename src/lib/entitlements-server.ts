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

export type SubscriptionMeta = { plan?: string; subscriptionStatus?: string; stripeCustomerId?: string };

// 2026-10 security audit, revised twice since the original fix:
//
// Part 1 (HIGH finding): subscription state used to be read from
// `user_metadata`, which Supabase's own Auth API lets any signed-in user
// freely rewrite on themselves (`supabase.auth.updateUser({ data: {...}
// })`) — a documented, intentional GoTrue capability, not a bug in this
// app, but one that makes `user_metadata` unusable for anything
// authorization-sensitive.
//
// Fifth pass (this revision): moved off `app_metadata` too, onto the
// `subscription_state` table (0023_subscription_state.sql). `app_metadata`
// was the correct fix for the client-write problem (only service-role code
// can write it), but writing it went through Supabase's GoTrue Admin
// HTTP API, which has no conditional/atomic write primitive — a separate
// review found a real race where a worker that had lost ownership of its
// processing claim could still complete a stale write afterward (see that
// migration's comment for the full mechanism). `subscription_state` is
// written only by `write_authoritative_subscription_state`, a Postgres
// function that performs the ownership check and the write together, under
// a row lock, in one call — not two sequential steps a concurrent worker
// could land between. `app_metadata` is kept only as a best-effort,
// explicitly non-authoritative mirror (for visibility in the Supabase Auth
// dashboard) — nothing in this file, or anywhere else, reads it for an
// entitlement decision anymore.
//
// The one authoritative definition of "does this JIR account have an active
// subscription." subscriptionStatus must be exactly "active"; anything else
// (or missing entirely — canceled, past_due, unpaid, incomplete, paused,
// never subscribed) has none. Every check in this file, and anything gating
// the public quote/widget intake by subscription state, goes through this —
// never a second, separately-maintained copy of the rule.
export function isActiveSubscriptionMeta(meta: SubscriptionMeta): meta is { plan: PlanId; subscriptionStatus: "active" } {
  if (meta.subscriptionStatus !== "active") return false;
  return meta.plan === "solo" || meta.plan === "crew";
}

type SubscriptionStateRow = { plan: string | null; subscription_status: string | null };

function metaFromRow(row: SubscriptionStateRow | null): SubscriptionMeta {
  // Missing or ambiguous state fails closed: a null row, a null plan, or
  // any subscriptionStatus other than exactly "active" all produce a
  // SubscriptionMeta that isActiveSubscriptionMeta rejects — there is no
  // path here that infers or assumes access from an incomplete record.
  if (!row) return {};
  return {
    ...(row.plan != null ? { plan: row.plan } : {}),
    ...(row.subscription_status != null ? { subscriptionStatus: row.subscription_status } : {}),
  };
}

// Reads the authenticated user's real, current plan straight from the
// authoritative subscription_state table — via the caller's own RLS-scoped
// client (the table's one SELECT policy is `auth.uid() = user_id`, so this
// query is automatically scoped to the caller's own row; no separate
// auth.getUser() call is needed just to establish identity). Never trusts
// anything a client claims about its own plan, and never reads
// user_metadata or app_metadata for this (see note above).
export async function getMyPlan(supabase: SupabaseClient): Promise<PlanId | null> {
  const { data, error } = await supabase.from("subscription_state").select("plan, subscription_status").maybeSingle();
  if (error) return null;
  const meta = metaFromRow(data as SubscriptionStateRow | null);
  return isActiveSubscriptionMeta(meta) ? meta.plan : null;
}

// Admin-side equivalent of getMyPlan's check, for a business owner who isn't
// the caller — the public quote/widget intake is anonymous, so there's no
// session to read the tenant owner's plan from the normal way. Takes an
// already-created admin (service-role) client rather than creating its own,
// so callers that already have one (public-lead-server.ts's getAdminClient)
// don't need a second Supabase client per request. service_role bypasses
// RLS, so this reads any user's row directly by id.
export async function hasActiveSubscriptionForOwner(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("subscription_state")
    .select("plan, subscription_status")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return isActiveSubscriptionMeta(metaFromRow(data as SubscriptionStateRow | null));
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
