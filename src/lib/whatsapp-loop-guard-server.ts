import crypto from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getAdminClient } from "@/lib/public-lead-server";

// WhatsApp AI-to-AI / non-progressing-answer loop guard — thin TypeScript
// wrapper over 0024_whatsapp_loop_guards.sql's atomic RPCs. See that
// migration's own comments for the full design reasoning (why two tables,
// why three independent trip signals computed from an append-only log
// rather than a running counter, why resume is never time-based).

// Configurable, documented, not hardcoded in logic — tune based on real
// conversation patterns observed in production, not fixed by this design.
// Passed as RPC parameters each call, so changing these requires no
// migration.
export const LOOP_DUPLICATE_CONTENT_THRESHOLD = 2; // identical inbound content, different ids, before tripping
export const LOOP_DUPLICATE_CONTENT_WINDOW_SECONDS = 600; // 10 minutes
export const LOOP_REPEAT_THRESHOLD = 5; // non-first occurrences of an outbound signature within the pattern window
export const LOOP_PATTERN_WINDOW_SECONDS = 24 * 60 * 60; // 24 hours — scopes RELEVANT evidence, never auto-clears a trip
export const LOOP_VOLUME_THRESHOLD = 10; // events (either direction) within the window below before pausing
export const LOOP_VOLUME_WINDOW_SECONDS = 180; // 3 minutes
export const LOOP_NOTICE_CLAIM_STALE_SECONDS = 60; // liveness window for retrying a crashed notice-send claim

// "priced": the price-sheet-grounded signal — item identity (real
// priceSheetItemId where available) plus the actual dollar amounts stated.
// "text": a normalized-text signal for non-priced automated messages
// (a clarifying question, a canned fallback, a system-error message).
// Used ONLY for OUTBOUND content — see computeInboundContentHash below for
// the separate inbound-side signal.
export type FactSignatureInput =
  | { kind: "priced"; priceSheetItemIds: Array<string | null | undefined>; amounts: number[] }
  | { kind: "text"; text: string };

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function computeFactSignature(input: FactSignatureInput): string {
  if (input.kind === "text") {
    return `text:${normalizeText(input.text)}`;
  }
  const ids = [
    ...new Set(input.priceSheetItemIds.filter((id): id is string => Boolean(id))),
  ].sort();
  const amounts = [...new Set(input.amounts.map((a) => a.toFixed(2)))].sort();
  return `priced:${ids.join(",")}|${amounts.join(",")}`;
}

// The INBOUND-side signal — deliberately separate from computeFactSignature
// (which only ever describes OUR OWN outbound answers). Hashed, never
// stored as raw text: this table must never become a new place raw
// customer message content accumulates (see the migration's own comment).
// For a text message, hashes the same normalized form normalizeText
// already produces, so a byte-for-byte-different-but-trivially-reformatted
// message (extra whitespace, different punctuation) still counts as the
// same content. For a media-only message (no text), hashes the media
// reference itself instead — two DIFFERENT photos from a legitimately
// chatty customer must never collide into a false "duplicate content"
// signal just because neither has caption text.
export function computeInboundContentHash(body: string, mediaRef: string | undefined): string {
  const trimmedBody = body.trim();
  const basis =
    trimmedBody.length > 0
      ? `text:${normalizeText(trimmedBody)}`
      : mediaRef
        ? `media:${mediaRef}`
        : `empty:${crypto.randomUUID()}`; // no text, no media ref — never matches anything
  return crypto.createHash("sha256").update(basis).digest("hex");
}

// A plain, conservative phone normalization — strips whitespace/punctuation
// other than a leading "+", so "+1 (555) 123-4567" and "+15551234567"
// resolve to the same guard row. Deliberately not a full E.164 validator/
// library integration (out of scope for this pass) — just enough to close
// the specific "resume boundary applies no normalization at all" gap a
// prior review found, using the same (tenant, phone) key shape every other
// part of this design already relies on.
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  return hasPlus ? `+${digits}` : digits;
}

export type TripReason = "duplicate_content" | "repeat_pattern" | "volume";

export type LoopGuardEvaluation = {
  tripped: boolean;
  justTripped: boolean;
  tripReason: TripReason | null;
  isDuplicateContent: boolean;
  duplicateContentCount: number;
  repeatCount: number;
  recentEventCount: number;
};

