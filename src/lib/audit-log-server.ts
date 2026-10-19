import type { SupabaseClient } from "@supabase/supabase-js";

// Shared writer for the three action categories SECURITY_REMEDIATION_TRACKER.md
// §3.4 approved: subscription/billing state changes, WhatsApp (Meta) connect/
// disconnect, and lead deletion. See 0027_audit_log.sql for the table itself
// and why it's shaped the way it is.
export type AuditAction =
  "subscription.state_changed" | "whatsapp.connected" | "whatsapp.disconnected" | "lead.deleted";
export type AuditTargetType = "subscription" | "whatsapp_connection" | "lead";

type RecordAuditLogParams = {
  tenantId: string;
  actorType: "owner" | "system";
  // Supabase auth user id of the tenant owner who triggered this, when
  // actorType is "owner". Always null for "system" (a Stripe webhook event,
  // a reconciliation-script run) — there's no human to attribute those to.
  actorUserId?: string | null;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  // Action-specific, non-secret detail only — never a token, password, or
  // anything else already covered by this codebase's "never logged" rule
  // (meta_system_user_token, STRIPE_SECRET_KEY, etc.).
  metadata?: Record<string, unknown>;
};

// Best-effort and never thrown — same posture as api.stripe.webhook.tsx's
// mirrorToAppMetadata. Every caller has already completed the real
// write/delete/connect it's recording before calling this; a failure to
// write the audit row (e.g. the migration isn't applied yet) must never
// block, undo, or even surface as an error for the real action.
export async function recordAuditLog(
  admin: SupabaseClient,
  params: RecordAuditLogParams,
): Promise<void> {
  try {
    const { error } = await admin.from("audit_log").insert({
      tenant_id: params.tenantId,
      actor_type: params.actorType,
      actor_user_id: params.actorUserId ?? null,
      action: params.action,
      target_type: params.targetType,
      target_id: params.targetId,
      metadata: params.metadata ?? {},
    });
    if (error) {
      console.error(
        `[audit_log] insert failed (action=${params.action}, tenant=${params.tenantId}):`,
        error.message,
      );
    }
  } catch (err) {
    console.error(
      `[audit_log] insert threw unexpectedly (action=${params.action}, tenant=${params.tenantId}):`,
      err,
    );
  }
}
