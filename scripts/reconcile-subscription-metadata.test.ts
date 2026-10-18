// Targeted tests for the reconciliation script — both its pure decision
// logic (pickAuthoritativeSubscription, computeStateForCustomers) and, as
// of this round, its full ORCHESTRATION (runReconciliation): pagination,
// idempotency across repeated runs, partial-failure recovery, ambiguous/
// orphaned handling, and the stale-snapshot-vs-newer-write regression this
// round's fix exists to prevent. No real Stripe or Supabase calls anywhere
// in this file — importing the script module no longer validates env vars
// or constructs real clients at all (that now only happens inside main(),
// which only runs when this file is executed directly via `bun run`, not
// when it's imported — see the script's own `import.meta.main` guard).
//
// IMPORTANT, stated explicitly per review instructions: everything in this
// file is an in-memory simulation against fake Stripe/Supabase clients
// that implement the same conditional logic the real SQL functions do
// (claim/release/write, mirroring the FakeBackend already proven out in
// api.stripe.webhook.test.ts). It does NOT exercise real concurrent
// PostgreSQL transactions or a real Stripe account — that real-engine
// verification lives in scripts/pg-migration-verification.sh, which is a
// separate, real-PostgreSQL check (see that file and its own report for
// what it covers and doesn't).

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import {
  pickAuthoritativeSubscription,
  computeStateForCustomers,
  runReconciliation,
  type ReconciliationDeps,
} from "./reconcile-subscription-metadata";

// ---------------------------------------------------------------------
// Fake Stripe client — supports exactly what buildCustomerIndex/
// computeStateForCustomers use: customers.list (paginated) and
// subscriptions.list (by customer id, re-queryable so a test can change
// what it returns between calls to simulate state changing over time).
// ---------------------------------------------------------------------

function fakeCustomer(id: string, userId: string): Stripe.Customer {
  return { id, metadata: { userId } } as unknown as Stripe.Customer;
}

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

class FakeStripe {
  customers: Stripe.Customer[] = [];
  // customerId -> ordered list of RESPONSES, one per call — lets a test
  // simulate the subscription list changing between the bulk pass and a
  // later re-fetch at write time. The last response is reused for any
  // call beyond the list's length.
  subscriptionResponses = new Map<string, Stripe.Subscription[][]>();
  subscriptionCallCounts = new Map<string, number>();
  customerListPageSize = 100;

  asStripe(): Stripe {
    return {
      customers: {
        list: async ({ limit, starting_after }: { limit?: number; starting_after?: string }) => {
          const pageSize = limit ?? this.customerListPageSize;
          const startIdx = starting_after
            ? this.customers.findIndex((c) => c.id === starting_after) + 1
            : 0;
          const page = this.customers.slice(startIdx, startIdx + pageSize);
          return { data: page, has_more: startIdx + pageSize < this.customers.length };
        },
      },
      subscriptions: {
        list: async ({ customer }: { customer: string }) => {
          const responses = this.subscriptionResponses.get(customer) ?? [[]];
          const callIdx = this.subscriptionCallCounts.get(customer) ?? 0;
          this.subscriptionCallCounts.set(customer, callIdx + 1);
          const data = responses[Math.min(callIdx, responses.length - 1)] ?? [];
          return { data };
        },
      },
    } as unknown as Stripe;
  }
}

// ---------------------------------------------------------------------
// Fake Supabase admin client — covers everything runReconciliation's full
// path touches: auth.admin.listUsers (paginated), the claim/write RPCs
// writeSubscriptionState calls internally (same conditional semantics as
// api.stripe.webhook.test.ts's FakeBackend, reproduced here so this file
// stays self-contained), auth.admin.getUserById/updateUserById (the
// mirror step), and subscription_state's .select().range() (existing-
// state index).
// ---------------------------------------------------------------------

class FakeSupabase {
  users: Array<{ id: string; email: string; app_metadata: Record<string, unknown> }> = [];
  existingState: Array<{
    user_id: string;
    plan: string | null;
    subscription_status: string;
    stripe_customer_id: string | null;
  }> = [];
  claims = new Map<string, { token: string }>();
  subscriptionStateRows = new Map<
    string,
    { plan: string | null; subscription_status: string; stripe_customer_id: string | null }
  >();
  claimAlwaysBusy = false; // simulates a concurrent webhook permanently holding the claim
  listUsersPageSize = 200;
  existingStateRangeSize = 1000;
  userByIdCalls = 0;

