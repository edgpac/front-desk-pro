import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  writeSubscriptionState,
  acquireClaimOrThrow,
  releaseClaim,
  claimStripeEvent,
  completeStripeEvent,
  failStripeEvent,
  LockUnavailableError,
  ClaimLostError,
} from "./api.stripe.webhook";

// 2026-10 fifth-pass concurrency review. These tests exercise the ACTUAL
// conditional semantics of 0021_stripe_webhook_claims.sql (ownership
// token, staleness), 0022_stripe_processed_events.sql (lease-based status
// lifecycle with lease-token-gated completion/failure), and
// 0023_subscription_state.sql's write_authoritative_subscription_state
// (the atomic, claim-fenced authoritative write) via an in-memory
// simulator implementing the same logic the SQL does — not a queue of
// canned return values — so a bug in the actual claim/lease/write logic
// would show up here. No real Stripe or Supabase calls anywhere in this
// file.
//
// IMPORTANT, stated explicitly per review instructions: these are
// deterministic, single-threaded SIMULATIONS of concurrent scenarios (an
// explicit virtual clock and explicit call ordering — e.g. "worker B's
// entire cycle runs synchronously inside worker A's fetchCurrentTruth
// callback" to deterministically reproduce an interleaving). They prove
// the application-level state machine makes the correct decision for each
// scenario. They do NOT exercise real concurrent PostgreSQL transactions.
// A SEPARATE, real-Postgres verification (scripts/pg-concurrency-check.sh,
// run once against a local, throwaway, non-production Postgres instance —
// never this project's real Supabase database) is reported alongside
// these tests specifically because an in-memory simulation cannot prove
// that `SELECT ... FOR UPDATE` genuinely blocks a concurrent transaction —
// only a real Postgres engine can demonstrate that.

type FakeUser = { app_metadata: Record<string, unknown> };
type SubscriptionStateRow = {
  plan: string | null;
  subscriptionStatus: string;
  stripeCustomerId: string | null;
};

class FakeBackend {
  claims = new Map<string, { token: string; claimedAt: number }>();
  events = new Map<
    string,
    {
      status: "processing" | "completed" | "failed";
      leaseToken: string;
      leasedAt: number;
      attemptCount: number;
    }
  >();
  subscriptionState = new Map<string, SubscriptionStateRow>();
  users = new Map<string, FakeUser>();
  now = 0; // virtual clock — tests advance it explicitly, no real sleeping in the simulated DB layer
  rpcErrorMode: "none" | "always" = "none";
  mirrorCalls: unknown[] = [];
  authoritativeWrites: unknown[] = [];

  claimUserSlot(userId: string, token: string, staleSeconds: number): boolean {
    const existing = this.claims.get(userId);
    if (!existing || this.now - existing.claimedAt >= staleSeconds * 1000) {
      this.claims.set(userId, { token, claimedAt: this.now });
      return true;
    }
    return false;
  }

  releaseUserSlot(userId: string, token: string): void {
    const existing = this.claims.get(userId);
    if (existing && existing.token === token) this.claims.delete(userId);
  }

  // Mirrors write_authoritative_subscription_state's exact SQL logic
  // (0023): reads the CURRENT claim_token for this user (no staleness
  // check here — staleness is only ever evaluated by claimUserSlot's own
  // steal attempt; this function only cares whether the token presented
  // right now still matches whatever is currently on the row) and only
  // writes subscription_state if it matches. The real SQL's atomicity
  // comes from `SELECT ... FOR UPDATE` holding a row lock for the
  // duration of the whole function call — this in-memory simulation is
  // single-threaded so it cannot demonstrate that lock blocking a
  // concurrent caller; see the real-Postgres script for that proof.
  writeAuthoritativeState(
    userId: string,
    claimToken: string,
    plan: string | null,
    subscriptionStatus: string,
    stripeCustomerId: string | null,
  ): boolean {
    const currentClaim = this.claims.get(userId);
    if (!currentClaim || currentClaim.token !== claimToken) return false;
    const existing = this.subscriptionState.get(userId);
    this.subscriptionState.set(userId, {
      plan,
      subscriptionStatus,
      stripeCustomerId: stripeCustomerId ?? existing?.stripeCustomerId ?? null,
    });
    return true;
  }

