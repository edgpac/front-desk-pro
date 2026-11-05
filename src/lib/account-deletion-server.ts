import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getAdminClient } from "@/lib/public-lead-server";
import { getStripe, performCancelStripeSubscriptionForDeletion } from "@/lib/stripe-server";
import { performDisconnectMetaConnection } from "@/lib/meta-whatsapp-server";
import { computeAffectedProfileVersions } from "@/lib/whatsapp-import-server";
import { recordAuditLog } from "@/lib/audit-log-server";

// Settings > Data & Privacy (Phase 4A). Two separate, deliberately
// different-weight actions:
//
// - performDeleteCustomerData ("Delete All Customer Data"): removes leads,
//   lead messages/line items, and WhatsApp import history, but keeps the
//   subscriber's account, business settings, price sheet, WhatsApp
//   connection, and subscription untouched. Reversible in the sense that
//   the account still exists afterward — only customer records are gone.
//
// - performDeleteMyAccount ("Delete My Account Permanently"): the real,
//   irreversible account-deletion sequence from the Phase 4 audit's
//   Section 1/C finding ("no account-deletion flow exists; a naive one
//   would orphan a live Stripe subscription"). Cancels Stripe, disconnects
//   Meta, cleans up the one FK-less orphan risk (stripe_webhook_claims),
//   then deletes the Supabase Auth user — the existing on-delete-cascade
//   chain (auth.users -> tenants -> every tenant-scoped table, see every
//   migration since 0001_init.sql) removes everything else.
//
// Needs supabase/migrations/0035_account_deletion.sql applied before
// performDeleteMyAccount will work against a real database (the
// account_deletion_requests table and the widened audit_log action list
// both come from that migration) — NOT applied to production as part of
// this change; see this phase's final report for the exact SQL and why.
//
// Every DB-touching function below is a plain function wrapped in
// createServerOnlyFn, matching whatsapp-import-server.ts/communication-
// profile-server.ts's established pattern (a bare createServerFn can't be
// unit-tested in this harness).

// Same local, non-exported getTenantId copy every other *-server.ts file
// in this codebase has its own version of — no shared helper exists for
// this, by established convention.
async function getTenantId(
  supabase: Pick<SupabaseClient, "from">,
  userId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("tenants")
    .select("id")
    .eq("user_id", userId)
    .single();
  if (error || !data)
    throw new Error(`Could not load your business: ${error?.message ?? "no tenant found"}`);
  return data["id"] as string;
}

// ---------------------------------------------------------------------------
// Action A — Delete All Customer Data
// ---------------------------------------------------------------------------

export type DeleteCustomerDataResult = {
  ok: true;
  deletedLeads: number;
  deletedWhatsAppImports: number;
  // Communication profile versions whose evidence cites a now-deleted
  // WhatsApp import message — same disclosure this codebase already
  // surfaces for a single-import delete (see whatsapp-import-server.ts's
  // deleteWhatsAppImport), just computed across every import being bulk-
  // deleted here. Communication profiles themselves are deliberately NOT
  // deleted by this action — see the scope note below.
  affectedProfileVersions: number[];
};

