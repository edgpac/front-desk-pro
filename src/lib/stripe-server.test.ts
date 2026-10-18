import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import {
  resolvePlanFromSubscription,
  PLAN_PRICE_CENTS,
  performCreateCheckoutSession,
  performGetMyBillingInfo,
  performCreateBillingPortalSession,
} from "./stripe-server";

function fakeSubscription(overrides: {
  unitAmount?: number | null;
  currency?: string;
  metadataPlan?: string;
}): Stripe.Subscription {
  return {
    items: {
      data: [
        {
          price: {
            unit_amount: overrides.unitAmount ?? null,
            currency: overrides.currency ?? "usd",
          },
        },
      ],
    },
    metadata: overrides.metadataPlan ? { plan: overrides.metadataPlan } : {},
  } as unknown as Stripe.Subscription;
}

describe("resolvePlanFromSubscription", () => {
  it("resolves solo from its real configured price, ignoring metadata", () => {
    const sub = fakeSubscription({ unitAmount: PLAN_PRICE_CENTS.solo, metadataPlan: "crew" });
    // Price is the source of truth — a stale/mismatched metadata.plan never wins.
    expect(resolvePlanFromSubscription(sub)).toBe("solo");
  });

  it("resolves crew from its real configured price", () => {
    const sub = fakeSubscription({ unitAmount: PLAN_PRICE_CENTS.crew });
    expect(resolvePlanFromSubscription(sub)).toBe("crew");
  });

  it("falls back to metadata.plan when the price doesn't match either known plan", () => {
    const sub = fakeSubscription({ unitAmount: 999999, metadataPlan: "crew" });
    expect(resolvePlanFromSubscription(sub)).toBe("crew");
  });

  it("returns null when neither price nor metadata resolves to a known plan", () => {
    const sub = fakeSubscription({ unitAmount: 999999, metadataPlan: "enterprise" });
    expect(resolvePlanFromSubscription(sub)).toBeNull();
  });

  it("does not match a numerically coincident amount in a different currency", () => {
    const sub = fakeSubscription({
      unitAmount: PLAN_PRICE_CENTS.solo,
      currency: "eur",
      metadataPlan: "crew",
    });
    expect(resolvePlanFromSubscription(sub)).toBe("crew");
  });

  it("falls back to metadata when currency is non-USD and metadata is also absent", () => {
    const sub = fakeSubscription({ unitAmount: PLAN_PRICE_CENTS.crew, currency: "eur" });
    expect(resolvePlanFromSubscription(sub)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Task 3: billing functions. These used to read a client-writable
// stripeCustomerId from metadata — the exact IDOR-shaped bug fixed
// earlier this review (an attacker could point getMyBillingInfo/
// createBillingPortalSession at an arbitrary real Stripe customer by
// forging that one field). After the fix, there is no field anywhere in
// these functions' inputs a client could use to specify a customer id at
// all — the id always comes from subscription_state, queried through the
// CALLER's own RLS-scoped client. These tests confirm that structurally:
// the fake "my own row" is always what gets used, with no override path.
// ---------------------------------------------------------------------

type FakeStateRow = {
  stripe_customer_id: string | null;
  plan?: string | null;
  subscription_status?: string | null;
} | null;

function fakeSupabaseForState(
  row: FakeStateRow,
  opts: { queryError?: boolean; getUserEmail?: string | null } = {},
): SupabaseClient {
  return {
    auth: {
      getUser: async () => ({
        data:
          opts.getUserEmail === null
            ? { user: null }
            : { user: { email: opts.getUserEmail ?? "owner@example.com" } },
        error: opts.getUserEmail === null ? { message: "no session" } : null,
      }),
    },
    from: (table: string) => {
      if (table !== "subscription_state") throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({
          maybeSingle: async () =>
            opts.queryError
              ? { data: null, error: { message: "simulated query failure" } }
              : { data: row, error: null },
        }),
      };
    },
  } as unknown as SupabaseClient;
}

describe("performGetMyBillingInfo — reads only the authoritative table, fails safely", () => {
  it("returns empty billing info when there is no subscription_state row (never checked out)", async () => {
    const supabase = fakeSupabaseForState(null);
    const stripe = {} as Stripe; // must never be called — no customer id to look anything up with
    const info = await performGetMyBillingInfo(supabase, stripe);
    expect(info).toEqual({
      plan: null,
      subscriptionStatus: null,
      paymentMethod: null,
      invoices: [],
    });
  });

  it("uses exactly the caller's own stripe_customer_id from subscription_state — no other input could change it", async () => {
    const supabase = fakeSupabaseForState({
      stripe_customer_id: "cus_owner_real",
      plan: "crew",
      subscription_status: "active",
    });
    let calledWithCustomer: string | undefined;
    const stripe = {
      paymentMethods: {
        list: async ({ customer }: { customer: string }) => {
          calledWithCustomer = customer;
          return { data: [] };
        },
      },
      invoices: { list: async () => ({ data: [] }) },
    } as unknown as Stripe;

    const info = await performGetMyBillingInfo(supabase, stripe);

    expect(calledWithCustomer).toBe("cus_owner_real");
    expect(info.plan).toBe("crew");
    expect(info.subscriptionStatus).toBe("active");
  });

  it("fails safely (throws, does not return partial/wrong data) when the state query itself errors", async () => {
    const supabase = fakeSupabaseForState(null, { queryError: true });
    await expect(performGetMyBillingInfo(supabase, {} as Stripe)).rejects.toThrow(
      "Couldn't read your account",
    );
  });

  it("an ambiguous row (status present but no customer id) still returns safely with no Stripe calls", async () => {
    const supabase = fakeSupabaseForState({
      stripe_customer_id: null,
      plan: "crew",
      subscription_status: "active",
    });
    const info = await performGetMyBillingInfo(supabase, {} as Stripe);
    expect(info.paymentMethod).toBeNull();
    expect(info.invoices).toEqual([]);
  });
});

describe("performCreateBillingPortalSession — identity-bound, fails safely", () => {
  it("opens a portal session scoped to exactly the caller's own stripe_customer_id", async () => {
    const supabase = fakeSupabaseForState({ stripe_customer_id: "cus_owner_real" });
    let calledWithCustomer: string | undefined;
    const stripe = {
      billingPortal: {
        sessions: {
          create: async ({ customer }: { customer: string }) => {
            calledWithCustomer = customer;
            return { url: "https://billing.stripe.com/session/xyz" };
          },
        },
      },
    } as unknown as Stripe;

    const result = await performCreateBillingPortalSession(
      supabase,
      stripe,
      "https://app.example.com",
    );

    expect(calledWithCustomer).toBe("cus_owner_real");
    expect(result.url).toBe("https://billing.stripe.com/session/xyz");
  });

  it("fails safely when there is no billing account on file at all — never opens a portal for an empty/missing customer id", async () => {
    const supabase = fakeSupabaseForState(null);
    await expect(
      performCreateBillingPortalSession(supabase, {} as Stripe, "https://app.example.com"),
    ).rejects.toThrow("No billing account on file yet");
  });

  it("fails safely when the state query errors, even if a stale customer id were somehow present", async () => {
    const supabase = fakeSupabaseForState(
      { stripe_customer_id: "cus_should_not_be_used" },
      { queryError: true },
    );
    await expect(
      performCreateBillingPortalSession(supabase, {} as Stripe, "https://app.example.com"),
    ).rejects.toThrow("No billing account on file yet");
  });
});

describe("performCreateCheckoutSession — identity-bound, no client-controlled customer id exists to forge", () => {
  it("creates a brand-new Stripe customer for a first-time subscriber, using the SESSION's own userId/email, never anything client-supplied", async () => {
    const supabase = fakeSupabaseForState(null, { getUserEmail: "real-owner@example.com" });
    let createdWithEmail: string | undefined;
    let createdWithUserId: unknown;
    const stripe = {
      customers: {
        create: async ({ email, metadata }: { email: string; metadata: { userId: string } }) => {
          createdWithEmail = email;
          createdWithUserId = metadata.userId;
          return { id: "cus_newly_created" };
        },
      },
      subscriptions: { list: async () => ({ data: [] }) },
      checkout: {
        sessions: { create: async () => ({ url: "https://checkout.stripe.com/session/abc" }) },
      },
    } as unknown as Stripe;

    const result = await performCreateCheckoutSession(
      supabase,
      "user-session-id",
      stripe,
      "https://app.example.com",
      { plan: "solo" },
    );

    expect(createdWithEmail).toBe("real-owner@example.com");
    expect(createdWithUserId).toBe("user-session-id"); // from the verified session, not any input field
    expect(result.url).toBe("https://checkout.stripe.com/session/abc");
  });

  it("reuses the existing stripe_customer_id from subscription_state rather than creating a duplicate customer", async () => {
    const supabase = fakeSupabaseForState(
      { stripe_customer_id: "cus_owner_existing" },
      { getUserEmail: "real-owner@example.com" },
    );
    let customerCreateCalled = false;
    let checkoutCustomer: string | undefined;
    const stripe = {
      customers: {
        create: async () => {
          customerCreateCalled = true;
          return { id: "cus_should_not_be_created" };
        },
      },
      subscriptions: { list: async () => ({ data: [] }) },
      checkout: {
        sessions: {
          create: async ({ customer }: { customer: string }) => {
            checkoutCustomer = customer;
            return { url: "https://checkout.stripe.com/session/abc" };
          },
        },
      },
    } as unknown as Stripe;

    await performCreateCheckoutSession(
      supabase,
      "user-session-id",
      stripe,
      "https://app.example.com",
      { plan: "crew" },
    );

    expect(customerCreateCalled).toBe(false);
    expect(checkoutCustomer).toBe("cus_owner_existing");
  });

  it("refuses to start a second subscription when a live one already exists for this customer", async () => {
    const supabase = fakeSupabaseForState({ stripe_customer_id: "cus_owner_existing" });
    const stripe = {
      subscriptions: {
        list: async () => ({ data: [{ status: "active" }] }),
      },
    } as unknown as Stripe;

    await expect(
      performCreateCheckoutSession(supabase, "user-session-id", stripe, "https://app.example.com", {
        plan: "crew",
      }),
    ).rejects.toThrow("You already have a subscription");
  });

  it("a canceled-only subscription history does not block starting a new one", async () => {
    const supabase = fakeSupabaseForState({ stripe_customer_id: "cus_owner_existing" });
    const stripe = {
      subscriptions: { list: async () => ({ data: [{ status: "canceled" }] }) },
      checkout: {
        sessions: { create: async () => ({ url: "https://checkout.stripe.com/session/abc" }) },
      },
    } as unknown as Stripe;

    const result = await performCreateCheckoutSession(
      supabase,
      "user-session-id",
      stripe,
      "https://app.example.com",
      { plan: "solo" },
    );
    expect(result.url).toBe("https://checkout.stripe.com/session/abc");
  });

  it("fails safely when the session has no verified email", async () => {
    const supabase = fakeSupabaseForState(null, { getUserEmail: null });
    await expect(
      performCreateCheckoutSession(
        supabase,
        "user-session-id",
        {} as Stripe,
        "https://app.example.com",
        { plan: "solo" },
      ),
    ).rejects.toThrow("Couldn't read your account email");
  });
});