  writeAuthoritativeState(
    userId: string,
    claimToken: string,
    plan: string | null,
    status: string,
    customerId: string | null,
  ): boolean {
    const current = this.claims.get(userId);
    if (!current || current.token !== claimToken) return false;
    const existing = this.subscriptionStateRows.get(userId);
    this.subscriptionStateRows.set(userId, {
      plan,
      subscription_status: status,
      stripe_customer_id: customerId ?? existing?.stripe_customer_id ?? null,
    });
    return true;
  }

  // Arrow-function class field, not a method: captures `this` lexically,
  // so the nested closures below can reference it directly without the
  // `const self = this` aliasing a lint rule (correctly) flags.
  asAdmin = (): ReconciliationDeps["admin"] => {
    return {
      rpc: async (name: string, params: Record<string, unknown>) => {
        if (name === "claim_stripe_webhook_slot") {
          if (this.claimAlwaysBusy && this.claims.has(params["p_user_id"] as string))
            return { data: false, error: null };
          this.claims.set(params["p_user_id"] as string, {
            token: params["p_claim_token"] as string,
          });
          return { data: true, error: null };
        }
        if (name === "release_stripe_webhook_slot") {
          const current = this.claims.get(params["p_user_id"] as string);
          if (current && current.token === params["p_claim_token"])
            this.claims.delete(params["p_user_id"] as string);
          return { data: null, error: null };
        }
        if (name === "write_authoritative_subscription_state") {
          const written = this.writeAuthoritativeState(
            params["p_user_id"] as string,
            params["p_claim_token"] as string,
            params["p_plan"] as string | null,
            params["p_subscription_status"] as string,
            params["p_stripe_customer_id"] as string | null,
          );
          return { data: written, error: null };
        }
        return { data: null, error: { message: `unexpected rpc: ${name}` } };
      },
      auth: {
        admin: {
          listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
            const pageSize = perPage ?? this.listUsersPageSize;
            const start = (page - 1) * pageSize;
            return { data: { users: this.users.slice(start, start + pageSize) }, error: null };
          },
          getUserById: async (userId: string) => {
            this.userByIdCalls++;
            const user = this.users.find((u) => u.id === userId);
            return {
              data: { user: user ? { app_metadata: user.app_metadata } : null },
              error: null,
            };
          },
          updateUserById: async (
            userId: string,
            patch: { app_metadata: Record<string, unknown> },
          ) => {
            const user = this.users.find((u) => u.id === userId);
            if (user) user.app_metadata = patch.app_metadata;
            return { data: {}, error: null };
          },
        },
      },
      from: (table: string) => {
        if (table !== "subscription_state")
          throw new Error(`fake admin: unexpected table ${table}`);
        return {
          select: () => ({
            range: async (from: number, to: number) => {
              const page = this.existingState.slice(from, to + 1);
              return { data: page, error: null };
            },
          }),
        };
      },
    } as unknown as ReconciliationDeps["admin"];
  };
}

function silentLog(): void {
  // swallow runReconciliation's console output in test runs
}

// ---------------------------------------------------------------------
// Pure decision logic (carried over, still passing)
// ---------------------------------------------------------------------

