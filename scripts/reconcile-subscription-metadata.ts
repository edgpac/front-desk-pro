// One-time (re-runnable) reconciliation / backfill for the 2026-10
// security-audit fix. Subscription state has moved twice: first from
// client-writable `user_metadata` to service-role-only `app_metadata`,
// and now from `app_metadata` to the authoritative `subscription_state`
// table (0023_subscription_state.sql).
//
// SIXTH PASS: this script's write path used to be a plain, unconditional
// `subscription_state` upsert based on a Stripe snapshot captured during
// an earlier bulk pass — found in review to be racy against a live
// webhook: if a webhook wrote a newer state for some user after this
// script's bulk fetch but before this script's write for that same user,
// this script could silently overwrite the newer state with its stale
// snapshot. Fixed by reusing the exact same claim-fenced write path the
// webhook uses (`writeSubscriptionState`, imported from
// api.stripe.webhook.tsx, verified importable from a plain `bun run`
// script context, not just inside the Vite/vitest pipeline — this was
// checked empirically before relying on it, not assumed) — this script's
// writes are now serialized against any concurrent webhook write for the
// same user via the same per-user claim, and the data actually written is
// re-fetched fresh from Stripe at write time, not the earlier bulk
// snapshot. The bulk pass (`buildCustomerIndex`) is still used, but only
// to decide cheaply which users even need attention — the authoritative
// numbers for each write come from a fresh re-fetch under the claim,
// exactly mirroring how a live webhook event is processed. See
// `reconcileOneUser` below for the exact mechanism, and
// `writeSubscriptionState`'s own comment (api.stripe.webhook.tsx) for why
// this closes the race structurally rather than narrowing it.
//
// Also SIXTH PASS: `admin`/`stripe` are no longer module-level singletons
// baked into every function — every function that needs them now takes
// them as parameters, and the full orchestration loop
// (`runReconciliation`) is its own function `main()` just calls with the
// real ones. This is a dependency-injection refactor only, not a
// behavior change: it's what makes the orchestration (pagination,
// idempotency, partial-failure recovery) testable with fake clients
// instead of only the pure decision functions being testable — see
// reconcile-subscription-metadata.test.ts.
//
// This script does NOT copy existing user_metadata OR app_metadata values
// into subscription_state — either may have been set by a user calling
// `supabase.auth.updateUser()` directly (user_metadata) or could simply be
// stale relative to this revision's switch (app_metadata). Instead, for
// every real Supabase auth user, it asks Stripe directly: "is there a real
// Stripe customer whose metadata.userId matches this user, and does that
// customer have a real subscription?" That `metadata.userId` field is only
// ever set by this app's own server code (stripe-server.ts's
// createCheckoutSession, when it creates a Stripe customer, and
// subscription_data.metadata on the Checkout Session) — never by the
// client — so it is the trustworthy link between a Supabase user and their
// real Stripe billing state, independent of anything in that user's own
// metadata.
//
// Usage:
//   bun run scripts/reconcile-subscription-metadata.ts            # dry run (default) — prints what WOULD change, writes nothing
//   bun run scripts/reconcile-subscription-metadata.ts --apply    # actually writes subscription_state (+ a best-effort app_metadata mirror)
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY in the
// environment (same vars the app itself uses — never hardcode these).
//
// REQUIRED BEFORE THE ENTITLEMENT-READ CUTOVER: entitlements-server.ts and
// stripe-server.ts now read only subscription_state, never app_metadata.
// Deploying that code before this script's --apply run has populated
// subscription_state for every existing legitimate subscriber would make
// every one of them fail closed (no row => no entitlement) — this script
// must run, and be reviewed, BEFORE that deploy, not after.
//
// Idempotent / repeatable: every run recomputes each user's state fresh from
// Stripe and upserts subscription_state with that computed value (or leaves
// it untouched if nothing needs to change) — running it twice in a row
// produces the same end state as running it once. Recoverable: it never
// deletes or modifies user_metadata, and --apply only ever writes
// subscription_state's own three columns for a given user_id (an upsert
// keyed by user_id, never affecting any other user's row) plus a
// best-effort, non-blocking app_metadata mirror.
//
// Ambiguous cases (more than one Stripe customer for the same userId with
// conflicting subscription state) are never guessed at — they're reported
// under "flagged for manual review" and left untouched.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { resolvePlanFromSubscription } from "../src/lib/stripe-server";
import {
  writeSubscriptionState,
  LockUnavailableError,
  ClaimLostError,
  AuthoritativeWriteError,
} from "../src/routes/api.stripe.webhook";

const APPLY = process.argv.includes("--apply");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

export type ComputedState = {
  plan: "solo" | "crew" | null;
  // Never actually null: a real Stripe subscription's .status is always a
  // string, and subscription_state.subscription_status is `not null` in
  // the schema (0023_subscription_state.sql) — typed non-nullable to match
  // both, not just defensively widened.
  subscriptionStatus: string;
  stripeCustomerId: string;
};

