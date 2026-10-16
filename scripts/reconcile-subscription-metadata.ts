// One-time (re-runnable) reconciliation / backfill for the 2026-10
// security-audit fix. Subscription state has moved twice: first from
// client-writable `user_metadata` to service-role-only `app_metadata`,
// and now (this revision) from `app_metadata` to the authoritative
// `subscription_state` table (0023_subscription_state.sql) — written
// going forward only via write_authoritative_subscription_state's atomic,
// claim-fenced Postgres function (see api.stripe.webhook.tsx). This
// script does NOT go through that function: it's a one-time, offline
// batch backfill, not a live webhook delivery racing concurrent workers,
// so it writes subscription_state directly via the service-role client
// (which bypasses RLS) rather than needing a claim token.
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

import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { resolvePlanFromSubscription } from "../src/lib/stripe-server";

const APPLY = process.argv.includes("--apply");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const STRIPE_SECRET_KEY = requireEnv("STRIPE_SECRET_KEY");

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const stripe = new Stripe(STRIPE_SECRET_KEY);

export type ComputedState = {
  plan: "solo" | "crew" | null;
  subscriptionStatus: string | null;
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
async function buildCustomerIndex(): Promise<Map<string, Stripe.Customer[]>> {
  const index = new Map<string, Stripe.Customer[]>();
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.customers.list({
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
async function buildExistingStateIndex(): Promise<Map<string, ComputedState>> {
  const index = new Map<string, ComputedState>();
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    const { data, error } = await admin
      .from("subscription_state")
      .select("user_id, plan, subscription_status, stripe_customer_id")
      .range(from, from + pageSize - 1);
    if (error) {
      console.error("Could not read existing subscription_state rows:", error.message);
      process.exit(1);
    }
    for (const row of data ?? []) {
      index.set(row["user_id"] as string, {
        plan: row["plan"] as "solo" | "crew" | null,
        subscriptionStatus: row["subscription_status"] as string | null,
        stripeCustomerId: row["stripe_customer_id"] as string,
      });
    }
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return index;
}

// Best-effort, non-blocking mirror into app_metadata — same posture as
// api.stripe.webhook.tsx's mirrorToAppMetadata. Never affects the script's
// own success/failure accounting; a mirror failure is logged and ignored.
async function mirrorToAppMetadata(
  userId: string,
  existingAppMetadata: Record<string, unknown> | null | undefined,
  state: ComputedState,
): Promise<void> {
  const { error } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: {
      ...existingAppMetadata,
      plan: state.plan,
      subscriptionStatus: state.subscriptionStatus,
      stripeCustomerId: state.stripeCustomerId,
    },
  });
  if (error) {
    console.error(
      `  -> app_metadata mirror failed for user ${userId} (non-authoritative, ignored): ${error.message}`,
    );
  }
}

async function main() {
  console.log(
    APPLY
      ? "Running in APPLY mode — subscription_state WILL be written (plus a best-effort app_metadata mirror)."
      : "Running in DRY-RUN mode — nothing will be written. Pass --apply to write.",
  );

  const index = await buildCustomerIndex();
  console.log(`Indexed ${index.size} distinct userId(s) across all Stripe customers.`);

  const existingState = await buildExistingStateIndex();
  console.log(`Found ${existingState.size} existing subscription_state row(s).`);

  const counts = { reconciled: 0, no_stripe_customer: 0, ambiguous: 0, error: 0, unchanged: 0 };
  const flagged: string[] = [];

  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      console.error("Could not list Supabase users:", error.message);
      process.exit(1);
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
        if (existing && (existing.plan != null || existing.subscriptionStatus != null)) {
          counts.ambiguous++;
          flagged.push(
            `${user.id} (${user.email ?? "no email"}): no matching Stripe customer/subscription found, but subscription_state already claims plan=${existing.plan ?? "null"} status=${existing.subscriptionStatus ?? "null"} — left untouched, needs manual review.`,
          );
          continue;
        }
        counts.no_stripe_customer++;
        continue; // expected for the majority of users — nothing to reconcile
      }
      if (outcome.kind === "error") {
        counts.error++;
        console.error(`[error] user ${user.id} (${user.email ?? "no email"}): ${outcome.error}`);
        continue;
      }
      if (outcome.kind === "ambiguous") {
        counts.ambiguous++;
        flagged.push(`${user.id} (${user.email ?? "no email"}): ${outcome.reason}`);
        continue;
      }

      // outcome.kind === "reconciled"
      const unchanged =
        existing?.plan === outcome.state.plan &&
        existing?.subscriptionStatus === outcome.state.subscriptionStatus &&
        existing?.stripeCustomerId === outcome.state.stripeCustomerId;
      if (unchanged) {
        counts.unchanged++;
        continue;
      }

      counts.reconciled++;
      console.log(
        `[${APPLY ? "apply" : "dry-run"}] user ${user.id} (${user.email ?? "no email"}): ` +
          `plan ${existing?.plan ?? "null"} -> ${outcome.state.plan}, ` +
          `status ${existing?.subscriptionStatus ?? "null"} -> ${outcome.state.subscriptionStatus}`,
      );

      if (APPLY) {
        const { error: writeError } = await admin.from("subscription_state").upsert({
          user_id: user.id,
          plan: outcome.state.plan,
          subscription_status: outcome.state.subscriptionStatus,
          stripe_customer_id: outcome.state.stripeCustomerId,
          updated_at: new Date().toISOString(),
        });
        if (writeError) {
          console.error(`  -> write failed: ${writeError.message}`);
          counts.error++;
          counts.reconciled--;
          continue;
        }
        await mirrorToAppMetadata(user.id, user.app_metadata, outcome.state);
      }
    }

    if (data.users.length < 200) break;
    page++;
  }

  console.log("\n--- Summary ---");
  console.log(`Reconciled (changed): ${counts.reconciled}`);
  console.log(`Already correct (unchanged): ${counts.unchanged}`);
  console.log(`No Stripe customer (free users, expected): ${counts.no_stripe_customer}`);
  console.log(`Flagged for manual review (ambiguous): ${counts.ambiguous}`);
  console.log(`Errors: ${counts.error}`);
  if (flagged.length > 0) {
    console.log("\nFlagged accounts — resolve manually, do not guess:");
    for (const line of flagged) console.log(`  - ${line}`);
  }
  if (!APPLY && counts.reconciled > 0) {
    console.log("\nThis was a dry run. Re-run with --apply to write these changes.");
  }
}

main().catch((err) => {
  console.error("Reconciliation script failed:", err);
  process.exit(1);
});