describe("pickAuthoritativeSubscription", () => {
  it("returns null for an empty list", () => {
    expect(pickAuthoritativeSubscription([])).toBeNull();
  });

  it("picks the single active subscription over canceled ones", () => {
    const active = fakeSub({ id: "sub_active", status: "active", created: 200 });
    const canceled = fakeSub({ id: "sub_old", status: "canceled", created: 100 });
    expect(pickAuthoritativeSubscription([canceled, active])).toBe(active);
  });

  it("returns null (genuinely ambiguous) when more than one subscription is active/trialing", () => {
    const a = fakeSub({ id: "sub_a", status: "active", created: 100 });
    const b = fakeSub({ id: "sub_b", status: "trialing", created: 200 });
    expect(pickAuthoritativeSubscription([a, b])).toBeNull();
  });

  it("treats trialing as live, same as active", () => {
    const trialing = fakeSub({ id: "sub_trial", status: "trialing", created: 100 });
    expect(pickAuthoritativeSubscription([trialing])).toBe(trialing);
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
    const fs = new FakeStripe();
    fs.subscriptionResponses.set("cus_1", [
      [fakeSub({ id: "sub_1", status: "active", created: 100, unitAmount: 1999 })],
    ]);
    const outcome = await computeStateForCustomers(
      [fakeCustomer("cus_1", "user-1")],
      fs.asStripe(),
    );
    expect(outcome).toEqual({
      kind: "reconciled",
      state: { plan: "solo", subscriptionStatus: "active", stripeCustomerId: "cus_1" },
    });
  });

  it("treats a customer with zero subscriptions as no_stripe_customer, not an error or ambiguous", async () => {
    const fs = new FakeStripe();
    fs.subscriptionResponses.set("cus_1", [[]]);
    const outcome = await computeStateForCustomers(
      [fakeCustomer("cus_1", "user-1")],
      fs.asStripe(),
    );
    expect(outcome).toEqual({ kind: "no_stripe_customer" });
  });

  it("flags a single customer with multiple subscriptions and no clear active one as ambiguous, never guessed", async () => {
    const fs = new FakeStripe();
    const subA = fakeSub({ id: "sub_a", status: "active", created: 100 });
    const subB = fakeSub({ id: "sub_b", status: "trialing", created: 200 });
    fs.subscriptionResponses.set("cus_1", [[subA, subB]]);
    const outcome = await computeStateForCustomers(
      [fakeCustomer("cus_1", "user-1")],
      fs.asStripe(),
    );
    expect(outcome.kind).toBe("ambiguous");
  });

  it("resolves multiple Stripe customers for one userId when exactly one has a live subscription", async () => {
    const fs = new FakeStripe();
    fs.subscriptionResponses.set("cus_abandoned", [[]]);
    fs.subscriptionResponses.set("cus_real", [
      [fakeSub({ id: "sub_1", status: "active", created: 100, unitAmount: 3999 })],
    ]);
    const outcome = await computeStateForCustomers(
      [fakeCustomer("cus_abandoned", "user-1"), fakeCustomer("cus_real", "user-1")],
      fs.asStripe(),
    );
    expect(outcome).toEqual({
      kind: "reconciled",
      state: { plan: "crew", subscriptionStatus: "active", stripeCustomerId: "cus_real" },
    });
  });

  it("flags multiple Stripe customers for one userId as ambiguous when more than one has a live subscription — never guesses which is authoritative", async () => {
    const fs = new FakeStripe();
    fs.subscriptionResponses.set("cus_a", [
      [fakeSub({ id: "sub_a", status: "active", created: 100 })],
    ]);
    fs.subscriptionResponses.set("cus_b", [
      [fakeSub({ id: "sub_b", status: "active", created: 200 })],
    ]);
    const outcome = await computeStateForCustomers(
      [fakeCustomer("cus_a", "user-1"), fakeCustomer("cus_b", "user-1")],
      fs.asStripe(),
    );
    expect(outcome.kind).toBe("ambiguous");
  });

  it("treats multiple Stripe customers where NEITHER ever subscribed as no_stripe_customer (free user), not ambiguous", async () => {
    const fs = new FakeStripe();
    fs.subscriptionResponses.set("cus_a", [[]]);
    fs.subscriptionResponses.set("cus_b", [[]]);
    const outcome = await computeStateForCustomers(
      [fakeCustomer("cus_a", "user-1"), fakeCustomer("cus_b", "user-1")],
      fs.asStripe(),
    );
    expect(outcome).toEqual({ kind: "no_stripe_customer" });
  });

  it("a Stripe retrieval failure propagates as a thrown error", async () => {
    const stripeClient = {
      subscriptions: {
        list: async () => {
          throw new Error("simulated Stripe API outage");
        },
      },
    } as unknown as Stripe;
    await expect(
      computeStateForCustomers([fakeCustomer("cus_1", "user-1")], stripeClient),
    ).rejects.toThrow("simulated Stripe API outage");
  });
});

// ---------------------------------------------------------------------
// Orchestration: runReconciliation, driven by the fakes above
// ---------------------------------------------------------------------

