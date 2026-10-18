import crypto from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getAdminClient } from "@/lib/public-lead-server";
import { resumeLoopGuardState } from "@/lib/whatsapp-loop-guard-server";
import type { InboundWhatsAppTenant } from "@/lib/whatsapp-conversation-server";

// Meta WhatsApp Cloud API — Stage 2B: Embedded Signup + OAuth/token
// exchange only. No webhook, no inbound/outbound messaging, no templates —
// those are later sub-stages. Mirrors twilio-server.ts's shape (a small
// getCredentials()-style helper plus the actual calls), but nothing here
// is imported by whatsapp-conversation-server.ts or api.whatsapp.webhook.tsx
// — the two channels stay fully independent.

// Exported (along with graphUrl and describeMetaError below) because
// whatsapp-templates-server.ts also needs direct Graph API access
// (listing/creating/deleting message templates) without duplicating
// credential handling.
export function getMetaCredentials() {
  const appId = process.env["VITE_META_APP_ID"];
  const appSecret = process.env["META_APP_SECRET"];
  const apiVersion = process.env["META_API_VERSION"] || "v26.0";
  if (!appId || !appSecret) {
    throw new Error("Missing VITE_META_APP_ID or META_APP_SECRET on the server.");
  }
  return { appId, appSecret, apiVersion };
}

export function graphUrl(apiVersion: string, path: string) {
  return `https://graph.facebook.com/${apiVersion}${path}`;
}

type MetaSignupSuccess = { status: "connected"; displayPhoneNumber: string };
type MetaSignupError = { status: "error"; message: string };
export type MetaSignupResult = MetaSignupSuccess | MetaSignupError;

// Diagnostic only: pulls Meta's safe, non-secret error fields out of a
// failed Graph API response — never the raw body/URL, since these calls
// carry the app secret, access token, or authorization code as
// parameters. Meta's error shape is {error: {message, type, code,
// fbtrace_id}} — exactly those four fields and nothing else. Shared by
// every Graph API call in this file so whichever step fails, the log
// names the specific reason instead of just an HTTP status.
export async function describeMetaError(response: Response): Promise<string> {
  let detail = `HTTP ${response.status}`;
  try {
    const errorJson = (await response.json()) as {
      error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
    };
    const e = errorJson.error;
    if (e) {
      detail =
        [
          e.message && `message="${e.message}"`,
          e.type && `type=${e.type}`,
          e.code !== undefined && `code=${e.code}`,
          e.error_subcode !== undefined && `error_subcode=${e.error_subcode}`,
          e.fbtrace_id && `fbtrace_id=${e.fbtrace_id}`,
        ]
          .filter(Boolean)
          .join(", ") || detail;
    }
  } catch {
    // Body wasn't JSON (or had no error field) — fall back to just the
    // HTTP status, still no raw body logged.
  }
  return detail;
}

// The bare numeric error code, for callers that need to branch on which
// specific error this was (see MetaOutsideWindowError below) rather than
// just log the readable describeMetaError string. Takes its own Response —
// callers pass a .clone() so this and describeMetaError can each read the
// body once.
async function metaErrorCode(response: Response): Promise<number | undefined> {
  try {
    const errorJson = (await response.json()) as { error?: { code?: number } };
    return errorJson.error?.code;
  } catch {
    return undefined;
  }
}

// redirect_uri is omitted entirely — reopened and re-settled 2026-10-10.
// The original "confirmed fixed" claim here (send the SDK popup's exact
// dynamic xd_arbiter redirect_uri, captured via a window.open() intercept
// in ConnectWhatsAppMeta.tsx) was re-tested live against the real,
// multi-screen Business-Portfolio-creation flow and failed with
// error_subcode=36008 three separate times, with a verified-clean, correct
// capture each time (ruled out: capture bugs, overwrite from a second
// popup, wrong Business Portfolio path). The "static registered domain
// also fails" half of the original claim turned out to have been tested
// against a stale, no-longer-registered domain
// (front-desk-pro-ten.vercel.app, not www.jobitready.com) — re-tested
// against the actually-registered https://www.jobitready.com/dashboard/
// settings/business and it ALSO failed with the identical error. Omitting
// redirect_uri entirely — the one combination the original claim said
// fails outright — was re-tested clean via public/meta-test.html and
// succeeded, issuing a real access token for a real WABA/phone number.
// Whatever was true when the original claim was written no longer holds
// (API version, app config, and Advanced Access status have all changed
// since) — this is the current, live-reverified behavior.
async function exchangeCodeForToken(code: string): Promise<string> {
  const { appId, appSecret, apiVersion } = getMetaCredentials();
  const url = new URL(graphUrl(apiVersion, "/oauth/access_token"));
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", code);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Meta token exchange failed (${response.status}): ${await describeMetaError(response)}`);
  }
  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Meta token exchange returned no access_token.");
  }
  return json.access_token;
}

