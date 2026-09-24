import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getAdminClient } from "@/lib/public-lead-server";
import { getMetaCredentials, graphUrl, describeMetaError, resolveActiveMetaWabaForTenant } from "@/lib/meta-whatsapp-server";

// WhatsApp message-template management (Meta Cloud API). Kept in its own
// file rather than folded into meta-whatsapp-server.ts (already 648 lines
// before this) — this owns template CRUD + status-sync specifically,
// meta-whatsapp-server.ts keeps owning signup/connection/send.

export type TemplateCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";
export type TemplateStatus = "pending" | "approved" | "rejected" | "paused";

export type WhatsAppTemplate = {
  id: string;
  name: string;
  category: TemplateCategory;
  language: string;
  headerText: string | null;
  bodyText: string;
  footerText: string | null;
  status: TemplateStatus;
  rejectionReason: string | null;
  createdAt: string;
};

// Meta's own naming rule — lowercase letters, digits, underscores only.
// Checked here before ever calling Meta, so a bad name fails locally
// instead of burning a real API rejection; the database also enforces this
// as a check constraint, so this is belt-and-suspenders, not the only guard.
const NAME_PATTERN = /^[a-z0-9_]+$/;

export function isValidTemplateName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

// {{1}}, {{2}}, ... — the only variable syntax Meta templates support in
// this scope (no named/positional-with-example variants). Shared by the
// send-time filler below and the dashboard form, so both agree on what
// counts as a variable.
const VARIABLE_PATTERN = /\{\{(\d+)\}\}/g;

export function countTemplateVariables(bodyText: string): number {
  const matches = [...bodyText.matchAll(VARIABLE_PATTERN)].map((m) => Number(m[1]));
  return matches.length > 0 ? Math.max(...matches) : 0;
}

// Reconstructs what was actually sent, for display in the lead thread —
// {{1}}/{{2}}/... replaced with the values the owner supplied. Left as
// literal text if a value is missing rather than throwing, since this is
// only used for a human-readable thread entry, never for the real Meta send
// (which sends the structured components array directly, not this string).
export function fillTemplateBody(bodyText: string, params: string[]): string {
  return bodyText.replace(VARIABLE_PATTERN, (match, indexStr: string) => {
    const idx = Number(indexStr) - 1;
    return params[idx] ?? match;
  });
}

function toTemplate(row: Record<string, unknown>): WhatsAppTemplate {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    category: row["category"] as TemplateCategory,
    language: row["language"] as string,
    headerText: (row["header_text"] as string | null) ?? null,
    bodyText: row["body_text"] as string,
    footerText: (row["footer_text"] as string | null) ?? null,
    status: row["status"] as TemplateStatus,
    rejectionReason: (row["rejection_reason"] as string | null) ?? null,
    createdAt: row["created_at"] as string,
  };
}

export const listMyWhatsAppTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<WhatsAppTemplate[]> => {
    const { data: tenantRow, error: tenantError } = await context.supabase
      .from("tenants")
      .select("id")
      .eq("user_id", context.userId)
      .single();
    if (tenantError || !tenantRow) throw new Error("Could not find your business.");
    const tenantId = tenantRow.id as string;

    const admin = getAdminClient();
    const { data, error } = await admin
      .from("whatsapp_templates")
      .select("id, name, category, language, header_text, body_text, footer_text, status, rejection_reason, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Could not load templates: ${error.message}`);
    return (data ?? []).map(toTemplate);
  });

type CreateTemplateInput = {
  name: string;
  category: TemplateCategory;
  language: string;
  headerText?: string;
  bodyText: string;
  footerText?: string;
};
type CreateTemplateResult = { status: "created"; template: WhatsAppTemplate } | { status: "error"; message: string };

export const createWhatsAppTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: CreateTemplateInput) => input)
  .handler(async ({ context, data }): Promise<CreateTemplateResult> => {
    const name = data.name.trim().toLowerCase();
    const bodyText = data.bodyText.trim();
    const headerText = data.headerText?.trim() || null;
    const footerText = data.footerText?.trim() || null;

    if (!isValidTemplateName(name)) {
      return { status: "error", message: "Template names can only use lowercase letters, numbers, and underscores." };
    }
    if (!bodyText) {
      return { status: "error", message: "Template body can't be empty." };
    }

    const { data: tenantRow, error: tenantError } = await context.supabase
      .from("tenants")
      .select("id")
      .eq("user_id", context.userId)
      .single();
    if (tenantError || !tenantRow) {
      return { status: "error", message: "Could not find your business." };
    }
    const tenantId = tenantRow.id as string;

    const connection = await resolveActiveMetaWabaForTenant(tenantId);
    if (!connection) {
      return { status: "error", message: "Connect WhatsApp via Meta before creating a template." };
    }

    const admin = getAdminClient();

    const { data: existing } = await admin
      .from("whatsapp_templates")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("name", name)
      .eq("language", data.language)
      .maybeSingle();
    if (existing) {
      return { status: "error", message: "You already have a template with this name and language." };
    }

    const components: Record<string, unknown>[] = [];
    if (headerText) components.push({ type: "HEADER", format: "TEXT", text: headerText });
    components.push({ type: "BODY", text: bodyText });
    if (footerText) components.push({ type: "FOOTER", text: footerText });

    const { apiVersion } = getMetaCredentials();
    const response = await fetch(graphUrl(apiVersion, `/${connection.wabaId}/message_templates`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name, language: data.language, category: data.category, components }),
    });
    if (!response.ok) {
      return { status: "error", message: `Meta rejected this template: ${await describeMetaError(response)}` };
    }
    const json = (await response.json()) as { id?: string; status?: string };
    if (!json.id) {
      return { status: "error", message: "Meta accepted the request but returned no template id." };
    }

    const { data: inserted, error: insertError } = await admin
      .from("whatsapp_templates")
      .insert({
        tenant_id: tenantId,
        meta_template_id: json.id,
        name,
        category: data.category,
        language: data.language,
        header_text: headerText,
        body_text: bodyText,
        footer_text: footerText,
        status: "pending",
      })
      .select("id, name, category, language, header_text, body_text, footer_text, status, rejection_reason, created_at")
      .single();
    if (insertError || !inserted) {
      // Meta already has this template at this point — not rolled back,
      // same "local DB write is the one thing that can fail after an
      // external side effect already succeeded" case completeMetaWhatsAppSignup
      // already accepts elsewhere in this codebase. Surfaced honestly rather
      // than claiming success.
      return {
        status: "error",
        message: "Meta accepted the template, but it couldn't be saved here. Refresh in a moment — it may still appear once Meta's webhook confirms it.",
      };
    }

    return { status: "created", template: toTemplate(inserted) };
  });