describe("runReconciliation — THE STALE-SNAPSHOT REGRESSION TEST (Task 1)", () => {
  it("a subscription that changes between the bulk pass and the write is written with the FRESH value, never the stale bulk snapshot", async () => {
    const supa = new FakeSupabase();
    const fs = new FakeStripe();
    supa.users = [{ id: "user-1", email: "a@example.com", app_metadata: {} }];
    fs.customers = [fakeCustomer("cus_1", "user-1")];
    // First call (the bulk pass, inside buildCustomerIndex's caller /
    // the initial computeStateForCustomers in the main loop) sees
    // "past_due". Second call (the re-fetch INSIDE writeSubscriptionState's
    // claim-fenced thunk, simulating the real subscription having since
    // been paid — e.g. by a concurrent webhook event that already landed)
    // sees "active". The write must reflect "active", never "past_due".
    fs.subscriptionResponses.set("cus_1", [
      [fakeSub({ id: "sub_1", status: "past_due", created: 100 })],
      [fakeSub({ id: "sub_1", status: "active", created: 100 })],
    ]);

    const summary = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: fs.asStripe(),
      apply: true,
      log: silentLog,
    });

    expect(summary.reconciled).toBe(1);
    expect(summary.error).toBe(0);
    const written = supa.subscriptionStateRows.get("user-1");
    expect(written?.subscription_status).toBe("active"); // fresh, not the stale "past_due" bulk snapshot
  });

  it("if the subscription becomes genuinely ambiguous between the bulk pass and the write, the write is aborted rather than applying a stale decision", async () => {
    const supa = new FakeSupabase();
    const fs = new FakeStripe();
    supa.users = [{ id: "user-1", email: "a@example.com", app_metadata: {} }];
    fs.customers = [fakeCustomer("cus_1", "user-1")];
    fs.subscriptionResponses.set("cus_1", [
      [fakeSub({ id: "sub_1", status: "active", created: 100 })], // bulk pass: clean, reconciled
      [
        fakeSub({ id: "sub_1", status: "active", created: 100 }),
        fakeSub({ id: "sub_2", status: "trialing", created: 200 }),
      ], // write-time re-fetch: a second live subscription has appeared — now ambiguous
    ]);

    const summary = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: fs.asStripe(),
      apply: true,
      log: silentLog,
    });

    expect(summary.reconciled).toBe(0);
    expect(summary.error).toBe(1); // counted as an error (skipped), not silently written
    expect(supa.subscriptionStateRows.has("user-1")).toBe(false); // nothing written
  });

  it("a concurrent webhook holding the claim causes reconciliation to fail safely (claim_unavailable), never bypassing the lock", async () => {
    const supa = new FakeSupabase();
    const fs = new FakeStripe();
    supa.users = [{ id: "user-1", email: "a@example.com", app_metadata: {} }];
    fs.customers = [fakeCustomer("cus_1", "user-1")];
    fs.subscriptionResponses.set("cus_1", [
      [fakeSub({ id: "sub_1", status: "active", created: 100 })],
    ]);
    // Simulate a live webhook already holding the claim for this user,
    // permanently (never releases during this test) — reconciliation must
    // not proceed unserialized.
    supa.claims.set("user-1", { token: "webhook-holds-this" });
    supa.claimAlwaysBusy = true;

    const summary = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: fs.asStripe(),
      apply: true,
      log: silentLog,
    });

    expect(summary.error).toBe(1);
    expect(summary.reconciled).toBe(0);
    expect(supa.subscriptionStateRows.has("user-1")).toBe(false);
  }, 10_000); // acquireClaimOrThrow's real retry budget (~1.5s) runs for real here
});

describe("runReconciliation — idempotency across repeated runs (Task 2)", () => {
  it("a second run against unchanged Stripe state reports 'unchanged' and does not attempt another write", async () => {
    const supa = new FakeSupabase();
    const fs = new FakeStripe();
    supa.users = [{ id: "user-1", email: "a@example.com", app_metadata: {} }];
    fs.customers = [fakeCustomer("cus_1", "user-1")];
    fs.subscriptionResponses.set("cus_1", [
      [fakeSub({ id: "sub_1", status: "active", created: 100 })],
    ]);

    const first = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: fs.asStripe(),
      apply: true,
      log: silentLog,
    });
    expect(first.reconciled).toBe(1);

    // Second run: existingState now reflects what the first run wrote.
    supa.existingState = [
      {
        user_id: "user-1",
        plan: "solo",
        subscription_status: "active",
        stripe_customer_id: "cus_1",
      },
    ];
    const rpcCallsBefore = supa.subscriptionStateRows.size;
    const second = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: fs.asStripe(),
      apply: true,
      log: silentLog,
    });

    expect(second.unchanged).toBe(1);
    expect(second.reconciled).toBe(0);
    expect(supa.subscriptionStateRows.size).toBe(rpcCallsBefore); // no new/changed write
  });
});

