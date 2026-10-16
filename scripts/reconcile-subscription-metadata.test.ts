// Targeted tests for the reconciliation script's pure decision logic
// (pickAuthoritativeSubscription, computeStateForCustomers) — added during
// the 2026-10 fifth-pass review, which found this logic had never had
// direct test coverage despite having gone through several rounds of
// reasoning-only review. No real Stripe or Supabase calls anywhere in this
// file; computeStateForCustomers takes its Stripe client as a parameter
// specifically so a fake one can be substituted here.
//
// The module under test validates SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/
// STRIPE_SECRET_KEY at import time (process.exit(1) if missing, matching
// every other script in this repo) — set to harmless placeholder values
// before a dynamic import (a static import's module evaluation is hoisted
// above any other top-level code by ESM, including these env assignments,
// so a plain top-level `import` would run the module's env check before
// these lines ever executed). Nothing in these tests ever uses the
// module's own `admin`/`stripe` singletons; every test passes its own
// fake Stripe client directly to computeStateForCustomers.
process.env["SUPABASE_URL"] ??= "https://example-test.supabase.co";
process.env["SUPABASE_SERVICE_ROLE_KEY"] ??= "test-placeholder-service-role-key";
process.env["STRIPE_SECRET_KEY"] ??= "sk_test_placeholder";

// @supabase/supabase-js's realtime sub-client requires a WebSocket global
// to exist just to be CONSTRUCTED (not used) on Node versions without a
// native one (Node 20 and below here) — createClient() builds this
// sub-client eagerly even though nothing in these tests ever opens a
// realtime connection. A minimal stub satisfies the constructor check
// only; it is never actually invoked.
(globalThis as { WebSocket?: unknown }).WebSocket ??= class {} as unknown as typeof WebSocket;

import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
const { pickAuthoritativeSubscription, computeStateForCustomers } =
  await import("./reconcile-subscription-metadata");

function fakeSub(overrides: {
  id: string;
  status: Stripe.Subscription.Status;
  created: number;
  unitAmount?: number;
}): Stripe.Subscription {
  return {
    id: overrides.id,
    status: overrides.status,
    created: overrides.created,
    items: { data: [{ price: { unit_amount: overrides.unitAmount ?? 1999, currency: "usd" } }] },
    metadata: {},
  } as unknown as Stripe.Subscription;
}

function fakeCustomer(id: string): Stripe.Customer {
  return { id } as Stripe.Customer;
}

function fakeStripeClient(subsByCustomer: Record<string, Stripe.Subscription[]>): Stripe {
  return {
    subscriptions: {
      list: async ({ customer }: { customer: string }) => ({
        data: subsByCustomer[customer] ?? [],
      }),
    },
  } as unknown as Stripe;
}

describe("pickAuthoritativeSubscription", () => {
  it("returns null for an empty list", () => {
    expect(pickAuthoritativeSubscription([])).toBeNull();
  });

  it("picks the single active subscription over canceled ones", () => {
    const active = fakeSub({ id: "sub_active", status: "active", created: 200 });
    const canceled = fakeSub({ id: "sub_old", status: "canceled", created: 100 });
    expect(pickAuthoritativeSubscription([canceled, active])).toBe(active);
  });

  it("treats trialing as live, same as active", () => {
    const trialing = fakeSub({ id: "sub_trial", status: "trialing", created: 100 });
    expect(pickAuthoritativeSubscription([trialing])).toBe(trialing);
  });

  it("returns null (genuinely ambiguous) when more than one subscription is active/trialing", () => {
    const a = fakeSub({ id: "sub_a", status: "active", created: 100 });
    const b = fakeSub({ id: "sub_b", status: "trialing", created: 200 });
    expect(pickAuthoritativeSubscription([a, b])).toBeNull();
  });

  it("with no active/trialing subscription, picks the most recently created one", () => {
    const older = fakeSub({ id: "sub_older", status: "canceled", created: 100 });
    const newer = fakeSub({ id: "sub_newer", status: "past_due", created: 300 });
    const middle = fakeSub({ id: "sub_middle", status: "unpaid", created: 200 });
    expect(pickAuthoritativeSubscription([older, newer, middle])).toBe(newer);
  });
});