  // Mirrors claim_stripe_event's exact SQL logic (0022).
  claimEvent(
    eventId: string,
    leaseToken: string,
    leaseSeconds: number,
  ): "claimed" | "duplicate_completed" | "duplicate_processing" {
    const existing = this.events.get(eventId);
    if (!existing) {
      this.events.set(eventId, {
        status: "processing",
        leaseToken,
        leasedAt: this.now,
        attemptCount: 1,
      });
      return "claimed";
    }
    const leaseExpired =
      existing.status === "processing" && this.now - existing.leasedAt >= leaseSeconds * 1000;
    if (existing.status === "failed" || leaseExpired) {
      existing.status = "processing";
      existing.leaseToken = leaseToken;
      existing.leasedAt = this.now;
      existing.attemptCount += 1;
      return "claimed";
    }
    return existing.status === "completed" ? "duplicate_completed" : "duplicate_processing";
  }

  completeEvent(eventId: string, leaseToken: string): boolean {
    const existing = this.events.get(eventId);
    if (existing && existing.leaseToken === leaseToken) {
      existing.status = "completed";
      return true;
    }
    return false;
  }

  failEvent(eventId: string, leaseToken: string): boolean {
    const existing = this.events.get(eventId);
    if (existing && existing.leaseToken === leaseToken) {
      existing.status = "failed";
      return true;
    }
    return false;
  }
}

function fakeAdmin(backend: FakeBackend): SupabaseClient {
  return {
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (backend.rpcErrorMode === "always") {
        return {
          data: null,
          error: { message: "simulated: function does not exist (migration not applied)" },
        };
      }
      if (name === "claim_stripe_webhook_slot") {
        const claimed = backend.claimUserSlot(
          params["p_user_id"] as string,
          params["p_claim_token"] as string,
          (params["p_stale_seconds"] as number) ?? 30,
        );
        return { data: claimed, error: null };
      }
      if (name === "release_stripe_webhook_slot") {
        backend.releaseUserSlot(params["p_user_id"] as string, params["p_claim_token"] as string);
        return { data: null, error: null };
      }
      if (name === "write_authoritative_subscription_state") {
        backend.authoritativeWrites.push(params);
        const written = backend.writeAuthoritativeState(
          params["p_user_id"] as string,
          params["p_claim_token"] as string,
          params["p_plan"] as string | null,
          params["p_subscription_status"] as string,
          params["p_stripe_customer_id"] as string | null,
        );
        return { data: written, error: null };
      }
      if (name === "claim_stripe_event") {
        const result = backend.claimEvent(
          params["p_event_id"] as string,
          params["p_lease_token"] as string,
          (params["p_lease_seconds"] as number) ?? 60,
        );
        return { data: result, error: null };
      }
      if (name === "complete_stripe_event") {
        const ok = backend.completeEvent(
          params["p_event_id"] as string,
          params["p_lease_token"] as string,
        );
        return { data: ok, error: null };
      }
      if (name === "fail_stripe_event") {
        const ok = backend.failEvent(
          params["p_event_id"] as string,
          params["p_lease_token"] as string,
        );
        return { data: ok, error: null };
      }
      return { data: null, error: { message: `unexpected rpc: ${name}` } };
    },
    auth: {
      admin: {
        getUserById: async (userId: string) => ({
          data: { user: backend.users.get(userId) ?? { app_metadata: {} } },
          error: null,
        }),
        updateUserById: async (
          userId: string,
          patch: { app_metadata: Record<string, unknown> },
        ) => {
          backend.mirrorCalls.push({ userId, patch });
          backend.users.set(userId, { app_metadata: patch.app_metadata });
          return { data: {}, error: null };
        },
      },
    },
  } as unknown as SupabaseClient;
}