// The WABA and phone number are both identified by the client, captured
// from Meta's own WA_EMBEDDED_SIGNUP postMessage event fired inside the
// popup during the actual WABA/phone-number selection step (see
// ConnectWhatsAppMeta.tsx) — not discovered from the token via
// debug_token.granular_scopes, which never reflected a WABA-scoped grant
// for this app's configuration despite the configuration itself being set
// up correctly. Neither client-supplied id is trusted on its own: this
// asks Meta's own API, using the just-exchanged token, which phone numbers
// the client-reported WABA actually owns, and requires the client-reported
// phone_number_id to be one of them — a mismatched/forged client value is
// caught rather than silently written.
//
// Re-settled 2026-10-10: the original version of this check queried
// `/{phone_number_id}?fields=...,whatsapp_business_account` — the reverse
// direction — and failed with "(#100) Tried accessing nonexisting field
// (whatsapp_business_account)" the first time it was ever exercised against
// a real token (the redirect_uri fix above was the only thing blocking
// reaching this stage before). `whatsapp_business_account` was never a
// valid field on the phone-number node; the documented shape is the other
// way round (confirmed against this repo's own Stage 2B validation
// runbook, written before this bug was ever hit): GET
// /{waba_id}/phone_numbers returns {data: [{id, display_phone_number,
// ...}]}.
async function validatePhoneNumberAccess(
  wabaId: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<{ displayPhoneNumber: string }> {
  const { apiVersion } = getMetaCredentials();
  const url = new URL(graphUrl(apiVersion, `/${wabaId}/phone_numbers`));
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(
      `Could not verify this WhatsApp Business Account's phone numbers with the granted token (${response.status}): ${await describeMetaError(response)}`,
    );
  }
  const json = (await response.json()) as { data?: Array<{ id?: string; display_phone_number?: string }> };
  const match = (json.data ?? []).find((entry) => entry.id === phoneNumberId);
  if (!match?.display_phone_number) {
    throw new Error(
      "The phone number reported by the sign-in popup wasn't found under the selected WhatsApp Business Account.",
    );
  }
  return { displayPhoneNumber: match.display_phone_number };
}

async function subscribeAppToWaba(wabaId: string, accessToken: string): Promise<void> {
  const { apiVersion } = getMetaCredentials();
  const url = graphUrl(apiVersion, `/${wabaId}/subscribed_apps`);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (!response.ok) {
    throw new Error(
      `Could not subscribe to this WhatsApp Business Account's webhooks (${response.status}): ${await describeMetaError(response)}`,
    );
  }
}

// Generic, customer/tenant-facing — never Meta's raw error text (stage
// name, HTTP status, error_subcode, fbtrace_id). That detail is useful for
// debugging but is an internal implementation leak if shown to a real
// business owner; it stays in the server-side console.error calls below.
const SIGNUP_FAILED_MESSAGE = "Couldn't connect WhatsApp right now. Please try again in a moment.";

