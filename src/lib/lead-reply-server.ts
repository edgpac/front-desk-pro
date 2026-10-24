import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  sendWhatsAppMessageMeta,
  sendWhatsAppTemplateMessage,
  resolveActiveMetaConnectionForTenant,
  markConnectionFailed,
  MetaOutsideWindowError,
} from "@/lib/meta-whatsapp-server";
import { getApprovedWhatsAppTemplate, fillTemplateBody } from "@/lib/whatsapp-templates-server";
import { getAdminClient } from "@/lib/public-lead-server";
import { resumeLoopGuardState, normalizePhone } from "@/lib/whatsapp-loop-guard-server";
import { WhatsAppOptedOutError } from "@/lib/whatsapp-opt-out-server";

// Meta Embedded Signup is the only supported WhatsApp outbound channel —
// Twilio support was removed (see ROADMAP.md). Previously this function
// branched on tenants.whatsapp_number (a legacy Twilio-routing field) and
// tried Twilio first whenever it was set, even for a tenant whose real,
// active connection was Meta — a stale value could silently misroute a
// reply. Resolving the tenant's Meta connection directly, with no other
// branch to fall into, removes that failure mode entirely.

// "outside_window" and "opted_out" are their own variants, not folded into
// "error" — the UI needs to reliably branch (offer a template instead;
// explain the customer opted out) without string-matching an error
// message, which would break the moment the copy changes.
type SendResult =
  | { status: "sent" }
  | { status: "error"; message: string }
  | { status: "outside_window" }
  | { status: "opted_out" };

// Extracted into a plain, directly-callable function — same reasoning and
// pattern as public-lead-server.ts's performCreateClarifyingLead: a bare
// createServerFn cannot be invoked directly in the Vitest environment
// (throws "No Start context found in AsyncLocalStorage"). Taking a plain
// client + userId instead of TanStack's {context, data} shape makes the
// Meta-only routing fix above directly regression-testable with a fake
// client, no server runtime needed.
export async function performSendLeadReply(
  supabase: Pick<SupabaseClient, "from">,
  userId: string,
  data: { leadId: string; body: string },
): Promise<SendResult> {
  const body = data.body.trim();
  if (!body) {
    return { status: "error", message: "Message can't be empty." };
  }

  const { data: tenantRow, error: tenantError } = await supabase
    .from("tenants")
    .select("id")
    .eq("user_id", userId)
    .single();
  if (tenantError || !tenantRow) {
    return { status: "error", message: "Could not find your business." };
  }
  const tenantId = tenantRow.id as string;

  const { data: leadRow, error: leadError } = await supabase
    .from("leads")
    .select("id, phone, channel")
    .eq("tenant_id", tenantId)
    .eq("id", data.leadId)
    .single();
  if (leadError || !leadRow) {
    return { status: "error", message: "Lead not found." };
  }

  // Only WhatsApp leads have a real outbound channel to send through —
  // a Widget/Quote link/Shared link customer was never messaging over a
  // channel this app can reply on, so those stay an internal-only thread
  // note, same as before this change.
  if (leadRow.channel === "WhatsApp") {
    const to = leadRow.phone as string;
    if (!to) {
      return { status: "error", message: "This lead has no phone number on file." };
    }

    const metaConnection = await resolveActiveMetaConnectionForTenant(tenantId);
    if (!metaConnection) {
      return { status: "error", message: "No WhatsApp connection is set up for this business yet." };
    }
    try {
      await sendWhatsAppMessageMeta({
        phoneNumberId: metaConnection.phoneNumberId,
        accessToken: metaConnection.accessToken,
        to,
        body,
        tenantId,
      });
    } catch (err) {
      if (err instanceof WhatsAppOptedOutError) {
        return { status: "opted_out" };
      }
      if (err instanceof MetaOutsideWindowError) {
        return { status: "outside_window" };
      }
      await markConnectionFailed(
        metaConnection.connectionId,
        err instanceof Error ? err.message : "WhatsApp send failed.",
      );
      return {
        status: "error",
        message: err instanceof Error ? err.message : "Could not send the WhatsApp message.",
      };
    }

    // A dashboard operator's own reply, after it has actually reached
    // the customer (never before — same "only after a confirmed send"
    // discipline as every other resume path), is an authorized human
    // decision: a real person is actively handling this specific
    // customer, so any tripped loop guard for this (tenant, phone) is
    // cleared. 'operator_reply' is one of the fixed, enumerable resume
    // reasons (0024_whatsapp_loop_guards.sql) — never a bare new
    // message. resumeLoopGuardState never throws, so a failure here
    // can't turn an otherwise-successful reply into a reported error.
    await resumeLoopGuardState(getAdminClient(), tenantId, normalizePhone(to), "operator_reply");
  }

  // Only recorded once the real send (if any) succeeded — a WhatsApp
  // lead whose send failed never gets an "assistant" row implying it
  // reached the customer, so the thread stays honest about what
  // actually went out instead of just what was typed.
  const { error: insertError } = await supabase
    .from("lead_messages")
    .insert({ lead_id: data.leadId, role: "assistant", body });
  if (insertError) {
    return { status: "error", message: `Sent, but could not save to the thread: ${insertError.message}` };
  }

  return { status: "sent" };
}