describe("runReconciliation — partial-batch failure and safe rerun (Task 2)", () => {
  it("one user's retrieval failure does not abort the batch; other users still get processed correctly", async () => {
    const supa = new FakeSupabase();
    const fs = new FakeStripe();
    supa.users = [
      { id: "user-fails", email: "fails@example.com", app_metadata: {} },
      { id: "user-ok", email: "ok@example.com", app_metadata: {} },
    ];
    fs.customers = [fakeCustomer("cus_fails", "user-fails"), fakeCustomer("cus_ok", "user-ok")];
    fs.subscriptionResponses.set("cus_ok", [
      [fakeSub({ id: "sub_ok", status: "active", created: 100 })],
    ]);
    // cus_fails has no registered response at all, but we override list()
    // below to throw specifically for it, simulating a transient Stripe
    // API failure for exactly one customer.
    const realAsStripe = fs.asStripe();
    const stripeWithOneFailure = {
      ...realAsStripe,
      subscriptions: {
        list: async (args: { customer: string }) => {
          if (args.customer === "cus_fails") throw new Error("simulated transient Stripe failure");
          return (
            realAsStripe as unknown as { subscriptions: { list: (a: unknown) => Promise<unknown> } }
          ).subscriptions.list(args);
        },
      },
    } as unknown as Stripe;

    const summary = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: stripeWithOneFailure,
      apply: true,
      log: silentLog,
    });

    expect(summary.error).toBe(1); // user-fails
    expect(summary.reconciled).toBe(1); // user-ok still succeeded
    expect(supa.subscriptionStateRows.has("user-ok")).toBe(true);
    expect(supa.subscriptionStateRows.has("user-fails")).toBe(false);
  });

  it("a safe rerun after a transient failure succeeds once the underlying issue is gone", async () => {
    const supa = new FakeSupabase();
    const fs = new FakeStripe();
    supa.users = [{ id: "user-1", email: "a@example.com", app_metadata: {} }];
    fs.customers = [fakeCustomer("cus_1", "user-1")];

    let shouldFail = true;
    const stripeFlaky = {
      customers: fs.asStripe().customers,
      subscriptions: {
        list: async (args: { customer: string }) => {
          if (shouldFail) throw new Error("simulated transient failure");
          return { data: [fakeSub({ id: "sub_1", status: "active", created: 100 })] };
        },
      },
    } as unknown as Stripe;

    const first = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: stripeFlaky,
      apply: true,
      log: silentLog,
    });
    expect(first.error).toBe(1);
    expect(supa.subscriptionStateRows.has("user-1")).toBe(false);

    shouldFail = false;
    const second = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: stripeFlaky,
      apply: true,
      log: silentLog,
    });
    expect(second.reconciled).toBe(1);
    expect(supa.subscriptionStateRows.get("user-1")?.subscription_status).toBe("active");
  });

  it("an infrastructure-level failure (listUsers itself erroring) aborts the whole run rather than silently continuing", async () => {
    const supa = new FakeSupabase();
    const fs = new FakeStripe();
    const admin = supa.asAdmin();
    (admin.auth.admin as unknown as { listUsers: () => Promise<unknown> }).listUsers =
      async () => ({
        data: null,
        error: { message: "simulated Supabase outage" },
      });

    await expect(
      runReconciliation({ admin, stripe: fs.asStripe(), apply: true, log: silentLog }),
    ).rejects.toThrow("Could not list Supabase users");
  });
});