export const completeMetaWhatsAppSignup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { code: string; wabaId: string; phoneNumberId: string }) => input)
  .handler(async ({ context, data }): Promise<MetaSignupResult> => {
    const code = data.code?.trim();
    const clientWabaId = data.wabaId?.trim();
    const clientPhoneNumberId = data.phoneNumberId?.trim();
    if (!code) {
      return { status: "error", message: "Missing signup code." };
    }
    if (!clientWabaId || !clientPhoneNumberId) {
      return {
        status: "error",
        message: "Missing WhatsApp Business Account information from the sign-in popup. Please try again.",
      };
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

    // whatsapp_connections has zero RLS policies for authenticated users
    // (service-role only, see 0003's security model) — every read/write
    // against it here goes through the admin client, same as
    // public-lead-server.ts's pattern for anonymous customers.
    const admin = getAdminClient();

    // Pre-write authorization check — reject before touching Meta at all
    // if this tenant already has a non-terminal connection. Same "active"
    // semantics as 0003's own whatsapp_connections_one_active_per_tenant
    // index (status not in ('disconnected', 'failed')).
    const { data: existing } = await admin
      .from("whatsapp_connections")
      .select("id")
      .eq("tenant_id", tenantId)
      .neq("status", "disconnected")
      .neq("status", "failed")
      .maybeSingle();
    if (existing) {
      return {
        status: "error",
        message: "WhatsApp is already connected. Disconnect first to connect a different number.",
      };
    }

    // Stage tracking exists purely to make the server-side log line useful
    // (which step failed) — the stage name and Meta error detail are never
    // sent back to the client; a tenant only ever sees SIGNUP_FAILED_MESSAGE.
    let stage = "exchangeCodeForToken";
    let accessToken: string;
    let wabaId: string;
    let phoneNumberId: string;
    let displayPhoneNumber: string;
    try {
      accessToken = await exchangeCodeForToken(code);

      stage = "validatePhoneNumberAccess";
      const verified = await validatePhoneNumberAccess(clientWabaId, clientPhoneNumberId, accessToken);
      wabaId = clientWabaId;
      phoneNumberId = clientPhoneNumberId;
      displayPhoneNumber = verified.displayPhoneNumber;
    } catch (err) {
      // Nothing written yet, nothing called on Meta's subscription state —
      // genuinely no partial state at this point, local or external.
      // Detail (no token/code/secret — describeMetaError only ever extracts
      // message/type/code/error_subcode/fbtrace_id) is logged server-side
      // only; the client gets a generic message, never Meta's raw error text.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[Meta WhatsApp] ${stage} FAILED for tenant ${tenantId}: ${detail}`);
      return { status: "error", message: SIGNUP_FAILED_MESSAGE };
    }

    // Insert the local row BEFORE calling Meta's subscribed_apps — this is
    // the local commit point. If this insert fails, nothing external has
    // been mutated, so no compensation is needed. If the *next* step
    // (subscribing) fails, there is already a row to reflect that failure
    // against, instead of an invisible, orphaned Meta-side subscription
    // with no corresponding record anywhere in this database.
    const { data: connectionRow, error: insertError } = await admin
      .from("whatsapp_connections")
      .insert({
        tenant_id: tenantId,
        waba_id: wabaId,
        meta_phone_number_id: phoneNumberId,
        meta_system_user_token: accessToken,
        display_phone_number: displayPhoneNumber,
        status: "verifying",
      })
      .select("id")
      .single();
    if (insertError || !connectionRow) {
      console.error(`Could not save WhatsApp connection for tenant ${tenantId}:`, insertError?.message);
      return { status: "error", message: "Couldn't save the WhatsApp connection. Please try again." };
    }

    try {
      await subscribeAppToWaba(wabaId, accessToken);
    } catch (err) {
      // Meta-side subscription failed (or its success is unknown due to a
      // timeout) — the row already exists, so this is a visible, recoverable
      // failure rather than silent drift. Mark it terminal so a fresh signup
      // attempt passes the pre-write check above. Re-subscribing on a retry
      // is safe even if Meta actually processed this attempt despite the
      // client seeing an error — Meta's subscribe endpoint is idempotent.
      const reason = err instanceof Error ? err.message : "Webhook subscription failed.";
      await admin
        .from("whatsapp_connections")
        .update({ status: "failed", error_reason: `Connected to Meta but webhook subscription failed: ${reason}` })
        .eq("id", connectionRow.id);
      console.error(`[Meta WhatsApp] subscribeAppToWaba FAILED for tenant ${tenantId}: ${reason}`);
      return { status: "error", message: SIGNUP_FAILED_MESSAGE };
    }

    const { error: updateError } = await admin
      .from("whatsapp_connections")
      .update({ status: "online", connected_at: new Date().toISOString() })
      .eq("id", connectionRow.id);
    if (updateError) {
      // Meta is genuinely subscribed at this point; the row exists but is
      // left at 'verifying' rather than 'online' — not lost, not orphaned,
      // just not yet reflecting full success. Reconciling a 'verifying' row
      // is a later-sub-stage concern (e.g. a "check connection status"
      // action), not something silently hidden here.
      console.error(`[Meta WhatsApp] finalize-status FAILED for tenant ${tenantId}: ${updateError.message}`);
      return { status: "error", message: "Connected, but finishing setup is taking longer than expected. Please refresh in a moment." };
    }

    console.log(`[Meta WhatsApp] COMPLETE ✓ tenant=${tenantId}`);
    return { status: "connected", displayPhoneNumber };
  });

// --- Stage 2C: inbound webhook + outbound send/media, used by
// api.whatsapp.meta-webhook.tsx ------------------------------------------

// Meta signs every webhook POST with HMAC-SHA256 over the raw body, using
// the app secret — same spirit as Twilio's signature check in
// twilio-server.ts, different algorithm and header. Constant-time compare,
// same reasoning as verifyTwilioSignature: a signature check should never
// short-circuit on the first mismatched byte.
export function verifyMetaWebhookSignature(rawBody: string, header: string | null): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const { appSecret } = getMetaCredentials();
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf-8").digest("hex");
  const actual = header.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

// The routing key an inbound Meta webhook is resolved by. `status = 'online'`
// is what actually makes a disconnected tenant stop receiving messages,
// independent of how fast Meta's own unsubscribe propagates; `.single()`
// (not .maybeSingle() or an unbounded list) means that if the
// meta_phone_number_id_active_idx uniqueness constraint were ever somehow
// violated, this fails loudly instead of silently routing to one of two
// matching tenants. Returns the token this tenant's connection stored, plus
// exactly the tenant fields handleInboundWhatsAppMessage needs — never the
// whole row.
export async function resolveActiveMetaConnection(
  phoneNumberId: string,
): Promise<{ connectionId: string; accessToken: string; tenant: InboundWhatsAppTenant } | null> {
  const admin = getAdminClient();
  const { data, error } = await admin
    .from("whatsapp_connections")
    .select(
      "id, meta_system_user_token, tenants!inner(id, slug, name, email, currency, labor_rate, service_call_fee, service_call_fee_mode)",
    )
    .eq("meta_phone_number_id", phoneNumberId)
    .eq("status", "online")
    .single();
  if (error || !data) return null;

  const connectionId = data["id"] as string;
  const accessToken = data["meta_system_user_token"] as string | null;
  const tenantRow = data["tenants"] as unknown as {
    id: string;
    slug: string;
    name: string;
    email: string;
    currency: string;
    labor_rate: number;
    service_call_fee: number;
    service_call_fee_mode: "fixed" | "negotiated";
  };
  if (!accessToken || !tenantRow) return null;

  return {
    connectionId,
    accessToken,
    tenant: {
      id: tenantRow.id,
      slug: tenantRow.slug,
      name: tenantRow.name,
      email: tenantRow.email,
      currency: tenantRow.currency,
      laborRate: tenantRow.labor_rate,
      serviceCallFee: tenantRow.service_call_fee,
      serviceCallFeeMode: tenantRow.service_call_fee_mode,
    },
  };
}

// The reverse lookup direction from resolveActiveMetaConnection above: given
// a tenant (not a phone_number_id), find their one active Meta connection,
// if any — used by lead-reply-server.ts to decide whether a given tenant's
// outbound WhatsApp reply should go through Meta at all, before it even
// gets to picking Twilio vs Meta.
export async function resolveActiveMetaConnectionForTenant(
  tenantId: string,
): Promise<{ connectionId: string; phoneNumberId: string; accessToken: string } | null> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("whatsapp_connections")
    .select("id, meta_phone_number_id, meta_system_user_token")
    .eq("tenant_id", tenantId)
    .eq("status", "online")
    .maybeSingle();
  if (!data) return null;

  const phoneNumberId = data["meta_phone_number_id"] as string | null;
  const accessToken = data["meta_system_user_token"] as string | null;
  if (!phoneNumberId || !accessToken) return null;

  return { connectionId: data["id"] as string, phoneNumberId, accessToken };
}