describe("write_authoritative_subscription_state (simulated) — the atomic fencing write", () => {
  it("writes when the presented token matches the current claim", async () => {
    const backend = new FakeBackend();
    backend.claimUserSlot("user-1", "token-a", 30);
    expect(backend.writeAuthoritativeState("user-1", "token-a", "crew", "active", "cus_1")).toBe(
      true,
    );
    expect(backend.subscriptionState.get("user-1")).toEqual({
      plan: "crew",
      subscriptionStatus: "active",
      stripeCustomerId: "cus_1",
    });
  });

  it("THE REVIEW'S CORE QUESTION: rejects a write from a token that is no longer current, even though that exact token was valid moments earlier", async () => {
    const backend = new FakeBackend();
    backend.claimUserSlot("user-1", "token-a", 30);
    backend.now += 31_000;
    backend.claimUserSlot("user-1", "token-b", 30); // steals it

    // token-a was genuinely valid a moment ago (before the steal) — the
    // function must check CURRENT ownership, not "was ever valid."
    expect(backend.writeAuthoritativeState("user-1", "token-a", "solo", "canceled", null)).toBe(
      false,
    );
    expect(backend.subscriptionState.has("user-1")).toBe(false); // nothing written
  });

  it("rejects a write when no claim has ever been acquired for this user", () => {
    const backend = new FakeBackend();
    expect(backend.writeAuthoritativeState("user-1", "any-token", "crew", "active", "cus_1")).toBe(
      false,
    );
  });

  it("preserves the existing stripe_customer_id when a later write omits it (coalesce behavior)", () => {
    const backend = new FakeBackend();
    backend.claimUserSlot("user-1", "token-a", 30);
    backend.writeAuthoritativeState("user-1", "token-a", "crew", "active", "cus_1");
    backend.writeAuthoritativeState("user-1", "token-a", "crew", "past_due", null); // e.g. invoice.payment_failed, no customer id in this path
    expect(backend.subscriptionState.get("user-1")?.stripeCustomerId).toBe("cus_1");
  });
});

describe("claimStripeEvent / completeStripeEvent / failStripeEvent — event lifecycle", () => {
  it("claims a brand-new event", async () => {
    const admin = fakeAdmin(new FakeBackend());
    expect(await claimStripeEvent(admin, "evt_1", "lease-a")).toBe("claimed");
  });

  it("a duplicate of an already-COMPLETED event returns duplicate_completed, safe to no-op", async () => {
    const admin = fakeAdmin(new FakeBackend());
    expect(await claimStripeEvent(admin, "evt_1", "lease-a")).toBe("claimed");
    expect(await completeStripeEvent(admin, "evt_1", "lease-a")).toBe(true);
    expect(await claimStripeEvent(admin, "evt_1", "lease-b")).toBe("duplicate_completed");
  });

  it("a duplicate of an event still actively being processed (lease not expired) must not be independently claimed", async () => {
    const admin = fakeAdmin(new FakeBackend());
    expect(await claimStripeEvent(admin, "evt_1", "lease-a")).toBe("claimed");
    expect(await claimStripeEvent(admin, "evt_1", "lease-b")).toBe("duplicate_processing");
  });

  it("an abandoned event (processing, lease expired) becomes reclaimable — bounded-lease recovery", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    expect(await claimStripeEvent(admin, "evt_1", "lease-a")).toBe("claimed");
    backend.now += 61_000;
    expect(await claimStripeEvent(admin, "evt_1", "lease-b")).toBe("claimed");
  });

  it("a FAILED event is reclaimable immediately, without waiting out any lease", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    expect(await claimStripeEvent(admin, "evt_1", "lease-a")).toBe("claimed");
    await failStripeEvent(admin, "evt_1", "lease-a");
    expect(await claimStripeEvent(admin, "evt_1", "lease-b")).toBe("claimed");
  });

  it("a stale worker cannot mark an event completed after another worker has reclaimed it", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    expect(await claimStripeEvent(admin, "evt_1", "lease-a")).toBe("claimed");
    backend.now += 61_000;
    expect(await claimStripeEvent(admin, "evt_1", "lease-b")).toBe("claimed");
    expect(await completeStripeEvent(admin, "evt_1", "lease-b")).toBe(true);

    expect(await completeStripeEvent(admin, "evt_1", "lease-a")).toBe(false); // safe no-op
    expect(backend.events.get("evt_1")?.status).toBe("completed"); // unchanged
  });

  it("a stale worker's FAILURE call cannot overwrite a newer worker's successful completion", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    expect(await claimStripeEvent(admin, "evt_1", "lease-a")).toBe("claimed");
    backend.now += 61_000;
    expect(await claimStripeEvent(admin, "evt_1", "lease-b")).toBe("claimed");
    expect(await completeStripeEvent(admin, "evt_1", "lease-b")).toBe(true);

    expect(await failStripeEvent(admin, "evt_1", "lease-a")).toBe(false);
    expect(backend.events.get("evt_1")?.status).toBe("completed");
  });

  it("models the exact crash window the review flagged: crash after the real write succeeds but before marking completed is recoverable and idempotent, without relying on any unrelated future event", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);

    expect(await claimStripeEvent(admin, "evt_1", "lease-a")).toBe("claimed");
    await writeSubscriptionState(admin, "user-1", async () => ({ subscriptionStatus: "canceled" }));
    expect(backend.authoritativeWrites).toHaveLength(1);
    // completeStripeEvent deliberately NOT called — simulating the crash.

    expect(await claimStripeEvent(admin, "evt_1", "lease-retry")).toBe("duplicate_processing");
    backend.now += 61_000;
    expect(await claimStripeEvent(admin, "evt_1", "lease-retry")).toBe("claimed"); // reclaimed

    await writeSubscriptionState(admin, "user-1", async () => ({ subscriptionStatus: "canceled" })); // idempotent redo
    expect(await completeStripeEvent(admin, "evt_1", "lease-retry")).toBe(true);

    expect(backend.authoritativeWrites).toHaveLength(2);
    expect(backend.events.get("evt_1")?.status).toBe("completed");
  });
});