// Scope decision, made explicit here rather than silently: of this
// tenant's data, the following are judgment calls, not mechanical
// consequences of "contains a customer's name or number":
//
// - whatsapp_opt_outs is PRESERVED, not deleted, even though it stores a
//   customer phone number. It's a consent-withdrawal record ("this number
//   asked not to be contacted again"), not an active conversation —
//   deleting it would risk the business re-contacting someone who
//   explicitly opted out, if that same number messages again later. That
//   real harm outweighs removing one phone number from a "delete my
//   customer data" action whose purpose is clearing conversation/lead
//   history, not revoking a customer's own prior request.
//
// - communication_profile_versions/_decisions are PRESERVED. They hold the
//   owner's own derived writing-style profile (tone, phrasing patterns) —
//   a business asset the owner built, analogous to price-sheet
//   configuration, not a customer record. They cite WhatsApp import
//   message ids as evidence, which IS customer-sourced, which is exactly
//   why this function still computes and reports affectedProfileVersions:
//   the owner should know which profile versions now have evidence
//   pointing at deleted messages, even though the versions themselves stay.
//
// - whatsapp_connections, whatsapp_templates, field_notes,
//   tenant_capabilities, price_sheet_items, subscription_state: business
//   configuration, not customer data — explicitly required to survive by
//   the brief, and none of them store end-customer PII.
//
// Deleted alongside leads/imports: whatsapp_interaction_events,
// whatsapp_loop_guards, whatsapp_human_takeovers, whatsapp_lead_claims —
// all phone-number-keyed operational state tied to live conversations.
// Once the underlying leads/imports are gone, this state has nothing left
// to guard or claim; keeping it serves no purpose and it still carries a
// customer phone number, so it goes. (whatsapp_processed_messages is not
// tenant-scoped at all — no tenant_id column — so it's out of scope here
// regardless; tenant_ai_usage/tenant_ip_usage are rate-limit counters, not
// customer records.)
//
// No durable retry-state table backs this action (contrast with
// performDeleteMyAccount below): everything it touches is this app's own
// database, with no non-idempotent external API call in the sequence — a
// crash partway through just means some tables are already empty on retry,
// which is a harmless no-op, not a double-charge or a double-delete risk.
export const performDeleteCustomerData = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    admin: SupabaseClient,
    tenantId: string,
    actorUserId: string,
  ): Promise<DeleteCustomerDataResult> => {
    const { data: importRows, error: importsListError } = await supabase
      .from("whatsapp_imports")
      .select("id")
      .eq("tenant_id", tenantId);
    if (importsListError) {
      throw new Error(`Could not list WhatsApp imports: ${importsListError.message}`);
    }
    const importIds = ((importRows ?? []) as Array<{ id: string }>).map((row) => row.id);

    // Computed BEFORE any delete — computeAffectedProfileVersions throws
    // (stopping this whole action before it changes anything) if a
    // profile version's shape can't be safely checked, same policy as the
    // single-import delete this mirrors.
    const affected = new Set<number>();
    for (const importId of importIds) {
      const versions = await computeAffectedProfileVersions(supabase, tenantId, importId);
      for (const version of versions) affected.add(version);
    }

    // Cascades lead_line_items and lead_messages (both `on delete cascade`
    // against leads.id in 0001_init.sql) — same guarantee deleteLeads
    // relies on for its bulk delete.
    const { error: leadsError, count: deletedLeads } = await supabase
      .from("leads")
      .delete({ count: "exact" })
      .eq("tenant_id", tenantId);
    if (leadsError) throw new Error(`Could not delete leads: ${leadsError.message}`);

    // Cascades whatsapp_import_messages (`on delete cascade` against
    // whatsapp_imports.id in 0033_whatsapp_imports.sql).
    const { error: importsDeleteError, count: deletedWhatsAppImports } = await supabase
      .from("whatsapp_imports")
      .delete({ count: "exact" })
      .eq("tenant_id", tenantId);
    if (importsDeleteError) {
      throw new Error(`Could not delete WhatsApp imports: ${importsDeleteError.message}`);
    }

    // Zero-access RLS tables (service-role only) — the admin client, not
    // the caller's RLS-scoped one, same as every other write to these
    // tables elsewhere in this codebase. Each checked and thrown on,
    // same as the two deletes above — a silently-swallowed failure here
    // would let this function report "customer_data.deleted" (and write
    // that exact audit log action) while phone-keyed customer records
    // actually remained.
    for (const table of [
      "whatsapp_interaction_events",
      "whatsapp_loop_guards",
      "whatsapp_human_takeovers",
      "whatsapp_lead_claims",
    ] as const) {
      const { error } = await admin.from(table).delete().eq("tenant_id", tenantId);
      if (error) throw new Error(`Could not delete ${table}: ${error.message}`);
    }

    const affectedProfileVersions = Array.from(affected).sort((a, b) => a - b);
    await recordAuditLog(admin, {
      tenantId,
      actorType: "owner",
      actorUserId,
      action: "customer_data.deleted",
      targetType: "tenant",
      targetId: tenantId,
      metadata: {
        deletedLeads: deletedLeads ?? 0,
        deletedWhatsAppImports: deletedWhatsAppImports ?? 0,
        affectedProfileVersions,
      },
    });

    return {
      ok: true,
      deletedLeads: deletedLeads ?? 0,
      deletedWhatsAppImports: deletedWhatsAppImports ?? 0,
      affectedProfileVersions,
    };
  },
);

export const deleteMyCustomerData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    return performDeleteCustomerData(context.supabase, getAdminClient(), tenantId, context.userId);
  });

// ---------------------------------------------------------------------------
// Action B — Delete My Account Permanently
// ---------------------------------------------------------------------------

type AccountDeletionRequestRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  status: "pending" | "failed";
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_cancelled_at: string | null;
  whatsapp_disconnect_attempted_at: string | null;
  whatsapp_disconnected_at: string | null;
  whatsapp_disconnect_error: string | null;
  failure_reason: string | null;
};

export class AccountDeletionInProgressError extends Error {
  constructor() {
    super("A deletion is already in progress for this account. Please wait and try again.");
    this.name = "AccountDeletionInProgressError";
  }
}

// ---------------------------------------------------------------------------
// Operator runbook — a request stuck in 'pending' (process crash mid-flight,
// not a normal failure, which always reaches markDeletionFailed and ends up
// 'failed' instead)
// ---------------------------------------------------------------------------
//
// 1. Identify it:
//      select * from account_deletion_requests
//      where status = 'pending' and updated_at < now() - interval '15 minutes';
//    No real invocation of performDeleteMyAccount runs anywhere near that
//    long (it's at most a handful of API calls) — a 'pending' row that old
//    is abandoned, not slow.
//
// 2. The row's own existence is the reassurance: tenant_id references
//    tenants ON DELETE CASCADE, so if deleteUser() had actually succeeded,
//    this row would already be gone. A 'pending' row still being here
//    means the one irreversible step never ran, no matter how far the rest
//    of the sequence got.
//
// 3. Recover with ONE statement — do not manually re-run Stripe/Meta/
//    deleteUser calls by hand, and do not delete the row:
//      update account_deletion_requests
//      set status = 'failed',
//          failure_reason = 'manually recovered from a stuck pending request on <date>'
//      where id = '<row id>' and status = 'pending';
//    This hands the row back to the EXISTING, already-reviewed checkpoint/
//    resume logic in claimOrResumeDeletionRequest below. Ask the owner to
//    click "Delete My Account Permanently" again: it will read this row's
//    own stripe_cancelled_at/whatsapp_disconnect_attempted_at columns and
//    skip whichever steps already completed, so Stripe is never asked to
//    cancel twice and Meta is never asked to disconnect twice — the same
//    guarantee an ordinary retry-after-failure already has, which is why
//    no separate recovery FUNCTION is needed here, only this procedure.
//
// A documented procedure is sufficient specifically because the recovery
// action (flip to 'failed', let the owner retry) delegates the actual
// "don't repeat a side effect" guarantee to code that already exists and
// is already tested — building a bespoke admin recovery endpoint would
// duplicate that guarantee, not strengthen it.

const UNIQUE_VIOLATION = "23505";
function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === UNIQUE_VIOLATION;
}

