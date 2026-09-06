import crypto from "node:crypto";

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

export async function sendWhatsAppMessage(params: { to: string; body: string }): Promise<void> {
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
