import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sendWhatsAppMessage } from "@/lib/twilio-server";
import {
  sendWhatsAppMessageMeta,
  sendWhatsAppTemplateMessage,
  resolveActiveMetaConnectionForTenant,
  markConnectionFailed,
  MetaOutsideWindowError,
} from "@/lib/meta-whatsapp-server";
import { getApprovedWhatsAppTemplate, fillTemplateBody } from "@/lib/whatsapp-templates-server";

// Resolves which of the two independent WhatsApp channels a tenant actually
// has active (Twilio's concierge-connected number, or their own Meta
// Embedded Signup connection) and sends through whichever one it is.
// Deliberately the one place allowed to know about both — the opposite
// direction from whatsapp-conversation-server.ts's own rule about staying
// channel-pure: that file processes a message that already arrived on one
// specific channel and must never reach for the other's credentials. This
// function's entire job is the reverse — given a tenant, decide which one
// channel they're using — so having visibility into both is the correct
// shape here, not a violation of that same reasoning.

// "outside_window" is its own variant, not folded into "error" — the UI
// needs to reliably branch to "offer a template instead" without string-
// matching an error message, which would break the moment the copy changes.
type SendResult = { status: "sent" } | { status: "error"; message: string } | { status: "outside_window" };

export const sendLeadReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { leadId: string; body: string }) => input)
  .handler(async ({ context, data }): Promise<SendResult> => {
    const body = data.body.trim();
    if (!body) {
      return { status: "error", message: "Message can't be empty." };
    }

    const { data: tenantRow, error: tenantError } = await context.supabase
      .from("tenants")
      .select("id, whatsapp_number")
      .eq("user_id", context.userId)
      .single();
    if (tenantError || !tenantRow) {
      return { status: "error", message: "Could not find your business." };
    }
    const tenantId = tenantRow.id as string;

    const { data: leadRow, error: leadError } = await context.supabase
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

      const twilioNumber = tenantRow.whatsapp_number as string | null;
      if (twilioNumber) {
        try {
          await sendWhatsAppMessage({ to, body });
        } catch (err) {
          return {
            status: "error",
            message: err instanceof Error ? err.message : "Could not send the WhatsApp message.",
          };
        }
      } else {
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
          });
        } catch (err) {
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
      }
    }

    // Only recorded once the real send (if any) succeeded — a WhatsApp
    // lead whose send failed never gets an "assistant" row implying it
    // reached the customer, so the thread stays honest about what
    // actually went out instead of just what was typed.
    const { error: insertError } = await context.supabase
      .from("lead_messages")
      .insert({ lead_id: data.leadId, role: "assistant", body });
    if (insertError) {
      return { status: "error", message: `Sent, but could not save to the thread: ${insertError.message}` };
    }

    return { status: "sent" };
  });

// The re-engagement path for a lead sendLeadReply just reported
// "outside_window" on — Meta-only (Twilio has no template mechanism in this
// codebase, an accepted gap noted in ROADMAP.md), so this only ever looks
// at the tenant's Meta connection, never Twilio. Template-only: never
// falls back to a free-form send, since Meta would just reject that outside
// the window anyway.
export const sendLeadReplyWithTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { leadId: string; templateId: string; bodyParams: string[] }) => input)
  .handler(async ({ context, data }): Promise<SendResult> => {
    const { data: tenantRow, error: tenantError } = await context.supabase
      .from("tenants")
      .select("id")
      .eq("user_id", context.userId)
      .single();
    if (tenantError || !tenantRow) {
      return { status: "error", message: "Could not find your business." };
    }
    const tenantId = tenantRow.id as string;

    const { data: leadRow, error: leadError } = await context.supabase
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
      });
    } catch (err) {
      await markConnectionFailed(metaConnection.connectionId, err instanceof Error ? err.message : "Template send failed.");
      return { status: "error", message: err instanceof Error ? err.message : "Could not send the template." };
    }

    const filledBody = fillTemplateBody(template.bodyText, data.bodyParams);
    const { error: insertError } = await context.supabase
      .from("lead_messages")
      .insert({ lead_id: data.leadId, role: "assistant", body: filledBody });
    if (insertError) {
      return { status: "error", message: `Sent, but could not save to the thread: ${insertError.message}` };
    }

    return { status: "sent" };
  });
