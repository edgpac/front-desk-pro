import { createFileRoute } from "@tanstack/react-router";
import {
  verifyMetaWebhookSignature,
  resolveActiveMetaConnection,
  sendWhatsAppMessageMeta,
  fetchMetaMediaAsBase64,
  markConnectionFailed,
  wasMessageAlreadyProcessed,
  MetaOutsideWindowError,
} from "@/lib/meta-whatsapp-server";
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

// Every rejection reason (bad signature, unknown/inactive phone_number_id,
// missing server config) answers identically to an outside caller — same
// reasoning as Tel-Agent's equivalent: distinguishing them would turn this
// address into an oracle for probing why a request failed. The real reason
// is still logged server-side for operator visibility; it's just never in
// the response body.
function refused(): Response {
  return new Response("Forbidden", { status: 403 });
}

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
          return refused();
        }
        if (mode === "subscribe" && token === expectedToken && challenge) {
          return new Response(challenge, { status: 200 });
        }
        console.error("Meta WhatsApp webhook handshake refused: mode/token mismatch.");
        return refused();
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
          return refused();
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
            const { connectionId, accessToken, tenant } = connection;

            const adapter: ChannelAdapter = {
              sendMessage: async (to, body) => {
                try {
                  await sendWhatsAppMessageMeta({ phoneNumberId, accessToken, to, body });
                } catch (err) {
                  if (err instanceof MetaOutsideWindowError) {
                    // Not a connection problem — Meta requires a
                    // pre-approved template outside the 24-hour
                    // customer-service window, which this codebase doesn't
                    // send yet (see ROADMAP.md). Logged, not marked as a
                    // broken connection — a reconnect wouldn't fix this.
                    console.error(
                      `[Meta WhatsApp] send blocked by 24h window for tenant ${tenant.id}: ${err.message}`,
                    );
                    throw err;
                  }
                  // Any other send failure (not a webhook/signature
                  // problem, an actual Meta-API-rejected-the-send problem)
                  // is the clearest signal this connection is broken — an
                  // expired or revoked token, most likely. Marked here, not
                  // deeper in sendWhatsAppMessageMeta, which has no
                  // business knowing about whatsapp_connections rows.
                  await markConnectionFailed(
                    connectionId,
                    err instanceof Error ? err.message : "WhatsApp send failed.",
                  );
                  throw err;
                }
              },
              fetchMedia: (ref) => fetchMetaMediaAsBase64(ref, accessToken),
            };

            const profileName = value.contacts?.[0]?.profile?.name;

            for (const message of messages) {
              // Duplicate-delivery dedup: Meta can redeliver a webhook that
              // didn't get a fast-enough 200. Insert-and-catch-conflict
              // against whatsapp_processed_messages IS the check — a wamid
              // seen before returns true here and this message is skipped
              // before any AI call or send happens.
              if (await wasMessageAlreadyProcessed(message.id)) {
                console.log(`Meta WhatsApp message ${message.id} already processed, skipping.`);
                continue;
              }

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
                // in this route. But the customer must never be met with
                // silence — same fallback-message requirement api.whatsapp
                // .webhook.tsx (Twilio) already has for the identical
                // failure (a getQuoteEstimate validation/retry exhaustion,
                // live-confirmed during P1-E testing: the customer got no
                // reply at all and had no way to know anything went wrong).
                console.error(`Meta WhatsApp message handling failed for tenant ${tenant.id}:`, err);
                try {
                  await adapter.sendMessage(
                    fromPhone,
                    "Sorry, I couldn't put together a reliable estimate for that just now — I'll have the team follow up with you directly.",
                  );
                } catch (sendErr) {
                  console.error("Also failed to send the WhatsApp fallback message:", sendErr);
                }
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