// Thrown when the guard itself cannot be safely checked or updated (an RPC
// error, a missing/unparseable row). The caller MUST treat this as "cannot
// safely send an automated reply" — fail CLOSED — never fail open the way
// claimLeadSlot elsewhere in this codebase deliberately does for a
// different, lower-stakes concern (a missed dedup there risks only a
// possible duplicate lead; failing open here risks unbounded automated
// cost/spam, the opposite risk profile).
export class LoopGuardCheckFailed extends Error {}

type AdminClient = ReturnType<typeof getAdminClient>;

async function recordInteraction(
  admin: AdminClient,
  tenantId: string,
  phone: string,
  direction: "inbound" | "outbound",
  contentHash: string,
  providerMessageId: string | null,
  leadId: string | null,
): Promise<LoopGuardEvaluation> {
  const { data, error } = await admin.rpc("record_whatsapp_interaction", {
    p_tenant_id: tenantId,
    p_phone: phone,
    p_direction: direction,
    p_content_hash: contentHash,
    p_provider_message_id: providerMessageId,
    p_lead_id: leadId,
    p_duplicate_window_seconds: LOOP_DUPLICATE_CONTENT_WINDOW_SECONDS,
    p_duplicate_threshold: LOOP_DUPLICATE_CONTENT_THRESHOLD,
    p_pattern_window_seconds: LOOP_PATTERN_WINDOW_SECONDS,
    p_repeat_threshold: LOOP_REPEAT_THRESHOLD,
    p_volume_window_seconds: LOOP_VOLUME_WINDOW_SECONDS,
    p_volume_threshold: LOOP_VOLUME_THRESHOLD,
  });
  const row = Array.isArray(data) ? data[0] : undefined;
  if (error || !row) {
    throw new LoopGuardCheckFailed(
      `Could not record WhatsApp ${direction} interaction for tenant ${tenantId}: ${error?.message ?? "no row returned"}`,
    );
  }
  return {
    tripped: Boolean(row["tripped"]),
    justTripped: Boolean(row["just_tripped"]),
    tripReason: (row["trip_reason"] as TripReason | null) ?? null,
    isDuplicateContent: Boolean(row["is_duplicate_content"]),
    duplicateContentCount: Number(row["duplicate_content_count"]),
    repeatCount: Number(row["repeat_count"]),
    recentEventCount: Number(row["recent_event_count"]),
  };
}

// Called once, at the very top of handleInboundWhatsAppMessage, for EVERY
// inbound message regardless of what happens afterward (already-tripped
// fast path, clarification continuation, fresh quote, pre-lead greeting).
// This is both the evidence-recording step AND the "is this already
// tripped, or does this message itself trip it" check — there is no
// separate cheap pre-check before this in the revised design, since the
// evidence log itself must see every inbound message to compute the
// duplicate-content and volume signals correctly.
export async function evaluateInboundInteraction(
  admin: AdminClient,
  tenantId: string,
  phone: string,
  input: { body: string; mediaRef: string | undefined; providerMessageId: string | undefined; leadId: string | null },
): Promise<LoopGuardEvaluation> {
  const hash = computeInboundContentHash(input.body, input.mediaRef);
  return recordInteraction(admin, tenantId, phone, "inbound", hash, input.providerMessageId ?? null, input.leadId);
}

// Called from sendGuardedReply (whatsapp-conversation-server.ts) for every
// single automated outbound send in this codebase — see that file's own
// comment for the full list of call sites this now covers.
export async function evaluateOutboundInteraction(
  admin: AdminClient,
  tenantId: string,
  phone: string,
  input: { signature: FactSignatureInput; leadId: string | null },
): Promise<LoopGuardEvaluation> {
  const hash = computeFactSignature(input.signature);
  return recordInteraction(admin, tenantId, phone, "outbound", hash, null, input.leadId);
}