export type Outcome =
  | { kind: "no_stripe_customer" }
  | { kind: "reconciled"; state: ComputedState }
  | { kind: "ambiguous"; reason: string }
  | { kind: "error"; error: string };

// Builds the full userId -> Stripe customer[] index in one pass over all
// Stripe customers, rather than one Search API call per Supabase user — a
// one-time script doesn't need to be fast per-user, but it does need to be
// correct regardless of whether the Stripe account/library version has
// Search API access, and avoiding Search API's eventual-consistency window
// entirely removes a class of "ran right after a real signup, missed it"
// bug.
export async function buildCustomerIndex(
  stripeClient: Stripe,
): Promise<Map<string, Stripe.Customer[]>> {
  const index = new Map<string, Stripe.Customer[]>();
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripeClient.customers.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const customer of page.data) {
      const userId = customer.metadata?.["userId"];
      if (!userId) continue;
      const existing = index.get(userId) ?? [];
      existing.push(customer);
      index.set(userId, existing);
    }
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]?.id;
  }
  return index;
}

// Picks the one subscription that should drive entitlements for a customer,
// mirroring the live webhook's own "active wins" bias — a customer can only
// ever have one subscription that matters in this app's one-plan-at-a-time
// model, but Stripe's API returns every subscription object ever created
// (including old canceled ones), so this must pick deliberately, not just
// take the first result.
export function pickAuthoritativeSubscription(
  subscriptions: Stripe.Subscription[],
): Stripe.Subscription | null {
  if (subscriptions.length === 0) return null;
  const active = subscriptions.filter((s) => s.status === "active" || s.status === "trialing");
  if (active.length === 1) return active[0] ?? null;
  if (active.length > 1) return null; // genuinely ambiguous — more than one live subscription
  // No active/trialing subscription — most recently created one represents
  // the account's last known real state (e.g. "canceled", "past_due").
  return [...subscriptions].sort((a, b) => b.created - a.created)[0] ?? null;
}

export async function computeStateForCustomers(
  customers: Stripe.Customer[],
  stripeClient: Stripe,
): Promise<Outcome> {
  if (customers.length > 1) {
    // Multiple Stripe customer objects for the same userId — can happen if
    // checkout was started more than once without completing. Only
    // unambiguous if at most one of them actually has live subscription
    // state; otherwise this needs a human to decide which is real.
    const withActive: Stripe.Customer[] = [];
    for (const customer of customers) {
      const subs = await stripeClient.subscriptions.list({
        customer: customer.id,
        status: "all",
        limit: 100,
      });
      if (subs.data.some((s) => s.status === "active" || s.status === "trialing"))
        withActive.push(customer);
    }
    if (withActive.length > 1) {
      return {
        kind: "ambiguous",
        reason: `${customers.length} Stripe customers found, ${withActive.length} with a live subscription — cannot determine which is authoritative.`,
      };
    }
    if (withActive.length === 0) {
      return { kind: "no_stripe_customer" }; // multiple customers, none ever subscribed — treat as free
    }
    customers = withActive;
  }

  const customer = customers[0];
  if (!customer) return { kind: "no_stripe_customer" };
  const subs = await stripeClient.subscriptions.list({
    customer: customer.id,
    status: "all",
    limit: 100,
  });
  const subscription = pickAuthoritativeSubscription(subs.data);
  if (!subscription) {
    if (subs.data.length > 1) {
      return {
        kind: "ambiguous",
        reason: `Customer ${customer.id} has ${subs.data.length} subscriptions with no single active one — cannot determine which is authoritative.`,
      };
    }
    return { kind: "no_stripe_customer" }; // customer exists, never subscribed
  }

  return {
    kind: "reconciled",
    state: {
      plan: resolvePlanFromSubscription(subscription),
      subscriptionStatus: subscription.status,
      stripeCustomerId: customer.id,
    },
  };
}

// Bulk-reads every existing subscription_state row into a Map, same
// rationale as buildCustomerIndex: one query instead of one per user.
// service_role bypasses RLS, so this sees every user's row regardless of
// subscription_state's owner-only SELECT policy.
export async function buildExistingStateIndex(
  admin: SupabaseClient,
): Promise<Map<string, ComputedState>> {
  const index = new Map<string, ComputedState>();
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    const { data, error } = await admin
      .from("subscription_state")
      .select("user_id, plan, subscription_status, stripe_customer_id")
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(`Could not read existing subscription_state rows: ${error.message}`);
    }
    for (const row of data ?? []) {
      index.set(row["user_id"] as string, {
        plan: row["plan"] as "solo" | "crew" | null,
        subscriptionStatus: row["subscription_status"] as string,
        stripeCustomerId: row["stripe_customer_id"] as string,
      });
    }
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return index;
}