// Finds this tenant's in-flight (or previously failed) deletion request, or
// starts a new one — all inside this one function, so the "does one already
// exist" check and the row that gets acted on next are never two separate,
// racy steps from the caller's point of view. The database's own unique
// index (account_deletion_requests_tenant_inflight_idx, 'pending' rows only)
// is the actual concurrency guard; this function's own SELECT-then-INSERT
// is a fast path that avoids hitting that constraint on the common case,
// not a substitute for it — a genuine race between two concurrent calls is
// still resolved correctly by the index, just via the insert's error path
// below instead of the select's.
async function claimOrResumeDeletionRequest(
  admin: SupabaseClient,
  tenantId: string,
  userId: string,
): Promise<AccountDeletionRequestRow> {
  const { data: existing, error: selectError } = await admin
    .from("account_deletion_requests")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (selectError) {
    throw new Error(`Could not check for an in-progress deletion: ${selectError.message}`);
  }

  if (existing) {
    const row = existing as AccountDeletionRequestRow;
    if (row.status === "pending") {
      throw new AccountDeletionInProgressError();
    }
    // status === "failed": a retry. Reset to "pending" on the SAME row so
    // its recorded checkpoints (stripe_cancelled_at, etc.) are preserved —
    // resuming means skipping steps already marked done, never re-running
    // them.
    //
    // The `.eq("status", "failed")` here is load-bearing, not redundant
    // with the SELECT above: two concurrent calls can both read this same
    // row as "failed" before either writes. Postgres's own READ COMMITTED
    // UPDATE semantics re-check a row's WHERE clause against the latest
    // COMMITTED version if a concurrent transaction updated it first — so
    // the loser's UPDATE here matches zero rows (status is already
    // "pending" by the time it re-checks), instead of both callers
    // "successfully" resuming the same row and racing each other into
    // Stripe/Meta/deleteUser. Same fencing idea as 0021's claim_token and
    // 0023's `SELECT ... FOR UPDATE`, expressed as a plain conditional
    // UPDATE instead of a dedicated RPC, since a single-row UPDATE's own
    // MVCC behavior already provides it here.
    const { data: resumedRows, error: resumeError } = await admin
      .from("account_deletion_requests")
      .update({ status: "pending", failure_reason: null, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "failed")
      .select("*");
    if (resumeError) {
      throw new Error(`Could not resume your deletion request: ${resumeError.message}`);
    }
    if (!resumedRows || resumedRows.length === 0) {
      // Lost the race — another call already resumed (or is actively
      // working) this same failed request.
      throw new AccountDeletionInProgressError();
    }
    return resumedRows[0] as AccountDeletionRequestRow;
  }

  const { data: created, error: insertError } = await admin
    .from("account_deletion_requests")
    .insert({ tenant_id: tenantId, user_id: userId, status: "pending" })
    .select("*")
    .single();
  if (insertError) {
    if (isUniqueViolation(insertError)) throw new AccountDeletionInProgressError();
    throw new Error(`Could not start account deletion: ${insertError.message}`);
  }
  return created as AccountDeletionRequestRow;
}

// If THIS write itself fails, there is no further fallback within this
// function — it is already the failure-recording path, so retrying or
// escalating here risks masking the original failure with a new one.
// Logged loudly instead: a row that fails to flip to 'failed' stays
// 'pending' forever, which is exactly the "stuck request" case the
// operator runbook above already documents how to find and recover
// (the row's own existence still proves deleteUser never ran, so a
// manual recovery is safe regardless of why this particular write failed).
async function markDeletionFailed(
  admin: SupabaseClient,
  requestId: string,
  tenantId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const { error: markError } = await admin
    .from("account_deletion_requests")
    .update({ status: "failed", failure_reason: reason, updated_at: new Date().toISOString() })
    .eq("id", requestId);
  if (markError) {
    console.error(
      `[account-deletion] could not mark request ${requestId} (tenant=${tenantId}) as failed: ` +
        `${markError.message} — this row may be stuck in 'pending'; see the operator runbook above.`,
    );
  }
  await recordAuditLog(admin, {
    tenantId,
    actorType: "owner",
    actorUserId: userId,
    action: "account.deletion_failed",
    targetType: "tenant",
    targetId: tenantId,
    metadata: { reason },
  });
}

export type DeleteMyAccountResult = {
  ok: true;
  stripeCancelled: boolean;
  // null = there was never a WhatsApp connection to disconnect.
  whatsappDisconnected: boolean | null;
};

// The real deletion sequence: Stripe cancel -> Meta disconnect -> orphan
// cleanup -> Supabase Auth user delete -> (database cascade does the rest).
//
// Failure handling, per step:
// - Stripe cancellation failing ABORTS the whole sequence — the brief's own
//   explicit rule ("do not delete the Auth user if Stripe cancellation has
//   failed"), and the only one of these three external calls where
//   silently proceeding would leave a real, ongoing financial exposure
//   with no app record left to find it by (the Phase 4 audit's own
//   Section 1/C finding).
// - Meta disconnection failing does NOT abort — matches the existing,
//   already-shipped behavior of the owner-triggered disconnect button
//   (performDisconnectMetaConnection itself treats a Meta API failure as
//   non-fatal) — but is recorded truthfully in both the returned result
//   and the deletion-request row's whatsapp_disconnect_error column,
//   never silently reported as a success.
// - Auth-user deletion failing ABORTS and marks the request 'failed' for a
//   retry — it's the one irreversible step, so this function never treats
//   a failure there as anything but a hard stop.
//
// Safe to call again after a failure: claimOrResumeDeletionRequest resumes
// the same row, and each step below is skipped (not re-run) once its own
// checkpoint column is already set — Stripe is never asked to cancel an
// already-canceled subscription a second time, and Meta is never asked to
// disconnect an already-disconnected connection a second time.
export const performDeleteMyAccount = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    admin: SupabaseClient,
    stripe: Stripe,
    tenantId: string,
    userId: string,
  ): Promise<DeleteMyAccountResult> => {
    const request = await claimOrResumeDeletionRequest(admin, tenantId, userId);
    await recordAuditLog(admin, {
      tenantId,
      actorType: "owner",
      actorUserId: userId,
      action: "account.deletion_requested",
      targetType: "tenant",
      targetId: tenantId,
    });

    if (!request.stripe_cancelled_at) {
      try {
        const cancelResult = await performCancelStripeSubscriptionForDeletion(supabase, stripe);
        // Stripe's own cancellation already happened and cannot (and must
        // not) be rolled back if THIS write fails — it's just the local
        // checkpoint record of something that's already true. Logged, not
        // thrown: a retry re-checking `!request.stripe_cancelled_at` would
        // call performCancelStripeSubscriptionForDeletion again, which is
        // itself safe (it lists live subscriptions from Stripe directly;
        // an already-canceled one is correctly excluded and never
        // re-canceled) — so losing this checkpoint costs a harmless extra
        // Stripe read on retry, never a duplicate cancellation.
        const { error: checkpointError } = await admin
          .from("account_deletion_requests")
          .update({
            stripe_customer_id: cancelResult.stripeCustomerId,
            stripe_subscription_id: cancelResult.stripeSubscriptionId,
            stripe_cancelled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", request.id);
        if (checkpointError) {
          console.error(
            `[account-deletion] Stripe canceled for request ${request.id} but the checkpoint ` +
              `write failed: ${checkpointError.message} — a retry will safely re-verify via Stripe.`,
          );
        }
      } catch (err) {
        // The detailed cause (which can include Stripe's own error text)
        // is kept server-side only — in failure_reason and the audit log
        // via markDeletionFailed — never forwarded to the browser. Also
        // deliberately NOT claiming "nothing else was changed": if this
        // tenant ever has more than one live subscription, an earlier one
        // in performCancelStripeSubscriptionForDeletion's loop may have
        // already been canceled before a later one threw.
        const message = err instanceof Error ? err.message : "unknown error";
        await markDeletionFailed(
          admin,
          request.id,
          tenantId,
          userId,
          `Stripe cancellation failed: ${message}`,
        );
        throw new Error(
          "Your account was NOT deleted — canceling your subscription failed. Please try again, " +
            "or contact support if this keeps happening.",
        );
      }
    }

    let whatsappDisconnected: boolean | null;
    if (!request.whatsapp_disconnect_attempted_at) {
      const disconnectResult = await performDisconnectMetaConnection(admin, tenantId, userId);
      const now = new Date().toISOString();
      if (disconnectResult.status === "disconnected") {
        whatsappDisconnected = disconnectResult.metaApiSucceeded;
        // Only a CONFIRMED success (=== true) ever populates
        // whatsapp_disconnected_at — not the "nothing to disconnect"
        // no-op (null) and not a real Meta failure (false). Getting this
        // wrong previously meant a request that had nothing to disconnect
        // could, after failing and being resumed at a LATER step, read
        // back as `whatsappDisconnected: true` (a false success) via the
        // `Boolean(request.whatsapp_disconnected_at)` branch below —
        // exactly the "resumed request must never report a successful
        // Meta disconnection merely because an earlier request reached a
        // checkpoint" failure mode this fixes.
        const { error: checkpointError } = await admin
          .from("account_deletion_requests")
          .update({
            whatsapp_disconnect_attempted_at: now,
            whatsapp_disconnected_at: disconnectResult.metaApiSucceeded === true ? now : null,
            whatsapp_disconnect_error:
              disconnectResult.metaApiSucceeded === false
                ? "Meta API unsubscribe call failed — see server logs."
                : null,
            updated_at: now,
          })
          .eq("id", request.id);
        if (checkpointError) {
          // Same reasoning as the Stripe checkpoint above: the real Meta
          // attempt already happened (or was confirmed unnecessary) and
          // isn't undone by this write failing. A retry re-checking
          // `!request.whatsapp_disconnect_attempted_at` would call
          // performDisconnectMetaConnection again, which is itself safe —
          // it re-queries whatsapp_connections' own status, and an
          // already-disconnected (or never-connected) row is correctly
          // treated as nothing left to do, never a duplicate Meta call.
          console.error(
            `[account-deletion] WhatsApp disconnect step completed for request ${request.id} but ` +
              `the checkpoint write failed: ${checkpointError.message} — a retry will safely ` +
              "re-verify via whatsapp_connections' own status.",
          );
        }
      } else {
        // Local lookup/update itself failed BEFORE any Meta API call was
        // even reached — still non-fatal to the overall deletion, but
        // deliberately NOT marking whatsapp_disconnect_attempted_at here:
        // doing so would permanently skip this step on a later retry (see
        // the `if (!request.whatsapp_disconnect_attempted_at)` guard
        // above) even though Meta itself was never actually asked to
        // unsubscribe. Leaving the checkpoint unset means a retry tries
        // the real Meta call again instead of silently giving up on it.
        whatsappDisconnected = false;
        const { error: checkpointError } = await admin
          .from("account_deletion_requests")
          .update({ whatsapp_disconnect_error: disconnectResult.message, updated_at: now })
          .eq("id", request.id);
        if (checkpointError) {
          // Nothing external happened in this branch at all (the failure
          // was local, before any Meta call), so there's no idempotency
          // concern to reason about — just a lost error-detail write.
          // Harmless: whatsapp_disconnect_attempted_at is still unset
          // either way, so a retry tries the real Meta call again exactly
          // as it should.
          console.error(
            `[account-deletion] could not record the WhatsApp lookup failure for request ` +
              `${request.id}: ${checkpointError.message}`,
          );
        }
      }
    } else {
      whatsappDisconnected = Boolean(request.whatsapp_disconnected_at);
    }

    // stripe_webhook_claims has no FK to auth.users at all
    // (0021_stripe_webhook_claims.sql) — it would NOT cascade away on its
    // own once the auth user is deleted below, so it's cleaned up
    // explicitly here. An empty result (no claim row existed) is NOT an
    // error and is the common case — only a genuine `error` here means
    // the delete itself failed.
    //
    // Unlike the Stripe/Meta checkpoint writes above, a failure here
    // ABORTS before deleteUser rather than logging-and-continuing: those
    // checkpoints record something that already safely happened and is
    // provably safe to re-verify; this delete is the opposite — if it
    // fails, the cleanup has NOT happened, and proceeding to delete the
    // auth user would permanently orphan this row with no way to ever
    // clean it up afterward. Marking the request 'failed' here leaves it
    // in exactly the recoverable state claimOrResumeDeletionRequest
    // already handles: a retry resumes with stripe_cancelled_at and
    // whatsapp_disconnect_attempted_at already set (so neither Stripe nor
    // Meta is contacted again) and simply retries this delete + deleteUser.
    const { error: webhookClaimsError } = await admin
      .from("stripe_webhook_claims")
      .delete()
      .eq("user_id", userId);
    if (webhookClaimsError) {
      await markDeletionFailed(
        admin,
        request.id,
        tenantId,
        userId,
        `stripe_webhook_claims cleanup failed: ${webhookClaimsError.message}`,
      );
      throw new Error(
        "Your subscription was canceled and WhatsApp was disconnected, but a required cleanup " +
          "step failed before your account could be deleted. Please try again, or contact " +
          "support — your data has NOT been deleted.",
      );
    }

    // A deliberate, minimal forensic record OUTSIDE the database that is
    // about to cascade this tenant's own audit_log rows away. Captured by
    // Vercel's own runtime log retention — not a substitute for a real,
    // non-cascading compliance ledger if one is ever decided to be
    // needed, but enough to answer "did this user's deletion actually
    // reach the irreversible step, and when" after the fact, which
    // nothing durable inside this database can answer once it succeeds.
    console.log(
      `[account-deletion] completing deletion for tenant=${tenantId} user=${userId} ` +
        `stripeCustomerId=${request.stripe_customer_id ?? "none"} at=${new Date().toISOString()}`,
    );

    // The one irreversible step. Everything above is safely re-runnable;
    // this is not, which is why it runs last. On success, the FK cascade
    // from auth.users (tenants.user_id, "on delete cascade") removes the
    // tenant and every tenant-scoped row — including this very
    // account_deletion_requests row, and any audit_log rows just written
    // above. That's correct, not a gap: "permanently deletes... all
    // associated tenant data" includes the deletion's own paper trail.
    const { error: deleteUserError } = await admin.auth.admin.deleteUser(userId);
    if (deleteUserError) {
      // Detailed cause kept server-side (failure_reason/audit log) only —
      // same reasoning as the Stripe-failure branch above.
      await markDeletionFailed(
        admin,
        request.id,
        tenantId,
        userId,
        `Auth user deletion failed: ${deleteUserError.message}`,
      );
      throw new Error(
        "Your subscription was canceled and WhatsApp was disconnected, but deleting your account " +
          "itself failed. Please try again, or contact support — your data has NOT been deleted.",
      );
    }

    return { ok: true, stripeCancelled: true, whatsappDisconnected };
  },
);

export const deleteMyAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    return performDeleteMyAccount(
      context.supabase,
      getAdminClient(),
      getStripe(),
      tenantId,
      context.userId,
    );
  });