// The reverse lookup direction again, but for template management (create/
// delete), which needs the WABA id, not the phone_number_id
// resolveActiveMetaConnectionForTenant returns — templates are a
// WABA-level resource, not a phone-number-level one. Kept as its own
// function rather than widening resolveActiveMetaConnectionForTenant's
// return shape, since that one's existing callers (lead-reply-server.ts)
// don't need wabaId and shouldn't have to change to accommodate it.
export async function resolveActiveMetaWabaForTenant(
  tenantId: string,
): Promise<{ connectionId: string; wabaId: string; accessToken: string } | null> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("whatsapp_connections")
    .select("id, waba_id, meta_system_user_token")
    .eq("tenant_id", tenantId)
    .eq("status", "online")
    .maybeSingle();
  if (!data) return null;

  const wabaId = data["waba_id"] as string | null;
  const accessToken = data["meta_system_user_token"] as string | null;
  if (!wabaId || !accessToken) return null;

  return { connectionId: data["id"] as string, wabaId, accessToken };
}

// Meta's error code for "this free-form message is outside the 24-hour
// customer-service window, send a pre-approved template instead" — see
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes.
// Distinguished from every other send failure precisely so the caller can
// tell "this connection is broken" apart from "this specific message needs
// a template we don't send yet" — conflating them would mark a perfectly
// healthy connection as failed and show the owner a misleading reconnect
// prompt for something a reconnect can't fix.
const OUTSIDE_WINDOW_ERROR_CODE = 131047;