export type ReconcileWriteResult =
  | { kind: "written" }
  | { kind: "stale_at_write_time"; detail: string } // fresh re-fetch no longer agrees with the bulk-pass outcome
  | { kind: "claim_unavailable" }
  | { kind: "write_rejected" } // claim was lost between acquiring it and the authoritative write
  | { kind: "error"; error: string };

// The one and only write path, reused unchanged from api.stripe.webhook.tsx
// rather than reimplemented — see the file header for why. Re-fetches this
// ONE user's current Stripe state fresh, inside writeSubscriptionState's
// own claim-fenced critical section, rather than trusting the earlier bulk
// snapshot, which is used here only to know WHICH customers to re-check,
// not what to write. If the fresh re-check no longer agrees that this user
// has a single clear, reconciled state (e.g. it churned to ambiguous, or
// disappeared, between the bulk pass and now), the write is aborted rather
// than applying a decision that's no longer current — self-correcting on
// the next run, which re-derives everything from scratch anyway.
export async function reconcileOneUser(
  admin: SupabaseClient,
  stripeClient: Stripe,
  userId: string,
  customersForUser: Stripe.Customer[],
): Promise<ReconcileWriteResult> {
  try {
    await writeSubscriptionState(admin, userId, async () => {
      const fresh = await computeStateForCustomers(customersForUser, stripeClient);
      if (fresh.kind !== "reconciled") {
        throw new Error(
          `fresh re-check at write time produced "${fresh.kind}", not "reconciled" — aborting this write`,
        );
      }
      return {
        plan: fresh.state.plan,
        subscriptionStatus: fresh.state.subscriptionStatus,
        stripeCustomerId: fresh.state.stripeCustomerId,
      };
    });
    return { kind: "written" };
  } catch (err) {
    if (err instanceof LockUnavailableError) return { kind: "claim_unavailable" };
    if (err instanceof ClaimLostError || err instanceof AuthoritativeWriteError)
      return { kind: "write_rejected" };
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("aborting this write"))
      return { kind: "stale_at_write_time", detail: message };
    return { kind: "error", error: message };
  }
}

export type ReconciliationSummary = {
  reconciled: number;
  unchanged: number;
  noStripeCustomer: number;
  ambiguous: number;
  error: number;
  flagged: string[];
};

// Minimal shape of the one Supabase admin call this orchestration needs
// beyond the `.from(...)` query builder (`listUsers`) — typed narrowly so
// a fake client in tests doesn't need to implement the entire
// SupabaseClient surface, just this one method plus `.from()`.
type UserPage = {
  users: Array<{ id: string; email?: string | undefined; app_metadata: Record<string, unknown> }>;
};
export type ReconciliationDeps = {
  admin: SupabaseClient & {
    auth: {
      admin: {
        listUsers: (opts: {
          page: number;
          perPage: number;
        }) => Promise<{ data: UserPage; error: { message: string } | null }>;
      };
    };
  };
  stripe: Stripe;
  apply: boolean;
  log?: (...args: unknown[]) => void;
};

