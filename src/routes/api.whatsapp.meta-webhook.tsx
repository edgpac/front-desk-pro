import { createFileRoute } from "@tanstack/react-router";
import { verifyMetaWebhookSignature, resolveActiveMetaConnection, sendWhatsAppMessageMeta, fetchMetaMediaAsBase64 } from "@/lib/meta-whatsapp-server";
import { handleInboundWhatsAppMessage, type ChannelAdapter } from "@/lib/whatsapp-conversation-server";

// Meta-specific wire protocol only — GET handshake, POST signature
// verification, payload parsing, tenant lookup by phone_number_id.
// Everything about the actual conversation (48-hour continuation, Q&A
// pairing, AI pricing, lead creation) lives in
// whatsapp-conversation-server.ts's handleInboundWhatsAppMessage, the exact
// same shared function api.whatsapp.webhook.tsx (Twilio) already calls —
// this route only ever talks through the ChannelAdapter it builds below,
// never touches twilio-server.ts or its credentials.
//
// Raw HTTP handler, not createServerFn — the signature check needs the
// exact raw request body, same reason api.whatsapp.webhook.tsx isn't one.
//
// Deliberately NOT hardened yet, matching the original Stage 2C scope: no
// duplicate-delivery dedup against Meta's message id (Meta can redeliver a
// webhook; Twilio's own webhook doesn't need this the same way). That's a
// Stage 2D concern — this route is enough for a real, working, if naive,
// round trip, not the final hardened version.
export const Route = createFileRoute("/api/whatsapp/meta-webhook")({
  server: {
    handlers: {
      // Meta's one-time (per callback-URL registration/change) GET
      // handshake — echoes hub.challenge back as plain text if
      // hub.verify_token matches what was entered in the Meta dashboard.
      GET: async ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");

        const expectedToken = process.env["META_WEBHOOK_VERIFY_TOKEN"];
        if (!expectedToken) {
          console.error("META_WEBHOOK_VERIFY_TOKEN is not set on the server.");
          return new Response("Not configured", { status: 500 });
        }
        if (mode === "subscribe" && token === expectedToken && challenge) {
          return new Response(challenge, { status: 200 });
        }
        return new Response("Forbidden", { status: 403 });
      },

      POST: async ({ request }: { request: Request }) => {
        const rawBody = await request.text();
        const signature = request.headers.get("x-hub-signature-256");

        let signatureValid = false;
        try {
          signatureValid = verifyMetaWebhookSignature(rawBody, signature);
        } catch (err) {
          console.error("Meta webhook signature check failed to run (env not configured?):", err);
        }
        if (!signatureValid) {
          console.error("Rejected Meta WhatsApp webhook: invalid or missing X-Hub-Signature-256.");
          return new Response("Invalid signature", { status: 403 });
        }

        let payload: MetaWebhookPayload;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          console.error("Meta WhatsApp webhook: body wasn't valid JSON.");
          return new Response("OK", { status: 200 }); // ack anyway — Meta would just retry a malformed body forever
        }

        for (const entry of payload.entry ?? []) {
          for (const change of entry.changes ?? []) {
            const value = change.value;
            const phoneNumberId = value?.metadata?.phone_number_id;
            const messages = value?.messages ?? [];
            if (!phoneNumberId || messages.length === 0) continue;

            const connection = await resolveActiveMetaConnection(phoneNumberId);
            if (!connection) {
              // Either an unrecognized number, or a since-disconnected tenant
              // (the status = 'online' filter excludes it) — same posture as
              // Twilio's "unrecognized number" case: log it, touch nothing,
              // ack so Meta stops retrying.
              console.error(`Meta WhatsApp message to unrecognized/inactive phone_number_id ${phoneNumberId}`);
              continue;
            }
            const { accessToken, tenant } = connection;

            const adapter: ChannelAdapter = {
              sendMessage: (to, body) =>
                sendWhatsAppMessageMeta({ phoneNumberId, accessToken, to, body }),
              fetchMedia: (ref) => fetchMetaMediaAsBase64(ref, accessToken),
            };

            const profileName = value.contacts?.[0]?.profile?.name;

            for (const message of messages) {
              const fromPhone = `+${message.from}`;
              const body = message.type === "text" ? (message.text?.body ?? "").trim() : "";
              const mediaRef = message.type === "image" ? message.image?.id : undefined;

              try {
                await handleInboundWhatsAppMessage({
                  tenant,
                  fromPhone,
                  body,
                  mediaRef,
                  profileName,
                  channel: "WhatsApp",
                  adapter,
                });
              } catch (err) {
                // One bad message in a batch shouldn't drop the rest, and
                // Meta still needs its 200 regardless — same "log and move
                // on" posture as every other unrecoverable-per-message case
                // in this route.
                console.error(`Meta WhatsApp message handling failed for tenant ${tenant.id}:`, err);
              }
            }
          }
        }

        return new Response("OK", { status: 200 });
      },
    },
  },
});

// Meta's webhook payload shape, narrowed to exactly the fields this route
// reads — never the whole thing, matching this codebase's field-allowlist
// convention elsewhere.
type MetaWebhookPayload = {
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { profile?: { name?: string } }[];
        messages?: {
          from: string;
          id: string;
          type: string;
          text?: { body?: string };
          image?: { id?: string };
        }[];
      };
    }[];
  }[];
};
