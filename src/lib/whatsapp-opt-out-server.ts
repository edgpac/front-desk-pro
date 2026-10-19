import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getAdminClient } from "@/lib/public-lead-server";
import { normalizePhone } from "@/lib/whatsapp-loop-guard-server";

// WhatsApp opt-out (STOP/UNSUBSCRIBE/CANCEL/etc.) — thin TypeScript wrapper
// over 0025_whatsapp_opt_outs.sql's atomic RPCs. See that migration's own
// comments for the full concurrency reasoning. A SEPARATE concern from the
// loop guard (whatsapp-loop-guard-server.ts) — deliberately not folded
// together, so the two states can never be conflated or cleared by the
// wrong resume path.
//
// KNOWN, UNELIMINATED RACE (documented, not hidden): isOptedOut's read and
// the actual HTTP send call that follows it (inside sendWhatsAppMessage/
// sendWhatsAppMessageMeta/sendWhatsAppTemplateMessage) are two separate
// steps — there is no way to make "check opt-out status" and "call
// Twilio/Meta's API" atomic across an external HTTP call. In practice this
// window is a single DB round-trip wide (milliseconds), and the DB write
// itself (record_whatsapp_opt_out) IS atomic and race-safe under
// concurrent STOP messages (see the migration's own comments and
// scripts/pg-whatsapp-opt-out-check.sh's real-concurrency sections) — what
// remains is only the narrow case of a send already past its opt-out check
// at the exact moment a STOP commits. Accepted, not silently assumed away.

export { normalizePhone };

const OPT_OUT_KEYWORDS = new Set([
  // English
  "stop",
  "unsubscribe",
  "cancel",
  "quit",
  "end",
  // Spanish
  "alto",
  "cancelar",
  "basta",
]);
const OPT_IN_KEYWORDS = new Set(["start"]);

// Exact-match against the whole normalized message, never "contains" — a
// substring match would false-positive on completely ordinary conversation
// ("can you cancel the old quote", "please stop by tomorrow"). Strips
// leading/trailing punctuation and collapses whitespace so "STOP.",
// "stop!!", and "  Stop  " all still match, but a keyword appearing only
// as part of a longer sentence does not.
function normalizeControlMessage(body: string): string {
  return body
    .trim()
    .toLowerCase()
    .replace(/^[^\w]+|[^\w]+$/g, "");
}

export function isOptOutKeyword(body: string): boolean {
  return OPT_OUT_KEYWORDS.has(normalizeControlMessage(body));
}

export function isOptInKeyword(body: string): boolean {
  return OPT_IN_KEYWORDS.has(normalizeControlMessage(body));
}

// Thrown when the opt-out check itself cannot be safely performed (an RPC
// error, an unreachable database). Every caller MUST treat this as "cannot
// verify compliance — do not send" — fail CLOSED. The alternative (assume
// NOT opted out and send anyway) risks messaging someone who explicitly
// asked to stop, which is the worse outcome for a compliance-sensitive
// check, same fail-closed direction the loop guard already established
// for a different reason (LoopGuardCheckFailed).
export class OptOutCheckFailed extends Error {}

// Thrown by the three actual outbound-sending functions (sendWhatsAppMessage,
// sendWhatsAppMessageMeta, sendWhatsAppTemplateMessage) when the recipient
// is currently opted out — callers must treat this as an expected, non-
// exceptional outcome (silently suppress the send), never surface it to
// the customer or retry it.
export class WhatsAppOptedOutError extends Error {}

type AdminClient = ReturnType<typeof getAdminClient>;