// The full orchestration loop, extracted out of main() so it can be driven
// by fake admin/stripe clients in tests (reconcile-subscription-metadata.test.ts)
// instead of only the pure decision functions (pickAuthoritativeSubscription,
// computeStateForCustomers) being testable. main() below calls this with the
// real singletons; nothing about its own logic changes based on who's calling
// it.
export async function runReconciliation(deps: ReconciliationDeps): Promise<ReconciliationSummary> {
  const { admin, stripe, apply, log = console.log } = deps;
  log(
    apply
      ? "Running in APPLY mode — subscription_state WILL be written (plus a best-effort app_metadata mirror)."
      : "Running in DRY-RUN mode — nothing will be written. Pass --apply to write.",
  );

  const index = await buildCustomerIndex(stripe);
  log(`Indexed ${index.size} distinct userId(s) across all Stripe customers.`);

  const existingState = await buildExistingStateIndex(admin);
  log(`Found ${existingState.size} existing subscription_state row(s).`);

  const summary: ReconciliationSummary = {
    reconciled: 0,
    unchanged: 0,
    noStripeCustomer: 0,
    ambiguous: 0,
    error: 0,
    flagged: [],
  };

  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      throw new Error(`Could not list Supabase users: ${error.message}`);
    }
    if (data.users.length === 0) break;

    for (const user of data.users) {
      const customers = index.get(user.id);
      let outcome: Outcome;
      try {
        outcome = customers
          ? await computeStateForCustomers(customers, stripe)
          : { kind: "no_stripe_customer" };
      } catch (err) {
        outcome = { kind: "error", error: err instanceof Error ? err.message : String(err) };
      }

      const existing = existingState.get(user.id);

      if (outcome.kind === "no_stripe_customer") {
        // Expected for the vast majority of users (never subscribed) — but
        // if this user already has a subscription_state row claiming a
        // plan/status, that's suspicious (their Stripe customer/
        // subscription vanished, or was deleted, or was never really
        // there) rather than simply "never subscribed." Flag it instead
        // of silently leaving stale state untouched — never guess which
        // is right.
        if (existing) {
          summary.ambiguous++;
          summary.flagged.push(
            `${user.id} (${user.email ?? "no email"}): no matching Stripe customer/subscription found, but subscription_state already claims plan=${existing.plan ?? "null"} status=${existing.subscriptionStatus} — left untouched, needs manual review.`,
          );
          continue;
        }
        summary.noStripeCustomer++;
        continue; // expected for the majority of users — nothing to reconcile
      }
      if (outcome.kind === "error") {
        summary.error++;
        log(`[error] user ${user.id} (${user.email ?? "no email"}): ${outcome.error}`);
        continue;
      }
      if (outcome.kind === "ambiguous") {
        summary.ambiguous++;
        summary.flagged.push(`${user.id} (${user.email ?? "no email"}): ${outcome.reason}`);
        continue;
      }

      // outcome.kind === "reconciled"
      const unchanged =
        existing?.plan === outcome.state.plan &&
        existing?.subscriptionStatus === outcome.state.subscriptionStatus &&
        existing?.stripeCustomerId === outcome.state.stripeCustomerId;
      if (unchanged) {
        summary.unchanged++;
        continue;
      }

      log(
        `[${apply ? "apply" : "dry-run"}] user ${user.id} (${user.email ?? "no email"}): ` +
          `plan ${existing?.plan ?? "null"} -> ${outcome.state.plan}, ` +
          `status ${existing?.subscriptionStatus ?? "null"} -> ${outcome.state.subscriptionStatus}`,
      );

      if (!apply) {
        summary.reconciled++;
        continue;
      }

      // Claim-fenced, re-fetches fresh at write time — see
      // reconcileOneUser's own comment. `customers` (the bulk-pass
      // customer list for this user) is passed through only to tell the
      // fresh re-check which Stripe customer objects to look at; it is
      // never itself written.
      const writeResult = await reconcileOneUser(admin, stripe, user.id, customers ?? []);
      if (writeResult.kind === "claim_unavailable") {
        log(
          `  -> could not acquire the write claim for user ${user.id} (another process may be using it right now) — skipped, safe to retry on a future run.`,
        );
        summary.error++;
        continue;
      }
      if (writeResult.kind === "write_rejected") {
        log(
          `  -> write_authoritative_subscription_state rejected the write for user ${user.id} (claim lost or RPC error) — skipped, safe to retry on a future run.`,
        );
        summary.error++;
        continue;
      }
      if (writeResult.kind === "stale_at_write_time") {
        log(
          `  -> state for user ${user.id} changed between the bulk pass and the write (${writeResult.detail}) — skipped rather than writing a decision that's no longer current; will be re-derived correctly on the next run.`,
        );
        summary.error++;
        continue;
      }
      if (writeResult.kind === "error") {
        log(`  -> write failed for user ${user.id}: ${writeResult.error}`);
        summary.error++;
        continue;
      }
      // writeResult.kind === "written" — writeSubscriptionState already
      // performed the best-effort app_metadata mirror internally; no
      // separate mirror call needed here.
      summary.reconciled++;
    }

    if (data.users.length < 200) break;
    page++;
  }

  log("\n--- Summary ---");
  log(`Reconciled (changed): ${summary.reconciled}`);
  log(`Already correct (unchanged): ${summary.unchanged}`);
  log(`No Stripe customer (free users, expected): ${summary.noStripeCustomer}`);
  log(`Flagged for manual review (ambiguous): ${summary.ambiguous}`);
  log(`Errors: ${summary.error}`);
  if (summary.flagged.length > 0) {
    log("\nFlagged accounts — resolve manually, do not guess:");
    for (const line of summary.flagged) log(`  - ${line}`);
  }
  if (!apply && summary.reconciled > 0) {
    log("\nThis was a dry run. Re-run with --apply to write these changes.");
  }

  return summary;
}

async function main() {
  const SUPABASE_URL = requireEnv("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const STRIPE_SECRET_KEY = requireEnv("STRIPE_SECRET_KEY");

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const stripe = new Stripe(STRIPE_SECRET_KEY);

  await runReconciliation({ admin, stripe, apply: APPLY });
}

// Only run main() when this file is executed directly (`bun run
// scripts/reconcile-subscription-metadata.ts`), not when it's imported by
// the test file — importing it must never require real env vars or touch
// real Stripe/Supabase.
if (import.meta.main) {
  main().catch((err) => {
    console.error("Reconciliation script failed:", err);
    process.exit(1);
  });
}