// Cheap, read-only — no event recorded, no evaluation run. Not used in the
// main send/receive paths (those go through evaluate*Interaction above,
// which both records evidence and evaluates in one atomic call); kept as
// a standalone utility for anything that only needs "is this phone
// currently paused" without wanting to write a new evidence row (e.g. a
// future dashboard status read).
export async function isLoopGuardTripped(
  admin: AdminClient,
  tenantId: string,
  phone: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("whatsapp_loop_guards")
    .select("tripped_at")
    .eq("tenant_id", tenantId)
    .eq("phone", phone)
    .maybeSingle();
  if (error) {
    throw new LoopGuardCheckFailed(
      `Could not read WhatsApp loop guard state for tenant ${tenantId}: ${error.message}`,
    );
  }
  return Boolean(data?.["tripped_at"]);
}

// Atomically claims the right to attempt the real pause-notice send — see
// the migration's own comment on claim_whatsapp_loop_notice for why this
// exists (closing the concurrent-notice-claim race the first design left
// open). Returns false if another caller already holds a live claim, or
// the notice isn't owed at all (not 'pending'/'sending') — the caller
// MUST NOT send in that case.
export async function claimLoopNotice(
  admin: AdminClient,
  tenantId: string,
  phone: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("claim_whatsapp_loop_notice", {
    p_tenant_id: tenantId,
    p_phone: phone,
    p_stale_seconds: LOOP_NOTICE_CLAIM_STALE_SECONDS,
  });
  if (error) {
    console.error(`Could not claim WhatsApp loop notice for tenant ${tenantId}:`, error.message);
    return false;
  }
  return Boolean(data);
}

// Releases a held claim back to 'pending' after the real send attempt
// FAILS — so the next inbound message can retry immediately rather than
// waiting out the staleness window. Never called after a successful send
// (that goes to markLoopNoticeSent instead, which transitions to 'sent').
export async function releaseLoopNoticeClaim(
  admin: AdminClient,
  tenantId: string,
  phone: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("release_whatsapp_loop_notice_claim", {
    p_tenant_id: tenantId,
    p_phone: phone,
  });
  if (error) {
    console.error(`Could not release WhatsApp loop notice claim for tenant ${tenantId}:`, error.message);
    return false;
  }
  return Boolean(data);
}

// Only ever called after a real provider send has returned success — see
// the migration's own comment for the honest at-least-once guarantee this
// does NOT upgrade to exactly-once.
export async function markLoopNoticeSent(
  admin: AdminClient,
  tenantId: string,
  phone: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("mark_whatsapp_loop_notice_sent", {
    p_tenant_id: tenantId,
    p_phone: phone,
  });
  if (error) {
    console.error(
      `Could not mark WhatsApp loop notice sent for tenant ${tenantId}:`,
      error.message,
    );
    return false;
  }
  return Boolean(data);
}

// The fixed, enumerable set of authorized resume actions — see the
// migration's own comment on resume_whatsapp_loop_guard. Never "time
// passed" or "a new message arrived."
export type ResumedBy = "dashboard_action" | "meta_human_echo" | "operator_reply";

export async function resumeLoopGuardState(
  admin: AdminClient,
  tenantId: string,
  phone: string,
  resumedBy: ResumedBy,
): Promise<boolean> {
  const { data, error } = await admin.rpc("resume_whatsapp_loop_guard", {
    p_tenant_id: tenantId,
    p_phone: phone,
    p_resumed_by: resumedBy,
  });
  if (error) {
    console.error(`Could not resume WhatsApp loop guard for tenant ${tenantId}:`, error.message);
    return false;
  }
  return Boolean(data);
}

// Dashboard-facing "resume automation for this number" action — auth-
// gated, tenant_id derived server-side from the session (never client-
// supplied), same pattern as every other authenticated mutation in this
// codebase. Explicit, human-triggered recovery per the approved design.
// Phone is normalized before use — the guard row is keyed on whatever
// normalized form the webhook routes already write with.
export const resumeWhatsAppAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { phone: string }) => input)
  .handler(async ({ context, data }): Promise<{ resumed: boolean }> => {
    const { data: tenant, error } = await context.supabase
      .from("tenants")
      .select("id")
      .eq("user_id", context.userId)
      .single();
    if (error || !tenant) {
      throw new Error("Could not find your business.");
    }
    const admin = getAdminClient();
    const resumed = await resumeLoopGuardState(
      admin,
      tenant.id as string,
      normalizePhone(data.phone),
      "dashboard_action",
    );
    return { resumed };
  });
