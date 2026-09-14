import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sendWhatsAppMessage } from "@/lib/twilio-server";
import {
  sendWhatsAppMessageMeta,
  resolveActiveMetaConnectionForTenant,
  markConnectionFailed,
  MetaOutsideWindowError,
} from "@/lib/meta-whatsapp-server";

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

type SendResult = { status: "sent" } | { status: "error"; message: string };

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
            return {
              status: "error",
              message:
                "It's been more than 24 hours since this customer's last message — WhatsApp requires a pre-approved template to reach them now, which isn't set up yet.",
            };
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