export const sendLeadReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { leadId: string; body: string }) => input)
  .handler(async ({ context, data }) => performSendLeadReply(context.supabase, context.userId, data));

// The re-engagement path for a lead sendLeadReply just reported
// "outside_window" on. Template-only: never falls back to a free-form
// send, since Meta would just reject that outside the window anyway.
export async function performSendLeadReplyWithTemplate(
  supabase: Pick<SupabaseClient, "from">,
  userId: string,
  data: { leadId: string; templateId: string; bodyParams: string[] },
): Promise<SendResult> {
  const { data: tenantRow, error: tenantError } = await supabase
    .from("tenants")
    .select("id")
    .eq("user_id", userId)
    .single();
  if (tenantError || !tenantRow) {
    return { status: "error", message: "Could not find your business." };
  }
  const tenantId = tenantRow.id as string;

  const { data: leadRow, error: leadError } = await supabase
    .from("leads")
    .select("id, phone, channel")
    .eq("tenant_id", tenantId)
    .eq("id", data.leadId)
    .single();
  if (leadError || !leadRow) {
    return { status: "error", message: "Lead not found." };
  }
  if (leadRow.channel !== "WhatsApp" || !leadRow.phone) {
    return { status: "error", message: "This lead has no WhatsApp number to send a template to." };
  }

  const template = await getApprovedWhatsAppTemplate(tenantId, data.templateId);
  if (!template) {
    return { status: "error", message: "That template wasn't found, or isn't approved yet." };
  }

  const metaConnection = await resolveActiveMetaConnectionForTenant(tenantId);
  if (!metaConnection) {
    return { status: "error", message: "No WhatsApp connection is set up for this business." };
  }

  try {
    await sendWhatsAppTemplateMessage({
      phoneNumberId: metaConnection.phoneNumberId,
      accessToken: metaConnection.accessToken,
      to: leadRow.phone as string,
      templateName: template.name,
      language: template.language,
      bodyParams: data.bodyParams,
      tenantId,
    });
  } catch (err) {
    if (err instanceof WhatsAppOptedOutError) {
      return { status: "opted_out" };
    }
    await markConnectionFailed(metaConnection.connectionId, err instanceof Error ? err.message : "Template send failed.");
    return { status: "error", message: err instanceof Error ? err.message : "Could not send the template." };
  }

  // Same authorized-resume reasoning as performSendLeadReply above — only
  // after the template send has actually confirmed success.
  await resumeLoopGuardState(getAdminClient(), tenantId, normalizePhone(leadRow.phone as string), "operator_reply");

  const filledBody = fillTemplateBody(template.bodyText, data.bodyParams);
  const { error: insertError } = await supabase
    .from("lead_messages")
    .insert({ lead_id: data.leadId, role: "assistant", body: filledBody });
  if (insertError) {
    return { status: "error", message: `Sent, but could not save to the thread: ${insertError.message}` };
  }

  return { status: "sent" };
}

export const sendLeadReplyWithTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { leadId: string; templateId: string; bodyParams: string[] }) => input)
  .handler(async ({ context, data }) => performSendLeadReplyWithTemplate(context.supabase, context.userId, data));