export class MetaOutsideWindowError extends Error {}

export async function sendWhatsAppMessageMeta(params: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  body: string;
}): Promise<void> {
  const { apiVersion } = getMetaCredentials();
  const response = await fetch(graphUrl(apiVersion, `/${params.phoneNumberId}/messages`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: params.to.replace(/^\+/, ""),
      type: "text",
      text: { body: params.body },
    }),
  });
  if (!response.ok) {
    const detail = await describeMetaError(response.clone());
    const errorCode = await metaErrorCode(response);
    if (errorCode === OUTSIDE_WINDOW_ERROR_CODE) {
      throw new MetaOutsideWindowError(`Meta send failed (${response.status}): ${detail}`);
    }
    throw new Error(`Meta send failed (${response.status}): ${detail}`);
  }
}

// The template-send counterpart to sendWhatsAppMessageMeta above — used
// once a template is status: 'approved' and the 24-hour window has closed
// on a conversation. bodyParams fills {{1}}/{{2}}/... in template order;
// omitted entirely when the template has no variables, matching Meta's own
// expectation that a components array isn't sent for a fixed-text template.
export async function sendWhatsAppTemplateMessage(params: {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  templateName: string;
  language: string;
  bodyParams: string[];
}): Promise<void> {
  const { apiVersion } = getMetaCredentials();
  const response = await fetch(graphUrl(apiVersion, `/${params.phoneNumberId}/messages`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: params.to.replace(/^\+/, ""),
      type: "template",
      template: {
        name: params.templateName,
        language: { code: params.language },
        ...(params.bodyParams.length > 0
          ? { components: [{ type: "body", parameters: params.bodyParams.map((text) => ({ type: "text", text })) }] }
          : {}),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Meta template send failed (${response.status}): ${await describeMetaError(response)}`);
  }
}

// Meta's media retrieval is a two-step lookup, unlike Twilio's stable media
// URL: GET /{media-id} for a short-lived CDN URL + mime type, then GET that
// URL with the same Bearer token. Same return shape as
// fetchTwilioMediaAsBase64 so handleInboundWhatsAppMessage doesn't need to
// know which channel it came from.
export async function fetchMetaMediaAsBase64(
  mediaId: string,
  accessToken: string,
): Promise<{ base64: string; mediaType: string }> {
  const { apiVersion } = getMetaCredentials();
  const lookup = await fetch(graphUrl(apiVersion, `/${mediaId}`), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!lookup.ok) {
    throw new Error(`Could not look up Meta media (${lookup.status}): ${await describeMetaError(lookup)}`);
  }
  const { url, mime_type: mimeType } = (await lookup.json()) as { url?: string; mime_type?: string };
  if (!url) {
    throw new Error("Meta media lookup returned no URL.");
  }

  const download = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!download.ok) {
    throw new Error(`Could not download Meta media (${download.status}).`);
  }
  const buffer = Buffer.from(await download.arrayBuffer());
  return { base64: buffer.toString("base64"), mediaType: mimeType || "image/jpeg" };
}

// Marks a connection broken and records why, so it's visible the next time
// anyone calls getMyWhatsAppConnection below — the pragmatic equivalent of
// Tel-Agent's in-process health registry, sized to what this schema already
// has (whatsapp_connections.status/error_reason from 0003) rather than a
// new notification system. Any send failure is treated as connection-
// affecting, not just token-expiry specifically — a deliberate
// simplification: the cost of over-triggering on a transient failure is a
// reconnect prompt the owner didn't strictly need, not a broken feature.
export async function markConnectionFailed(connectionId: string, reason: string): Promise<void> {
  const admin = getAdminClient();

  // Read the status before updating it, so the notification below only
  // fires on the actual transition into 'failed' — not on every subsequent
  // send attempt against a connection that's already broken, which would
  // spam the owner with a duplicate email for the same underlying problem.
  const { data: before } = await admin
    .from("whatsapp_connections")
    .select("status, tenants!inner(name, email)")
    .eq("id", connectionId)
    .single();

  await admin
    .from("whatsapp_connections")
    .update({ status: "failed", error_reason: reason.slice(0, 500) })
    .eq("id", connectionId);

  if (before && before["status"] !== "failed") {
    const tenantRow = before["tenants"] as unknown as { name: string; email: string } | null;
    if (tenantRow?.email) {
      // Dynamic import, not a top-level static one: this file is imported
      // directly by client components (ConnectWhatsAppMeta.tsx,
      // WhatsAppStatusLight.tsx) for their server-function RPC stubs. A
      // static import of notify-server.ts here pulls nodemailer's whole
      // module graph (node:os/node:stream) into the dev-server's client
      // bundle too, even though this only ever runs inside this server
      // function — production is unaffected (the build-time compiler
      // already splits server-function bodies out of the client bundle),
      // but `vite dev` serves modules more literally and doesn't do that
      // same split, causing a real "Class extends value undefined" crash on
      // any client page that so much as imports this file.
      const { sendConnectionFailedNotificationEmail } = await import("@/lib/notify-server");
      await sendConnectionFailedNotificationEmail({ tenant: tenantRow, reason });
    }
  }
}

// Duplicate-delivery dedup (Stage 2D, built in after auditing against
// Tel-Agent's `last_wamid` equivalent). Insert-and-catch-conflict IS the
// check: a second delivery of the same wamid hits
// whatsapp_processed_messages' primary key and this returns true, so the
// caller skips processing before any AI call or send happens. Postgres
// error code 23505 is unique_violation — anything else is a real failure,
// not a duplicate, and is rethrown rather than silently treated as "already
// processed."
export async function wasMessageAlreadyProcessed(messageId: string): Promise<boolean> {
  const admin = getAdminClient();
  const { error } = await admin.from("whatsapp_processed_messages").insert({ message_id: messageId });
  if (!error) return false;
  if (error.code === "23505") return true;
  throw new Error(`Could not record processed message id: ${error.message}`);
}

// Coexistence human-takeover tracking (0020_whatsapp_human_takeovers.sql).
// recordHumanTakeover is called for every smb_message_echoes entry — the
// business owner sending a message via the connected WhatsApp Business App
// itself. hasRecentHumanTakeover is checked before the bot would otherwise
// auto-reply to a customer; a recent echo means a human is already
// personally handling this conversation, so the bot defers rather than
// injecting its canned reply into the middle of it. 48h matches the
// existing "open lead" conversation window this codebase already uses
// elsewhere (whatsapp-conversation-server.ts), for the same reason: that's
// the window already established as "the same conversation."
const HUMAN_TAKEOVER_WINDOW_MS = 48 * 60 * 60 * 1000;

export async function recordHumanTakeover(tenantId: string, phone: string): Promise<void> {
  const admin = getAdminClient();
  const { error } = await admin
    .from("whatsapp_human_takeovers")
    .upsert({ tenant_id: tenantId, phone, last_echo_at: new Date().toISOString() }, { onConflict: "tenant_id,phone" });
  if (error) {
    console.error("Could not record WhatsApp human takeover:", error.message);
  }
  // A human is now personally handling this conversation via their own
  // connected WhatsApp Business App — the automated-loop concern is moot,
  // so any tripped loop guard for this (tenant, phone) is cleared too.
  // 'meta_human_echo' is one of the fixed, authorized resume reasons
  // (see 0024_whatsapp_loop_guards.sql) — never a bare "new message
  // arrived." resumeLoopGuardState already catches/logs its own errors
  // and never throws, so a failure here can't affect the takeover
  // recording above. tenantId/phone here are always the specific tenant
  // and customer this echo was addressed to (resolved from the echo's own
  // connection + `to` field by the caller) — never any other tenant's.
  await resumeLoopGuardState(admin, tenantId, phone, "meta_human_echo");
}

export async function hasRecentHumanTakeover(tenantId: string, phone: string): Promise<boolean> {
  const admin = getAdminClient();
  const { data } = await admin
    .from("whatsapp_human_takeovers")
    .select("last_echo_at")
    .eq("tenant_id", tenantId)
    .eq("phone", phone)
    .maybeSingle();
  if (!data?.last_echo_at) return false;
  return Date.now() - new Date(data.last_echo_at as string).getTime() < HUMAN_TAKEOVER_WINDOW_MS;
}

export type MyWhatsAppConnection = {
  status: "creating" | "offline" | "verifying" | "online" | "failed" | "disconnected";
  displayPhoneNumber: string | null;
  errorReason: string | null;
  connectedAt: string | null;
};

// The dashboard-facing read — auth-gated, hand-picked non-secret fields
// only (status, display number, error reason, connected_at), never
// meta_system_user_token/waba_id/meta_phone_number_id. Returns null when
// the tenant has never connected (not an error — a business that hasn't
// set this up yet is the normal case, not a failure).
export const getMyWhatsAppConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyWhatsAppConnection | null> => {
    const { data: tenantRow } = await context.supabase
      .from("tenants")
      .select("id")
      .eq("user_id", context.userId)
      .single();
    if (!tenantRow) return null;

    const admin = getAdminClient();
    const { data } = await admin
      .from("whatsapp_connections")
      .select("status, display_phone_number, error_reason, connected_at")
      .eq("tenant_id", tenantRow.id as string)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;

    return {
      status: data["status"] as MyWhatsAppConnection["status"],
      displayPhoneNumber: (data["display_phone_number"] as string | null) ?? null,
      errorReason: (data["error_reason"] as string | null) ?? null,
      connectedAt: (data["connected_at"] as string | null) ?? null,
    };
  });

type DisconnectResult = { status: "disconnected" } | { status: "error"; message: string };

// Auth-gated, derives tenant_id server-side from the session — never
// accepts a client-supplied connectionId, so there is nothing for a client
// to even attempt to point at another tenant's connection. Nulls out
// meta_system_user_token immediately: a disconnected token is a live
// secret with no further legitimate use, and reconnecting always mints a
// fresh one via a new Embedded Signup run rather than reusing the old one.
export const disconnectMetaWhatsApp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<DisconnectResult> => {
    const { data: tenantRow, error: tenantError } = await context.supabase
      .from("tenants")
      .select("id")
      .eq("user_id", context.userId)
      .single();
    if (tenantError || !tenantRow) {
      return { status: "error", message: "Could not find your business." };
    }

    const admin = getAdminClient();
    const { data: connection, error: findError } = await admin
      .from("whatsapp_connections")
      .select("id, waba_id, meta_system_user_token")
      .eq("tenant_id", tenantRow.id as string)
      .neq("status", "disconnected")
      .neq("status", "failed")
      .maybeSingle();
    if (findError) {
      return { status: "error", message: "Could not look up your WhatsApp connection." };
    }
    if (!connection) {
      // Nothing active to disconnect — not an error, the end state is the
      // same either way.
      return { status: "disconnected" };
    }

    const wabaId = connection["waba_id"] as string | null;
    const accessToken = connection["meta_system_user_token"] as string | null;
    if (wabaId && accessToken) {
      try {
        const { apiVersion } = getMetaCredentials();
        const response = await fetch(graphUrl(apiVersion, `/${wabaId}/subscribed_apps`), {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
          // Meta-side unsubscribe failing doesn't block disconnecting
          // locally — an owner asking to disconnect should never get stuck
          // because Meta's API had a bad moment. Logged, not fatal.
          console.error(
            `[Meta WhatsApp] unsubscribe failed for connection ${connection["id"]}: ${await describeMetaError(response)}`,
          );
        }
      } catch (err) {
        console.error(`[Meta WhatsApp] unsubscribe request failed for connection ${connection["id"]}:`, err);
      }
    }

    const { error: updateError } = await admin
      .from("whatsapp_connections")
      .update({
        status: "disconnected",
        disconnected_at: new Date().toISOString(),
        meta_system_user_token: null,
      })
      .eq("id", connection["id"] as string);
    if (updateError) {
      return { status: "error", message: "Could not disconnect WhatsApp. Please try again." };
    }

    return { status: "disconnected" };
  });
