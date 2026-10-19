import crypto from "node:crypto";
import { getAdminClient } from "@/lib/public-lead-server";
import { isOptedOut, normalizePhone, WhatsAppOptedOutError } from "@/lib/whatsapp-opt-out-server";

// Real Twilio calls, no SDK — Twilio's API is a plain form-encoded POST with
// Basic Auth, and the signature check is documented HMAC-SHA1. Ported the
// insight (not the code) from the n8n templates: going through Twilio as the
// WhatsApp Business Solution Provider is a real, much faster path than
// applying to Meta directly as an independent Tech Provider.

function getCredentials() {
  const accountSid = process.env["TWILIO_ACCOUNT_SID"];
  const authToken = process.env["TWILIO_AUTH_TOKEN"];
  const fromNumber = process.env["TWILIO_WHATSAPP_NUMBER"]; // e.g. "whatsapp:+14155238886"
  if (!accountSid || !authToken || !fromNumber) {
    throw new Error("Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_WHATSAPP_NUMBER.");
  }
  return { accountSid, authToken, fromNumber };
}

// tenantId is required specifically so this one place — the actual HTTP
// call to Twilio, which every outbound WhatsApp send in this codebase
// eventually funnels through — can enforce the opt-out check itself
// rather than trusting every caller to have checked first. A deliberate
// exception to this file otherwise being a pure API wrapper with no
// database awareness: the explicit requirement is that no caller can
// bypass this check, and the only way to guarantee that is to make it
// impossible to call this function at all without it running.
export async function sendWhatsAppMessage(params: {
  to: string;
  body: string;
  tenantId: string;
  // NEVER set this to true except from whatsapp-opt-out-server.ts's own
  // opt-out CONFIRMATION send — the one message that must legitimately
  // reach a number the instant it transitions to opted-out (compliance
  // requires confirming the opt-out itself), sent immediately after
  // recordOptOut has already written that same opted-out state. Every
  // other caller must leave this unset/false so the check below applies.
  allowWhileOptedOut?: boolean | undefined;
}): Promise<void> {
  // Fails CLOSED: if this check itself can't be verified, do not send —
  // see OptOutCheckFailed's own comment for why this is the safer
  // direction for a compliance check specifically.
  if (!params.allowWhileOptedOut && (await isOptedOut(getAdminClient(), params.tenantId, normalizePhone(params.to)))) {
    throw new WhatsAppOptedOutError(`Tenant ${params.tenantId}, phone ${params.to} is opted out of WhatsApp messages.`);
  }
  const { accountSid, authToken, fromNumber } = getCredentials();
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      From: fromNumber,
      To: params.to.startsWith("whatsapp:") ? params.to : `whatsapp:${params.to}`,
      Body: params.body,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Twilio send failed (${response.status}): ${text.slice(0, 300)}`);
  }
}

// Downloads a customer's photo from Twilio's media URL (requires the same
// Basic Auth as sending — Twilio doesn't serve media publicly) and returns
// it as a base64 string, ready for getQuoteEstimate's imageBase64 input.
export async function fetchTwilioMediaAsBase64(
  mediaUrl: string,
): Promise<{ base64: string; mediaType: string }> {
  const { accountSid, authToken } = getCredentials();
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const response = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!response.ok) {
    throw new Error(`Could not download media from Twilio (${response.status}).`);
  }
  const mediaType = response.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await response.arrayBuffer());
  return { base64: buffer.toString("base64"), mediaType };
}

// Twilio signs every webhook request with the exact URL + sorted POST params,
// HMAC-SHA1'd with the auth token — same spirit as Stripe's signature check
// in api.stripe.webhook.tsx, different algorithm. Rejecting an unsigned or
// mis-signed request means someone else can't forge inbound "messages."
export function verifyTwilioSignature(params: {
  signature: string | null;
  url: string;
  formParams: Record<string, string>;
}): boolean {
  const { authToken } = getCredentials();
  if (!params.signature) return false;

  const sortedKeys = Object.keys(params.formParams).sort();
  const data = sortedKeys.reduce((acc, key) => acc + key + params.formParams[key], params.url);

  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");

  // Constant-time comparison — signature checks should never short-circuit
  // on the first mismatched byte.
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(params.signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