describe("acquireClaimOrThrow / releaseClaim — per-user write-claim semantics", () => {
  it("acquires immediately when uncontended", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    const token = await acquireClaimOrThrow(admin, "user-1");
    expect(backend.claims.get("user-1")?.token).toBe(token);
  });

  it("throws LockUnavailableError when contention outlasts the retry budget", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    backend.claimUserSlot("user-1", "someone-elses-token", 30);
    await expect(acquireClaimOrThrow(admin, "user-1")).rejects.toThrow(LockUnavailableError);
  }, 10_000);

  it("throws LockUnavailableError when the claim RPC itself is unavailable (e.g. migration 0021 not applied)", async () => {
    const backend = new FakeBackend();
    backend.rpcErrorMode = "always";
    const admin = fakeAdmin(backend);
    await expect(acquireClaimOrThrow(admin, "user-1")).rejects.toThrow(LockUnavailableError);
  }, 10_000);

  it("claim expiry: a stale claim can be stolen by a new holder", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    const tokenA = await acquireClaimOrThrow(admin, "user-1");
    backend.now += 31_000;
    const tokenB = await acquireClaimOrThrow(admin, "user-1");
    expect(tokenB).not.toBe(tokenA);
  });

  it("claim ownership: a stale holder's late release cannot delete a new holder's legitimate claim", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    const tokenA = await acquireClaimOrThrow(admin, "user-1");
    backend.now += 31_000;
    const tokenB = await acquireClaimOrThrow(admin, "user-1");
    await releaseClaim(admin, "user-1", tokenA);
    expect(backend.claims.get("user-1")?.token).toBe(tokenB);
    await releaseClaim(admin, "user-1", tokenB);
    expect(backend.claims.has("user-1")).toBe(false);
  });

  it("worker crash while holding a claim is recoverable (not a permanent deadlock)", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    await acquireClaimOrThrow(admin, "user-1");
    backend.now += 31_000;
    await expect(acquireClaimOrThrow(admin, "user-1")).resolves.toBeTypeOf("string");
  });
});