export const deleteWhatsAppTemplate = createServerFn({ method: "POST" })
  .validator((input: string) => input)
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data: id }): Promise<void> => {
    const { data: tenantRow, error: tenantError } = await context.supabase
      .from("tenants")
      .select("id")
      .eq("user_id", context.userId)
      .single();
    if (tenantError || !tenantRow) throw new Error("Could not find your business.");
    const tenantId = tenantRow.id as string;

    const admin = getAdminClient();

    const { data: templateRow } = await admin
      .from("whatsapp_templates")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .maybeSingle();
    if (!templateRow) return; // already gone — same end state either way

    const connection = await resolveActiveMetaWabaForTenant(tenantId);
    if (connection) {
      try {
        const { apiVersion } = getMetaCredentials();
        const url = new URL(graphUrl(apiVersion, `/${connection.wabaId}/message_templates`));
        url.searchParams.set("name", templateRow["name"] as string);
        const response = await fetch(url.toString(), {
          method: "DELETE",
          headers: { Authorization: `Bearer ${connection.accessToken}` },
        });
        if (!response.ok) {
          // Meta-side delete failing doesn't block removing it from the
          // owner's list — same posture as disconnectMetaWhatsApp's own
          // unsubscribe-failure handling. Logged, not fatal.
          console.error(`[WhatsApp templates] Meta delete failed for ${templateRow["name"]}: ${await describeMetaError(response)}`);
        }
      } catch (err) {
        console.error(`[WhatsApp templates] Meta delete request failed for ${templateRow["name"]}:`, err);
      }
    }

    const { error } = await admin.from("whatsapp_templates").delete().eq("id", id).eq("tenant_id", tenantId);
    if (error) throw new Error(`Could not delete template: ${error.message}`);
  });

// Send-time lookup: tenant-scoped, approved-only — a pending/rejected
// template can never be the thing an owner actually sends.
export async function getApprovedWhatsAppTemplate(tenantId: string, templateId: string): Promise<WhatsAppTemplate | null> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("whatsapp_templates")
    .select("id, name, category, language, header_text, body_text, footer_text, status, rejection_reason, created_at")
    .eq("tenant_id", tenantId)
    .eq("id", templateId)
    .eq("status", "approved")
    .maybeSingle();
  return data ? toTemplate(data) : null;
}

// Meta's status-update event values, mapped to this table's local enum.
// Anything not in this map (DISABLED, PENDING_DELETION, FLAGGED, etc.) is
// logged and skipped rather than guessed at — same "silent skip, but
// logged" posture api.whatsapp.meta-webhook.tsx already uses for an
// unrecognized phone_number_id.
const EVENT_TO_STATUS: Partial<Record<string, TemplateStatus>> = {
  APPROVED: "approved",
  REJECTED: "rejected",
  PAUSED: "paused",
  PENDING: "pending",
};

export function mapTemplateEvent(event: string): TemplateStatus | undefined {
  return EVENT_TO_STATUS[event];
}

// Called from api.whatsapp.meta-webhook.tsx on a message_template_status_update
// event. Keyed directly on Meta's own template id — globally unique, so no
// tenant/WABA resolution is needed for this lookup (unlike inbound-message
// routing, which must resolve a tenant from phone_number_id before touching
// anything).
export async function applyTemplateStatusUpdate(params: {
  metaTemplateId: string;
  event: string;
  reason: string | undefined;
}): Promise<void> {
  const status = mapTemplateEvent(params.event);
  if (!status) {
    console.error(
      `[WhatsApp templates] Unrecognized status-update event "${params.event}" for template ${params.metaTemplateId} — ignored.`,
    );
    return;
  }
  const admin = getAdminClient();
  const { error } = await admin
    .from("whatsapp_templates")
    .update({ status, rejection_reason: status === "rejected" ? (params.reason ?? null) : null })
    .eq("meta_template_id", params.metaTemplateId);
  if (error) {
    console.error(`[WhatsApp templates] Could not apply status update for template ${params.metaTemplateId}:`, error.message);
  }
}