describe("runReconciliation — pagination across multiple pages (Task 2)", () => {
  it("covers every user across multiple Supabase user pages, Stripe customer pages, and existing-state pages", async () => {
    const supa = new FakeSupabase();
    const fs = new FakeStripe();

    // 205 users -> 2 Supabase pages at the real 200-per-page size.
    const userCount = 205;
    for (let i = 0; i < userCount; i++) {
      supa.users.push({ id: `user-${i}`, email: `u${i}@example.com`, app_metadata: {} });
    }
    // 205 Stripe customers, one per user -> 3 Stripe pages at the real
    // 100-per-page limit (100 + 100 + 5).
    for (let i = 0; i < userCount; i++) {
      fs.customers.push(fakeCustomer(`cus_${i}`, `user-${i}`));
      fs.subscriptionResponses.set(`cus_${i}`, [
        [fakeSub({ id: `sub_${i}`, status: "active", created: 100 })],
      ]);
    }
    // 1001 pre-existing subscription_state rows (unrelated users) -> 2
    // range-pages at the real 1000-per-page size, exercising
    // buildExistingStateIndex's own pagination independent of the user
    // list above.
    for (let i = 0; i < 1001; i++) {
      supa.existingState.push({
        user_id: `other-${i}`,
        plan: "solo",
        subscription_status: "active",
        stripe_customer_id: `cus_other_${i}`,
      });
    }

    const summary = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: fs.asStripe(),
      apply: true,
      log: silentLog,
    });

    expect(summary.reconciled).toBe(userCount); // every one of the 205 users was reached and written
    expect(summary.error).toBe(0);
    expect(supa.subscriptionStateRows.size).toBe(userCount);
  });
});

describe("runReconciliation — ambiguous and orphaned mappings are flagged, never guessed (Task 2)", () => {
  it("flags a user with multiple Stripe customers that both have live subscriptions", async () => {
    const supa = new FakeSupabase();
    const fs = new FakeStripe();
    supa.users = [{ id: "user-1", email: "a@example.com", app_metadata: {} }];
    fs.customers = [fakeCustomer("cus_a", "user-1"), fakeCustomer("cus_b", "user-1")];
    fs.subscriptionResponses.set("cus_a", [
      [fakeSub({ id: "sub_a", status: "active", created: 100 })],
    ]);
    fs.subscriptionResponses.set("cus_b", [
      [fakeSub({ id: "sub_b", status: "active", created: 100 })],
    ]);

    const summary = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: fs.asStripe(),
      apply: true,
      log: silentLog,
    });

    expect(summary.ambiguous).toBe(1);
    expect(summary.flagged[0]).toContain("user-1");
    expect(supa.subscriptionStateRows.has("user-1")).toBe(false);
  });

  it("flags an orphaned account: existing subscription_state claims a plan, but no matching Stripe customer exists anymore", async () => {
    const supa = new FakeSupabase();
    const fs = new FakeStripe();
    supa.users = [{ id: "user-1", email: "a@example.com", app_metadata: {} }];
    supa.existingState = [
      {
        user_id: "user-1",
        plan: "crew",
        subscription_status: "active",
        stripe_customer_id: "cus_gone",
      },
    ];
    // No fs.customers entry for user-1 at all — simulates the Stripe
    // customer having vanished since the last reconciliation.

    const summary = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: fs.asStripe(),
      apply: true,
      log: silentLog,
    });

    expect(summary.ambiguous).toBe(1);
    expect(summary.flagged[0]).toContain("user-1");
    expect(summary.noStripeCustomer).toBe(0); // correctly distinguished from a never-subscribed free user
  });

  it("does NOT flag a genuinely free user (no Stripe customer, no existing state) — counted separately", async () => {
    const supa = new FakeSupabase();
    const fs = new FakeStripe();
    supa.users = [{ id: "user-1", email: "a@example.com", app_metadata: {} }];

    const summary = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: fs.asStripe(),
      apply: true,
      log: silentLog,
    });

    expect(summary.noStripeCustomer).toBe(1);
    expect(summary.ambiguous).toBe(0);
    expect(summary.flagged).toHaveLength(0);
  });
});

describe("runReconciliation — dry run makes no writes", () => {
  it("dry run reports what it would change but calls no write RPCs at all", async () => {
    const supa = new FakeSupabase();
    const fs = new FakeStripe();
    supa.users = [{ id: "user-1", email: "a@example.com", app_metadata: {} }];
    fs.customers = [fakeCustomer("cus_1", "user-1")];
    fs.subscriptionResponses.set("cus_1", [
      [fakeSub({ id: "sub_1", status: "active", created: 100 })],
    ]);

    const summary = await runReconciliation({
      admin: supa.asAdmin(),
      stripe: fs.asStripe(),
      apply: false,
      log: silentLog,
    });

    expect(summary.reconciled).toBe(1); // counted as "would reconcile"
    expect(supa.subscriptionStateRows.size).toBe(0); // but nothing actually written
    expect(supa.claims.size).toBe(0); // not even a claim was attempted in dry-run mode
  });
});