describe("computeStateForCustomers", () => {
  it("reconciles a single customer with one active subscription", async () => {
    const customer = fakeCustomer("cus_1");
    const sub = fakeSub({ id: "sub_1", status: "active", created: 100, unitAmount: 1999 });
    const stripeClient = fakeStripeClient({ cus_1: [sub] });

    const outcome = await computeStateForCustomers([customer], stripeClient);
    expect(outcome).toEqual({
      kind: "reconciled",
      state: { plan: "solo", subscriptionStatus: "active", stripeCustomerId: "cus_1" },
    });
  });

  it("treats a customer with zero subscriptions as no_stripe_customer, not an error or ambiguous", async () => {
    const customer = fakeCustomer("cus_1");
    const stripeClient = fakeStripeClient({ cus_1: [] });

    const outcome = await computeStateForCustomers([customer], stripeClient);
    expect(outcome).toEqual({ kind: "no_stripe_customer" });
  });

  it("flags a single customer with multiple subscriptions and no clear active one as ambiguous, never guessed", async () => {
    const customer = fakeCustomer("cus_1");
    const subA = fakeSub({ id: "sub_a", status: "active", created: 100 });
    const subB = fakeSub({ id: "sub_b", status: "trialing", created: 200 });
    const stripeClient = fakeStripeClient({ cus_1: [subA, subB] });

    const outcome = await computeStateForCustomers([customer], stripeClient);
    expect(outcome.kind).toBe("ambiguous");
  });

  it("resolves multiple Stripe customers for one userId when exactly one has a live subscription", async () => {
    const customerAbandoned = fakeCustomer("cus_abandoned"); // e.g. a checkout started but never completed
    const customerReal = fakeCustomer("cus_real");
    const sub = fakeSub({ id: "sub_1", status: "active", created: 100, unitAmount: 3999 });
    const stripeClient = fakeStripeClient({ cus_abandoned: [], cus_real: [sub] });

    const outcome = await computeStateForCustomers([customerAbandoned, customerReal], stripeClient);
    expect(outcome).toEqual({
      kind: "reconciled",
      state: { plan: "crew", subscriptionStatus: "active", stripeCustomerId: "cus_real" },
    });
  });

  it("flags multiple Stripe customers for one userId as ambiguous when more than one has a live subscription — never guesses which is authoritative", async () => {
    const customerA = fakeCustomer("cus_a");
    const customerB = fakeCustomer("cus_b");
    const subA = fakeSub({ id: "sub_a", status: "active", created: 100 });
    const subB = fakeSub({ id: "sub_b", status: "active", created: 200 });
    const stripeClient = fakeStripeClient({ cus_a: [subA], cus_b: [subB] });

    const outcome = await computeStateForCustomers([customerA, customerB], stripeClient);
    expect(outcome.kind).toBe("ambiguous");
  });

  it("treats multiple Stripe customers where NEITHER ever subscribed as no_stripe_customer (free user), not ambiguous", async () => {
    const customerA = fakeCustomer("cus_a");
    const customerB = fakeCustomer("cus_b");
    const stripeClient = fakeStripeClient({ cus_a: [], cus_b: [] });

    const outcome = await computeStateForCustomers([customerA, customerB], stripeClient);
    expect(outcome).toEqual({ kind: "no_stripe_customer" });
  });

  it("a Stripe retrieval failure propagates as a thrown error, never silently read as no_stripe_customer or a cancellation", async () => {
    const customer = fakeCustomer("cus_1");
    const stripeClient = {
      subscriptions: {
        list: async () => {
          throw new Error("simulated Stripe API outage");
        },
      },
    } as unknown as Stripe;

    await expect(computeStateForCustomers([customer], stripeClient)).rejects.toThrow(
      "simulated Stripe API outage",
    );
  });
});