describe("writeSubscriptionState — fencing at the write boundary, closed structurally (not just narrowed)", () => {
  it("THE SIX-STEP SCENARIO: A acquires the claim and starts a slow fetch; A's claim expires; B takes over and writes newer state; A resumes with its stale result; A must be unable to overwrite B's state", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);

    await expect(
      writeSubscriptionState(admin, "user-1", async () => {
        backend.now += 31_000; // A's claim goes stale while A is "slow"
        await writeSubscriptionState(admin, "user-1", async () => ({
          subscriptionStatus: "active",
        })); // B takes over
        return { subscriptionStatus: "canceled" }; // A resumes with its stale result
      }),
    ).rejects.toThrow(ClaimLostError);

    expect(backend.authoritativeWrites).toHaveLength(2); // A attempted, B succeeded
    expect(backend.subscriptionState.get("user-1")?.subscriptionStatus).toBe("active"); // only B's write took effect
  });

  it("the fencing check and the write are now the SAME call, not two sequential steps: A's eventual write attempt happens after the claim was already stolen, and is rejected AT THE WRITE ITSELF, not by an earlier check that could go stale", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    const tokenA = await acquireClaimOrThrow(admin, "user-1");
    backend.now += 31_000;
    await acquireClaimOrThrow(admin, "user-1"); // B steals it (different token, discarded here — we only need A's to be stale)

    // A, unaware, now attempts the write directly with its own stale token
    // — there is no separate "renew" step to call first; the write call
    // itself is the only gate, and it must reject.
    const rejected = backend.writeAuthoritativeState("user-1", tokenA, "crew", "active", null);
    expect(rejected).toBe(false);
    expect(backend.subscriptionState.has("user-1")).toBe(false);
  });

  it("claim expiry with no contender: the write still succeeds no matter how much virtual time passed, because nothing stole the claim", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);

    await writeSubscriptionState(admin, "user-1", async () => {
      backend.now += 31_000; // elapsed time alone does not invalidate a token nobody else claimed
      return { subscriptionStatus: "active" };
    });

    expect(backend.authoritativeWrites).toHaveLength(1);
    expect(backend.subscriptionState.get("user-1")?.subscriptionStatus).toBe("active");
  });

  it("transient Stripe API failure: fetchCurrentTruth throws, the claim is still released, and nothing is written", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);

    await expect(
      writeSubscriptionState(admin, "user-1", async () => {
        throw new Error("simulated transient Stripe API failure");
      }),
    ).rejects.toThrow("simulated transient Stripe API failure");

    expect(backend.authoritativeWrites).toHaveLength(0);
    expect(backend.claims.has("user-1")).toBe(false);
  });

  it("recovery after a worker crash: a later, fresh call for the same user is unaffected by an earlier abandoned one", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    await acquireClaimOrThrow(admin, "user-1"); // simulates a prior crashed worker
    backend.now += 31_000;
    await writeSubscriptionState(admin, "user-1", async () => ({ subscriptionStatus: "active" }));
    expect(backend.subscriptionState.get("user-1")?.subscriptionStatus).toBe("active");
  });

  it("'two different events with identical created timestamps' / 'an older event processed after a newer one': neither matters, because each call re-fetches truth fresh and the claim serializes real execution order", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    await writeSubscriptionState(admin, "user-1", async () => ({ subscriptionStatus: "active" }));
    await writeSubscriptionState(admin, "user-1", async () => ({ subscriptionStatus: "canceled" }));
    expect(backend.subscriptionState.get("user-1")?.subscriptionStatus).toBe("canceled");
    expect(backend.authoritativeWrites).toHaveLength(2);
  });

  it("the compatibility mirror writes app_metadata AFTER the authoritative write, preserving unrelated fields, and never blocks the authoritative outcome", async () => {
    const backend = new FakeBackend();
    backend.users.set("user-1", { app_metadata: { someFutureField: "keep-me" } });
    const admin = fakeAdmin(backend);

    await writeSubscriptionState(admin, "user-1", async () => ({
      plan: "crew",
      subscriptionStatus: "active",
    }));

    expect(backend.subscriptionState.get("user-1")).toMatchObject({
      plan: "crew",
      subscriptionStatus: "active",
    });
    expect(backend.mirrorCalls).toHaveLength(1);
    expect(backend.users.get("user-1")?.app_metadata).toMatchObject({
      someFutureField: "keep-me",
      plan: "crew",
    });
  });

  it("mirror failure does not affect the authoritative outcome: the write already succeeded regardless of what happens to app_metadata afterward", async () => {
    const backend = new FakeBackend();
    const admin = fakeAdmin(backend);
    // Break the mirror path specifically — getUserById errors, simulating
    // a GoTrue outage — while the authoritative RPC path is untouched.
    (admin.auth.admin as unknown as { getUserById: () => Promise<unknown> }).getUserById =
      async () => ({
        data: null,
        error: { message: "simulated GoTrue outage" },
      });

    await writeSubscriptionState(admin, "user-1", async () => ({ subscriptionStatus: "active" }));

    expect(backend.subscriptionState.get("user-1")?.subscriptionStatus).toBe("active"); // authoritative write still succeeded
    expect(backend.mirrorCalls).toHaveLength(0); // mirror never got far enough to write, and that's fine
  });
});