// The actual enforcement check — called from inside sendWhatsAppMessage/
// sendWhatsAppMessageMeta/sendWhatsAppTemplateMessage as the literal first
// line before any HTTP call, so no caller of those three functions (every
// outbound WhatsApp send in this codebase funnels through one of them) can
// bypass it. Also called, redundantly but cheaply, from the top of
// handleInboundWhatsAppMessage so the automated path never even attempts
// the AI/reply pipeline for an opted-out number.
export async function isOptedOut(admin: AdminClient, tenantId: string, phone: string): Promise<boolean> {
  const { data, error } = await admin
    .from("whatsapp_opt_outs")
    .select("opted_out_at, resumed_at")
    .eq("tenant_id", tenantId)
    .eq("phone", phone)
    .maybeSingle();
  if (error) {
    throw new OptOutCheckFailed(`Could not read WhatsApp opt-out state for tenant ${tenantId}: ${error.message}`);
  }
  if (!data || !data["opted_out_at"]) return false;
  const resumedAt = data["resumed_at"] as string | null;
  return !resumedAt || resumedAt < (data["opted_out_at"] as string);
}

export async function recordOptOut(
  admin: AdminClient,
  tenantId: string,
  phone: string,
): Promise<{ justOptedOut: boolean }> {
  const { data, error } = await admin.rpc("record_whatsapp_opt_out", {
    p_tenant_id: tenantId,
    p_phone: phone,
  });
  const row = Array.isArray(data) ? data[0] : undefined;
  if (error || !row) {
    throw new OptOutCheckFailed(`Could not record WhatsApp opt-out for tenant ${tenantId}: ${error?.message ?? "no row returned"}`);
  }
  return { justOptedOut: Boolean(row["just_opted_out"]) };
}

const OPT_OUT_CONFIRMATION_CLAIM_STALE_SECONDS = 60;

export async function claimOptOutConfirmation(admin: AdminClient, tenantId: string, phone: string): Promise<boolean> {
  const { data, error } = await admin.rpc("claim_whatsapp_opt_out_confirmation", {
    p_tenant_id: tenantId,
    p_phone: phone,
    p_stale_seconds: OPT_OUT_CONFIRMATION_CLAIM_STALE_SECONDS,
  });
  if (error) {
    console.error(`Could not claim WhatsApp opt-out confirmation for tenant ${tenantId}:`, error.message);
    return false;
  }
  return Boolean(data);
}

export async function releaseOptOutConfirmationClaim(admin: AdminClient, tenantId: string, phone: string): Promise<boolean> {
  const { data, error } = await admin.rpc("release_whatsapp_opt_out_confirmation", {
    p_tenant_id: tenantId,
    p_phone: phone,
  });
  if (error) {
    console.error(`Could not release WhatsApp opt-out confirmation claim for tenant ${tenantId}:`, error.message);
    return false;
  }
  return Boolean(data);
}

export async function markOptOutConfirmationSent(admin: AdminClient, tenantId: string, phone: string): Promise<boolean> {
  const { data, error } = await admin.rpc("mark_whatsapp_opt_out_confirmation_sent", {
    p_tenant_id: tenantId,
    p_phone: phone,
  });
  if (error) {
    console.error(`Could not mark WhatsApp opt-out confirmation sent for tenant ${tenantId}:`, error.message);
    return false;
  }
  return Boolean(data);
}

export type OptOutResumedBy = "dashboard_action" | "opt_in_keyword";

export async function resumeOptOut(
  admin: AdminClient,
  tenantId: string,
  phone: string,
  resumedBy: OptOutResumedBy,
): Promise<boolean> {
  const { data, error } = await admin.rpc("resume_whatsapp_opt_out", {
    p_tenant_id: tenantId,
    p_phone: phone,
    p_resumed_by: resumedBy,
  });
  if (error) {
    console.error(`Could not resume WhatsApp opt-out for tenant ${tenantId}:`, error.message);
    return false;
  }
  return Boolean(data);
}

// Dashboard-facing "resubscribe this number" action — auth-gated, tenant_id
// derived server-side from the session (never client-supplied), same
// pattern as resumeWhatsAppAutomation in whatsapp-loop-guard-server.ts.
export const resumeWhatsAppOptOut = createServerFn({ method: "POST" })
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
    const resumed = await resumeOptOut(admin, tenant.id as string, normalizePhone(data.phone), "dashboard_action");
    return { resumed };
  });
