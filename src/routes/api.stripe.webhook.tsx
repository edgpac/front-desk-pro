import { randomUUID } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";

import { resolvePlanFromSubscription } from "@/lib/stripe-server";
import { recordAuditLog } from "@/lib/audit-log-server";

type Plan = "solo" | "crew";

function getAdminClient() {
  const supabaseUrl = process.env["SUPABASE_URL"];
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Every event below needs to resolve back to a Supabase user id. Subscription
// events carry it directly, stamped at creation time
// (createCheckoutSession's subscription_data.metadata) — that's tried first
// since it needs no extra API call. Anything without it (invoices, plan
// changes made via the Stripe portal, or a subscription that predates this
// change) falls
// back to the Stripe Customer's own metadata.userId, set once when the
// customer is first created — never re-derived from email, which isn't
// guaranteed stable/unique the way a Stripe id is.
async function resolveUserId(
  stripe: Stripe,
  customerId: string | Stripe.Customer | Stripe.DeletedCustomer | null,
  subscriptionMetadataUserId?: string,
): Promise<string | null> {
  if (subscriptionMetadataUserId) return subscriptionMetadataUserId;
  if (!customerId) return null;
  const id = typeof customerId === "string" ? customerId : customerId.id;
  const customer = await stripe.customers.retrieve(id);
  if (customer.deleted) return null;
  return (customer.metadata?.["userId"] as string | undefined) ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-user write serialization. Two problems fixed across three review
// passes, both still relevant to read before touching this:
//
// 1. (2nd pass) Fails SAFE, not open: exhausting the claim throws
//    LockUnavailableError rather than proceeding unprotected. The route
//    handler turns this into a 503 so Stripe retries later.
// 2. (2nd pass) release() only succeeds if the caller's claim_token still
//    matches the row — a holder whose claim was stolen for being stale
//    can't delete the new holder's claim on its own later release.
//
// A third problem, found in review of passes 1-2: ownership was checked
// only ONCE, at acquisition — nothing re-checked it immediately before the
// actual write. If a holder's claim goes stale and is stolen WHILE it's
// stuck in a slow Stripe re-fetch, the dispossessed holder would still go
// on to write its own stale result afterward, right over the new holder's
// correct one. See renewClaim and writeSubscriptionState's own comment for
// the fix (fencing at the write boundary, not just at acquisition).
export class LockUnavailableError extends Error {}

// Thrown when a claim that WAS successfully acquired is found to no longer
// be held at the moment just before the write — i.e. it was stolen for
// being stale while this caller was doing its (possibly slow)
// fetchCurrentTruth work. Distinct from LockUnavailableError (which means
// "never got the claim at all") for clearer logs/tests, but both are
// handled identically by the route handler: fail safe, ask Stripe to
// retry.
export class ClaimLostError extends Error {}

const CLAIM_MAX_ATTEMPTS = 5;
const CLAIM_RETRY_DELAY_MS = 300;

// Throws LockUnavailableError (never returns "proceed anyway") if the slot
// cannot be acquired within the retry budget — including when the claim
// RPC itself errors every time, which is exactly what happens if migration
// 0021 hasn't been applied yet (the function won't exist). See "Deployment
// order" in the report: this is deliberate — an unapplied migration must
// make every webhook delivery fail safely (retryable), never silently fall
// back to unprotected processing.
export async function acquireClaimOrThrow(admin: SupabaseClient, userId: string): Promise<string> {
  const claimToken = randomUUID();
  for (let attempt = 1; attempt <= CLAIM_MAX_ATTEMPTS; attempt++) {
    const { data, error } = await admin.rpc("claim_stripe_webhook_slot", {
      p_user_id: userId,
      p_claim_token: claimToken,
    });
    if (error) {
      console.error(
        `Stripe webhook: claim_stripe_webhook_slot error (attempt ${attempt}/${CLAIM_MAX_ATTEMPTS}):`,
        error.message,
      );
    } else if (data) {
      return claimToken;
    }
    if (attempt < CLAIM_MAX_ATTEMPTS) await sleep(CLAIM_RETRY_DELAY_MS);
  }
  throw new LockUnavailableError(
    `Could not acquire the subscription-state claim for user ${userId} after ${CLAIM_MAX_ATTEMPTS} attempts.`,
  );
}

export async function releaseClaim(
  admin: SupabaseClient,
  userId: string,
  claimToken: string,
): Promise<void> {
  const { error } = await admin.rpc("release_stripe_webhook_slot", {
    p_user_id: userId,
    p_claim_token: claimToken,
  });
  if (error) {
    console.error("Stripe webhook: release_stripe_webhook_slot failed:", error.message);
  }
}

// 2026-10 fifth-pass review: closes the write-boundary race the fourth
// pass found and explicitly did not claim to have closed. The previous
// design's fencing check (renewClaim) was a check performed in
// application code, immediately before, but still separate from, the
// actual write — and ownership could change in the gap between a
// successful renewal and the GoTrue Admin API calls that followed it.
//
// write_authoritative_subscription_state (0023_subscription_state.sql)
// removes that gap structurally rather than narrowing it further: the
// ownership check and the authoritative write now happen inside ONE
// Postgres function call, under a row lock held for its entire duration.
// A worker that no longer owns the claim cannot write — not "is very
// unlikely to," cannot, because the check and the write are the same
// atomic operation. See that migration's own comment for the exact
// mechanism (SELECT ... FOR UPDATE).
async function writeAuthoritativeSubscriptionState(
  admin: SupabaseClient,
  userId: string,
  claimToken: string,
  current: {
    plan?: Plan | null;
    subscriptionStatus: string;
    stripeCustomerId?: string | undefined;
  },
): Promise<boolean> {
  const { data, error } = await admin.rpc("write_authoritative_subscription_state", {
    p_user_id: userId,
    p_claim_token: claimToken,
    p_plan: current.plan ?? null,
    p_subscription_status: current.subscriptionStatus,
    p_stripe_customer_id: current.stripeCustomerId ?? null,
  });
  if (error) {
    throw new AuthoritativeWriteError(
      `write_authoritative_subscription_state failed for user ${userId}: ${error.message}`,
    );
  }
  return Boolean(data);
}

// Thrown when the atomic write RPC itself errors (e.g. migration 0023 not
// applied, a transient Postgres error) — distinct from ClaimLostError
// (which means the RPC succeeded and told us, correctly, that we no
// longer own the claim). Both are handled identically by the route
// handler (fail safe, ask Stripe to retry), but kept as separate classes
// for clearer logs and tests.
export class AuthoritativeWriteError extends Error {}

// Best-effort compatibility mirror into app_metadata — explicitly NON-
// authoritative. Written only so the Supabase Auth dashboard's own user
// view (which surfaces app_metadata, not this app's tables) has something
// to show a human operator; nothing in this codebase reads it for an
// entitlement decision anymore (see entitlements-server.ts,
// stripe-server.ts). Every failure mode here is caught and logged, never
// thrown — a mirror failure must never affect whether a real user is
// correctly entitled, which is now decided entirely by
// subscription_state.
async function mirrorToAppMetadata(
  admin: SupabaseClient,
  userId: string,
  current: {
    plan?: Plan | null;
    subscriptionStatus: string;
    stripeCustomerId?: string | undefined;
  },
): Promise<void> {
  try {
    const { data: existing, error: readError } = await admin.auth.admin.getUserById(userId);
    if (readError || !existing?.user) {
      console.error(
        `Stripe webhook: compatibility mirror could not read user ${userId} (non-authoritative, ignored):`,
        readError,
      );
      return;
    }
    const { error } = await admin.auth.admin.updateUserById(userId, {
      app_metadata: {
        ...existing.user.app_metadata,
        ...(current.plan !== undefined ? { plan: current.plan } : {}),
        subscriptionStatus: current.subscriptionStatus,
        ...(current.stripeCustomerId ? { stripeCustomerId: current.stripeCustomerId } : {}),
      },
    });
    if (error) {
      console.error(
        `Stripe webhook: compatibility mirror write failed for user ${userId} (non-authoritative, ignored):`,
        error.message,
      );
    }
  } catch (err) {
    console.error(
      `Stripe webhook: compatibility mirror threw unexpectedly for user ${userId} (non-authoritative, ignored):`,
      err,
    );
  }
}

// Ordering strategy (unchanged from the fourth pass): fetchCurrentTruth
// re-fetches the subscription's (or invoice's underlying subscription's)
// CURRENT state directly from Stripe at the moment it runs — never
// whatever snapshot happened to be embedded in a particular webhook
// payload. Stripe's own state only moves forward in real time, so "ask
// Stripe what's true right now" is sufficient for ordering correctness
// given the atomic write below. No event timestamp is compared anywhere
// in this function.
export async function writeSubscriptionState(
  admin: SupabaseClient,
  userId: string,
  fetchCurrentTruth: () => Promise<{
    plan?: Plan | null;
    subscriptionStatus: string;
    stripeCustomerId?: string | undefined;
  }>,
): Promise<void> {
  const claimToken = await acquireClaimOrThrow(admin, userId); // throws LockUnavailableError — never fails open
  try {
    const current = await fetchCurrentTruth();

    // The authoritative write. Keep the external Supabase Admin API out
    // of this path entirely — this is a single Postgres RPC call, atomic
    // with the ownership check, never an HTTP call to GoTrue.
    const written = await writeAuthoritativeSubscriptionState(admin, userId, claimToken, current);
    if (!written) {
      throw new ClaimLostError(
        `Lost ownership of the subscription-state claim for user ${userId} — write_authoritative_subscription_state rejected it (another worker has taken over).`,
      );
    }

    // Secondary, best-effort, explicitly non-authoritative. Runs only
    // after the real write already succeeded, and can never undo it or
    // block on it.
    await mirrorToAppMetadata(admin, userId, current);
    await recordSubscriptionAuditLog(admin, userId, current);
  } finally {
    await releaseClaim(admin, userId, claimToken);
  }
}

// Same best-effort, non-blocking posture as mirrorToAppMetadata: resolves
// the owning tenant (subscription_state is keyed by Supabase userId, audit_log
// by tenant_id — see 0027's own comment for why) and records the change.
// Every failure here is caught and logged, never thrown — a missing tenant
// row or an unapplied 0027 migration must never affect the real,
// authoritative write that already succeeded above it.
async function recordSubscriptionAuditLog(
  admin: SupabaseClient,
  userId: string,
  current: {
    plan?: Plan | null;
    subscriptionStatus: string;
    stripeCustomerId?: string | undefined;
  },
): Promise<void> {
  try {
    const { data: tenantRow } = await admin
      .from("tenants")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();
    const tenantId = (tenantRow as { id: string } | null)?.id;
    if (!tenantId) return;
    await recordAuditLog(admin, {
      tenantId,
      actorType: "system",
      action: "subscription.state_changed",
      targetType: "subscription",
      targetId: userId,
      metadata: { plan: current.plan ?? null, subscriptionStatus: current.subscriptionStatus },
    });
  } catch (err) {
    console.error(
      `[audit_log] tenant lookup for subscription change failed for user ${userId}:`,
      err,
    );
  }
}

// Durable event-processing lifecycle (0022_stripe_processed_events.sql).
// See that migration's own comment for the full state machine; summary:
// 'claimed' means proceed with the real work, 'duplicate_completed' means
// already fully done (safe no-op, return 200), 'duplicate_processing'
// means someone else is actively working on it right now within its
// lease (do not run the work ourselves — return a retryable response and
// rely on Stripe's own redelivery of this SAME event, not an unrelated
// future one, to check again later).
//
// p_lease_token (generated fresh per request, randomUUID()) is this
// request's own fencing token for THIS event — required by
// completeStripeEvent/failStripeEvent below. 4th-pass fix: without it, a
// worker whose event lease expired while it was still (slowly) running —
// and which therefore got reclaimed by a newer delivery — could still
// later call complete/fail and have it succeed, potentially stamping a
// stale outcome (e.g. a late "completed" landing after the real,
// current attempt already correctly recorded "failed") over the
// authoritative one.
export type StripeEventClaimResult = "claimed" | "duplicate_completed" | "duplicate_processing";

export async function claimStripeEvent(
  admin: SupabaseClient,
  eventId: string,
  leaseToken: string,
): Promise<StripeEventClaimResult> {
  const { data, error } = await admin.rpc("claim_stripe_event", {
    p_event_id: eventId,
    p_lease_token: leaseToken,
  });
  if (error) {
    throw new Error(`Could not claim Stripe event ${eventId}: ${error.message}`);
  }
  return data as StripeEventClaimResult;
}

// Returns false (never throws on its own for this case) when leaseToken no
// longer matches the row — this worker was reclaimed out from under it by
// a newer attempt, and must not be treated as having actually finalized
// the event; the caller must not report success to Stripe in that case.
// Throws on a genuine RPC error (can't even confirm whether it succeeded),
// which the caller should treat as a processing failure, not a success.
export async function completeStripeEvent(
  admin: SupabaseClient,
  eventId: string,
  leaseToken: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("complete_stripe_event", {
    p_event_id: eventId,
    p_lease_token: leaseToken,
  });
  if (error) {
    throw new Error(`Could not mark Stripe event ${eventId} completed: ${error.message}`);
  }
  return Boolean(data);
}

// Marks this attempt as abandoned so the NEXT delivery of the same event
// can reclaim it immediately, without waiting out the full lease — used
// for any genuine processing failure (a transient Stripe API error, a
// Supabase error, ClaimLostError, LockUnavailableError), never for "this
// event type isn't one we act on" (that's completeStripeEvent — there's
// nothing to retry there, retrying changes nothing). Returns false (same
// token-ownership reasoning as completeStripeEvent) if this worker was
// already reclaimed by someone else — in that case the newer attempt, not
// this stale one, is responsible for the event's final status, and this
// call correctly has no effect. Never throws — this is already inside the
// route's outermost failure handling, and a secondary error here must not
// prevent returning a response.
export async function failStripeEvent(
  admin: SupabaseClient,
  eventId: string,
  leaseToken: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("fail_stripe_event", {
    p_event_id: eventId,
    p_lease_token: leaseToken,
  });
  if (error) {
    console.error(`Stripe webhook: fail_stripe_event failed for ${eventId}:`, error.message);
    return false;
  }
  return Boolean(data);
}

function retryableResponse(errorCode: string): Response {
  return new Response(JSON.stringify({ error: errorCode }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
}

function okResponse(body: Record<string, unknown> = { received: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Used at every "we're done, nothing more to do" point — success, or an
// unfixable data problem (no userId, unhandled event type). Checks
// completeStripeEvent's return value rather than assuming it succeeded:
// if this worker was reclaimed by a newer attempt in the (small) window
// since claimStripeEvent, it must not tell Stripe "received: true" —
// that would falsely claim an outcome this attempt no longer has the
// authority to report. Asking Stripe to retry in that case defers to
// whichever attempt (the reclaiming one) actually finalizes the event.
async function finishEvent(
  admin: SupabaseClient,
  eventId: string,
  leaseToken: string,
  eventType: string,
): Promise<Response> {
  const completed = await completeStripeEvent(admin, eventId, leaseToken);
  if (!completed) {
    console.error(
      `Stripe webhook (${eventType}): event ${eventId} was reclaimed by a newer attempt before this one could mark it completed — asking Stripe to retry so the authoritative attempt's own outcome prevails.`,
    );
    return retryableResponse("event_reclaimed");
  }
  return okResponse();
}

// A genuine raw HTTP endpoint (not a createServerFn) — Stripe's servers POST
// here directly, and signature verification needs the exact raw request
// body, which the createServerFn RPC layer isn't built to hand over.
export const Route = createFileRoute("/api/stripe/webhook")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const stripeSecretKey = process.env["STRIPE_SECRET_KEY"];
        const webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];
        if (!stripeSecretKey || !webhookSecret) {
          console.error(
            "Stripe webhook received but STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET aren't set.",
          );
          return new Response("Webhook not configured", { status: 500 });
        }

        const signature = request.headers.get("stripe-signature");
        const rawBody = await request.text();
        if (!signature) {
          return new Response("Missing stripe-signature header", { status: 400 });
        }

        const stripe = new Stripe(stripeSecretKey);
        let event: Stripe.Event;
        try {
          event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
        } catch (err) {
          console.error("Stripe webhook signature verification failed:", err);
          return new Response("Invalid signature", { status: 400 });
        }

        const admin = getAdminClient();
        if (!admin) {
          // Previously returned 200 here, which would have silently
          // dropped every webhook forever in a misconfigured deployment.
          // Fails safe instead: Stripe retries once the deployment is
          // fixed.
          console.error(
            `Stripe webhook (${event.type}) received but Supabase admin client isn't configured — asking Stripe to retry.`,
          );
          return retryableResponse("admin_client_unavailable");
        }

        // Durable event-lifecycle claim, before any Stripe API call or
        // per-user lock — see claimStripeEvent's own comment. A genuine
        // failure here (e.g. migration 0022 not applied) fails safely:
        // 503, so Stripe retries later, rather than guessing. leaseToken
        // is this request's own fencing token, threaded through every
        // completeStripeEvent/failStripeEvent call below.
        const leaseToken = randomUUID();
        let claimResult: StripeEventClaimResult;
        try {
          claimResult = await claimStripeEvent(admin, event.id, leaseToken);
        } catch (err) {
          console.error(
            `Stripe webhook (${event.type}): event claim failed, asking Stripe to retry:`,
            err,
          );
          return retryableResponse("event_claim_failed");
        }

        if (claimResult === "duplicate_completed") {
          console.error(
            `Stripe webhook (${event.type}): event ${event.id} already completed, skipping.`,
          );
          return okResponse({ received: true, duplicate: true });
        }
        if (claimResult === "duplicate_processing") {
          // Another delivery of this same event is actively being worked
          // on right now, within its lease. Never run the work ourselves
          // in parallel — ask Stripe to retry; by then the other attempt
          // will either have completed (next delivery sees
          // duplicate_completed) or its lease will have expired (next
          // delivery reclaims and retries it). Either way, recovery comes
          // from Stripe's own redelivery of this SAME event id, never
          // from some unrelated future event.
          console.error(
            `Stripe webhook (${event.type}): event ${event.id} already being processed, asking Stripe to retry.`,
          );
          return retryableResponse("event_already_processing");
        }

        // claimResult === "claimed": we are the one responsible for this
        // event right now. Every path below must end by marking it
        // 'completed' (success, or nothing to do) or 'failed' (a genuine
        // error, reclaimable by the next delivery without waiting out the
        // lease) — never leave it hanging, and never mark 'completed'
        // on anything less than full success, per "a temporary Stripe API
        // failure does not permanently mark an event completed."
        try {
          if (event.type === "checkout.session.completed") {
            const session = event.data.object as Stripe.Checkout.Session;
            const userId = session.client_reference_id || session.metadata?.["userId"];
            const sessionPlan = session.metadata?.["plan"] as Plan | undefined;

            if (!userId) {
              console.error(
                "Checkout completed but no userId on the session — can't attach a plan.",
              );
              return await finishEvent(admin, event.id, leaseToken, event.type); // unfixable by retrying — nothing more to do
            }

            await writeSubscriptionState(admin, userId, async () => {
              // Checkout completing doesn't always mean the subscription is
              // immediately active (e.g. a card requiring 3D Secure can leave
              // it "incomplete") — fetch the real, current subscription
              // instead of assuming "active".
              let status = "active";
              let plan: Plan | null = sessionPlan ?? null;
              if (typeof session.subscription === "string") {
                const fresh = await stripe.subscriptions.retrieve(session.subscription);
                status = fresh.status;
                plan = resolvePlanFromSubscription(fresh) ?? plan;
              }
              return {
                plan,
                subscriptionStatus: status,
                stripeCustomerId:
                  typeof session.customer === "string" ? session.customer : undefined,
              };
            });
          } else if (
            event.type === "customer.subscription.updated" ||
            event.type === "customer.subscription.created"
          ) {
            // Covers renewals settling back to "active", a failed renewal
            // moving to "past_due"/"unpaid", a plan change (Solo <-> Crew,
            // made via the Stripe billing portal), and a cancellation
            // scheduled for period end (status stays "active" until it
            // actually ends — see .deleted).
            const subscription = event.data.object as Stripe.Subscription;
            const userId = await resolveUserId(
              stripe,
              subscription.customer,
              subscription.metadata?.["userId"],
            );
            if (!userId) {
              console.error(
                `Stripe webhook (${event.type}): could not resolve a userId for subscription`,
                subscription.id,
              );
              return await finishEvent(admin, event.id, leaseToken, event.type);
            }

            await writeSubscriptionState(admin, userId, async () => {
              // Re-fetch rather than trust event.data.object — see
              // writeSubscriptionState's "Ordering strategy" note.
              const fresh = await stripe.subscriptions.retrieve(subscription.id);
              return { plan: resolvePlanFromSubscription(fresh), subscriptionStatus: fresh.status };
            });
          } else if (event.type === "customer.subscription.deleted") {
            // The subscription has actually ended (immediate cancellation,
            // or the end of a period that was set to cancel). Plan is left
            // as the last known value (fetchCurrentTruth omits `plan`) —
            // only subscriptionStatus gates entitlements (see
            // entitlements-server.ts), so this alone is enough to revoke
            // access.
            const subscription = event.data.object as Stripe.Subscription;
            const userId = await resolveUserId(
              stripe,
              subscription.customer,
              subscription.metadata?.["userId"],
            );
            if (!userId) {
              console.error(
                "Stripe webhook (subscription.deleted): could not resolve a userId for subscription",
                subscription.id,
              );
              return await finishEvent(admin, event.id, leaseToken, event.type);
            }

            await writeSubscriptionState(admin, userId, async () => {
              const fresh = await stripe.subscriptions.retrieve(subscription.id);
              return { subscriptionStatus: fresh.status };
            });
          } else if (event.type === "invoice.payment_failed") {
            // Fires immediately on a failed renewal charge, ahead of (and
            // redundantly with) the subscription.updated that follows —
            // handled here too so access is revoked as soon as possible
            // rather than waiting on a second event to arrive.
            const invoice = event.data.object as Stripe.Invoice;
            const userId = await resolveUserId(stripe, invoice.customer);
            if (!userId) {
              console.error(
                "Stripe webhook (invoice.payment_failed): could not resolve a userId for invoice",
                invoice.id,
              );
              return await finishEvent(admin, event.id, leaseToken, event.type);
            }

            // Newer Stripe API shape: an invoice's subscription link lives
            // under parent.subscription_details.subscription, not a flat
            // invoice.subscription field (which doesn't exist on this SDK
            // version's Invoice type — tsc caught this during review).
            const linkedSubscription = invoice.parent?.subscription_details?.subscription;
            const subscriptionId =
              typeof linkedSubscription === "string" ? linkedSubscription : linkedSubscription?.id;

            await writeSubscriptionState(admin, userId, async () => {
              // Prefer the subscription's own current status over hard-
              // coding "past_due" from the invoice-failure event alone —
              // by the time this runs, Stripe's dunning process may have
              // already moved the subscription further (e.g. to
              // "canceled" or back to "active" on a late successful
              // retry).
              if (subscriptionId) {
                const fresh = await stripe.subscriptions.retrieve(subscriptionId);
                return { subscriptionStatus: fresh.status };
              }
              return { subscriptionStatus: "past_due" };
            });
          }
          // Every event type we act on reached a successful
          // writeSubscriptionState call (or an earlier unfixable-data
          // early return already finished above). An event type not in
          // any branch above needs no work at all — also finished as
          // 'completed', not left hanging, so it's never redelivered
          // pointlessly.
          return await finishEvent(admin, event.id, leaseToken, event.type);
        } catch (err) {
          // Genuine failure while we were the ones actively responsible
          // for this event — mark it reclaimable immediately (don't make
          // the next delivery wait out the full lease) and ask Stripe to
          // retry. This covers LockUnavailableError, ClaimLostError, and
          // any other processing error (e.g. a transient Stripe API
          // failure) uniformly: none of these mean "permanently
          // unprocessable," so none of them get marked 'completed'.
          // failStripeEvent is guarded by its own try/catch: a secondary
          // failure marking this failed must not prevent us from still
          // returning a controlled, retryable response (rather than an
          // unhandled rejection the framework would turn into something
          // we don't control).
          try {
            await failStripeEvent(admin, event.id, leaseToken);
          } catch (failErr) {
            console.error(
              `Stripe webhook (${event.type}): also failed to mark event ${event.id} as failed:`,
              failErr,
            );
          }
          if (
            err instanceof LockUnavailableError ||
            err instanceof ClaimLostError ||
            err instanceof AuthoritativeWriteError
          ) {
            console.error(
              `Stripe webhook (${event.type}): ${err.message} — asking Stripe to retry.`,
            );
          } else {
            console.error(
              `Stripe webhook (${event.type}) processing failed, asking Stripe to retry:`,
              err,
            );
          }
          return retryableResponse("processing_failed");
        }
      },
    },
  },
});
