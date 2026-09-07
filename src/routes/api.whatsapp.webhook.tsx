import { createFileRoute } from "@tanstack/react-router";
import { getAdminClient } from "@/lib/public-lead-server";
import { sendWhatsAppMessage, fetchTwilioMediaAsBase64, verifyTwilioSignature } from "@/lib/twilio-server";
import { handleInboundWhatsAppMessage, type ChannelAdapter } from "@/lib/whatsapp-conversation-server";

// Twilio-specific wire protocol only — signature verification, form-field
// parsing, tenant lookup by tenants.whatsapp_number. Everything about the
// actual conversation (48-hour continuation, Q&A pairing, AI pricing, lead
// creation) lives in whatsapp-conversation-server.ts's
// handleInboundWhatsAppMessage, shared with any future channel (e.g. a
// Meta Cloud API webhook) via the ChannelAdapter it's called with here.
//
// Raw HTTP handler, not createServerFn — Twilio's signature verification
// needs the exact raw form-encoded body, same reason the Stripe webhook
// (api.stripe.webhook.tsx) isn't a createServerFn either.
const twilioAdapter: ChannelAdapter = {
  sendMessage: (to, body) => sendWhatsAppMessage({ to, body }),
  fetchMedia: (ref) => fetchTwilioMediaAsBase64(ref),
};

export const Route = createFileRoute("/api/whatsapp/webhook")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const emptyTwiml = () =>
          new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
            status: 200,
            headers: { "content-type": "text/xml" },
          });

        const rawBody = await request.text();
        const formParams = Object.fromEntries(new URLSearchParams(rawBody));

        const signature = request.headers.get("x-twilio-signature");
        let signatureValid = false;
        try {
          signatureValid = verifyTwilioSignature({ signature, url: request.url, formParams });
        } catch (err) {
          console.error("Twilio signature check failed to run (env not configured?):", err);
        }
        if (!signatureValid) {
          console.error("Rejected WhatsApp webhook: invalid or missing Twilio signature.");
          return new Response("Invalid signature", { status: 403 });
        }

        const fromRaw = formParams["From"] || "";
        const toRaw = formParams["To"] || "";
        const body = (formParams["Body"] || "").trim();
        const numMedia = Number(formParams["NumMedia"] || "0");
        const mediaUrl = formParams["MediaUrl0"];
        const profileName = formParams["ProfileName"];

        const fromPhone = fromRaw.replace("whatsapp:", "");
        const toPhone = toRaw.replace("whatsapp:", "");

        if (!fromPhone || !toPhone) {
          console.error("WhatsApp webhook missing From/To.");
          return emptyTwiml();
        }

        const admin = getAdminClient();

        // Which business's number did this land on? A tenant with no
        // whatsapp_number set (still null) can never match here — Postgres
        // never satisfies `column = value` against a NULL column — so an
        // unconfigured tenant simply falls through to "unrecognized number"
        // below instead of ever being mistaken for the intended recipient.
        const { data: tenant, error: tenantError } = await admin
          .from("tenants")
          .select("id, slug, name, email, currency, labor_rate, service_call_fee")
          .eq("whatsapp_number", toPhone)
          .single();
        if (tenantError || !tenant) {
          console.error(`WhatsApp message to unrecognized number ${toPhone}:`, tenantError?.message);
          return emptyTwiml();
        }

        await handleInboundWhatsAppMessage({
          tenant: {
            id: tenant.id,
            slug: tenant.slug,
            name: tenant.name,
            email: tenant.email,
            currency: tenant.currency,
            laborRate: tenant.labor_rate,
            serviceCallFee: tenant.service_call_fee,
          },
          fromPhone,
          body,
          mediaRef: numMedia > 0 ? mediaUrl : undefined,
          profileName,
          channel: "WhatsApp",
          adapter: twilioAdapter,
        });

        return emptyTwiml();
      },
    },
  },
});
