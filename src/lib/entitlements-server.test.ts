import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isActiveSubscriptionMeta,
  getMyPlan,
  hasActiveSubscriptionForOwner,
} from "./entitlements-server";

// 2026-10 security audit, revised across multiple passes:
//
// Part 1 (HIGH finding): subscription state used to be read from
// `user_metadata`, which Supabase's Auth API lets any signed-in user
// rewrite on themselves via `supabase.auth.updateUser()`.
// Fifth pass (this revision): moved off `app_metadata` too, onto the
// authoritative `subscription_state` table (0023_subscription_state.sql),
// closing a separate write-boundary race found reviewing the app_metadata
// design (see api.stripe.webhook.tsx). These tests prove both facts
// directly: a fake client whose `subscription_state` row is missing,
// ambiguous, or absent entirely must grant nothing — only a real row with
// `subscription_status = 'active'` and a real plan does.

describe("isActiveSubscriptionMeta", () => {
  it("is active only for subscriptionStatus === 'active' with a real plan", () => {
    expect(isActiveSubscriptionMeta({ plan: "solo", subscriptionStatus: "active" })).toBe(true);
    expect(isActiveSubscriptionMeta({ plan: "crew", subscriptionStatus: "active" })).toBe(true);
  });

  it("rejects every non-'active' Stripe status", () => {
    const statuses = [
      "trialing",
      "past_due",
      "canceled",
      "unpaid",
      "incomplete",
      "incomplete_expired",
      "paused",
    ];
    for (const subscriptionStatus of statuses) {
      expect(isActiveSubscriptionMeta({ plan: "crew", subscriptionStatus })).toBe(false);
    }
  });

  it("rejects a missing or invalid plan even if status is 'active'", () => {
    expect(isActiveSubscriptionMeta({ subscriptionStatus: "active" })).toBe(false);
    expect(isActiveSubscriptionMeta({ plan: "enterprise", subscriptionStatus: "active" })).toBe(
      false,
    );
    expect(isActiveSubscriptionMeta({ plan: "", subscriptionStatus: "active" })).toBe(false);
  });

  it("rejects an empty object (never-subscribed user)", () => {
    expect(isActiveSubscriptionMeta({})).toBe(false);
  });
});

type FakeRow = { plan: string | null; subscription_status: string | null } | null;

// Minimal fakes — only the exact call shapes getMyPlan/hasActiveSubscriptionForOwner
// use (a single-row `subscription_state` select), matching this codebase's
// existing test style of exercising real exported logic rather than
// mocking a full SupabaseClient.
function fakeUserClient(row: FakeRow): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        maybeSingle: async () => ({ data: row, error: null }),
      }),
    }),
  } as unknown as SupabaseClient;
}

function fakeAdminClient(row: FakeRow): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("getMyPlan — reads only the authoritative table", () => {
  it("grants nothing when there is no subscription_state row at all (never subscribed)", async () => {
    expect(await getMyPlan(fakeUserClient(null))).toBeNull();
  });

  it("grants the plan when the row says active", async () => {
    expect(await getMyPlan(fakeUserClient({ plan: "crew", subscription_status: "active" }))).toBe(
      "crew",
    );
  });

  it("revokes access once the row reflects a canceled subscription", async () => {
    expect(
      await getMyPlan(fakeUserClient({ plan: "crew", subscription_status: "canceled" })),
    ).toBeNull();
  });

  it("fails closed on an ambiguous row (status active but plan null — should never happen, but must not grant)", async () => {
    expect(
      await getMyPlan(fakeUserClient({ plan: null, subscription_status: "active" })),
    ).toBeNull();
  });

  it("fails closed when the query itself errors (can't confirm entitlement => no entitlement)", async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          maybeSingle: async () => ({ data: null, error: { message: "simulated query failure" } }),
        }),
      }),
    } as unknown as SupabaseClient;
    expect(await getMyPlan(supabase)).toBeNull();
  });
});

describe("hasActiveSubscriptionForOwner — reads only the authoritative table", () => {
  it("grants nothing when there is no row for this owner", async () => {
    expect(await hasActiveSubscriptionForOwner(fakeAdminClient(null), "owner-id")).toBe(false);
  });

  it("grants access when the row reflects a real active subscription", async () => {
    expect(
      await hasActiveSubscriptionForOwner(
        fakeAdminClient({ plan: "solo", subscription_status: "active" }),
        "owner-id",
      ),
    ).toBe(true);
  });

  it("fails closed on a canceled subscription", async () => {
    expect(
      await hasActiveSubscriptionForOwner(
        fakeAdminClient({ plan: "solo", subscription_status: "canceled" }),
        "owner-id",
      ),
    ).toBe(false);
  });
});
