import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getAdminClient } from "@/lib/public-lead-server";

// Meta WhatsApp Cloud API — Stage 2B: Embedded Signup + OAuth/token
// exchange only. No webhook, no inbound/outbound messaging, no templates —
// those are later sub-stages. Mirrors twilio-server.ts's shape (a small
// getCredentials()-style helper plus the actual calls), but nothing here
// is imported by whatsapp-conversation-server.ts or api.whatsapp.webhook.tsx
// — the two channels stay fully independent.

// Exported (along with graphUrl and describeMetaError below) only so the
// TEMPORARY diagnostic route (src/routes/api.meta-test-exchange.tsx) can
// build its own redirect_uri experiment without duplicating credential
// handling. No logic in any of these three functions has changed.
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

// redirect_uri is required, not optional: Meta binds the authorization
// code to the exact redirect_uri the SDK's popup used when it opened (a
// dynamic https://staticxx.facebook.com/x/connect/xd_arbiter/... URL,
// unique per attempt, captured client-side — see ConnectWhatsAppMeta.tsx's
// window.open() interception). Confirmed via live A/B testing: omitting
// it, or sending the app's own registered domain, both fail with
// error_subcode=36008 ("redirect_uri isn't identical to the one used in
// the OAuth dialog"); sending the exact captured value succeeds.
async function exchangeCodeForToken(code: string, redirectUri: string): Promise<string> {
  const { appId, appSecret, apiVersion } = getMetaCredentials();
  const url = new URL(graphUrl(apiVersion, "/oauth/access_token"));
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", code);
  url.searchParams.set("redirect_uri", redirectUri);

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

// Deliberately does NOT trust a client-supplied WABA id (the plan's "input
// only {code}" requirement) — even though Meta's Embedded Signup popup
// event also carries the WABA id client-side, this asks Meta's own API,
// using the just-exchanged token, which WABA that token actually grants
// access to. debug_token's granular_scopes is Meta's documented mechanism
// for a Tech Provider to discover this server-side.
//
// NOTE: this is the one part of this file that could not be exercised
// against a real Meta app in this environment (no live credentials here) —
// the endpoint and response shape below match Meta's current documented
// Embedded Signup flow, but should be confirmed against a real exchange
// during Stage 2B's own live verification before this is relied on for a
// real customer's WABA.
async function resolveWabaId(accessToken: string): Promise<string> {
  const { appId, appSecret, apiVersion } = getMetaCredentials();
  const url = new URL(graphUrl(apiVersion, "/debug_token"));
  url.searchParams.set("input_token", accessToken);
  url.searchParams.set("access_token", `${appId}|${appSecret}`);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Meta debug_token check failed (${response.status}): ${await describeMetaError(response)}`);
  }
  const json = (await response.json()) as {
    data?: { granular_scopes?: { scope: string; target_ids?: string[] }[] };
  };
  const wabaScope = json.data?.granular_scopes?.find(
    (s) => s.scope === "whatsapp_business_management" || s.scope === "whatsapp_business_messaging",
  );
  const wabaId = wabaScope?.target_ids?.[0];
  if (!wabaId) {
    throw new Error("Could not determine which WhatsApp Business Account this signup granted access to.");
  }
  return wabaId;
}

async function resolvePhoneNumber(
  wabaId: string,
  accessToken: string,
): Promise<{ phoneNumberId: string; displayPhoneNumber: string }> {
  const { apiVersion } = getMetaCredentials();
  const url = new URL(graphUrl(apiVersion, `/${wabaId}/phone_numbers`));
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(
      `Could not list phone numbers for this WhatsApp Business Account (${response.status}): ${await describeMetaError(response)}`,
    );
  }
  const json = (await response.json()) as {
    data?: { id: string; display_phone_number: string }[];
  };
  const first = json.data?.[0];
  if (!first) {
    throw new Error("No phone number found on this WhatsApp Business Account.");
  }
  return { phoneNumberId: first.id, displayPhoneNumber: first.display_phone_number };
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

export const completeMetaWhatsAppSignup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { code: string; redirectUri: string }) => input)
  .handler(async ({ context, data }): Promise<MetaSignupResult> => {
    const code = data.code?.trim();
    const redirectUri = data.redirectUri?.trim();
    if (!code) {
      return { status: "error", message: "Missing signup code." };
    }
    if (!redirectUri) {
      return { status: "error", message: "Missing redirect information from the sign-in popup. Please try again." };
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

    // TEMPORARY diagnostic instrumentation for live Embedded Signup
    // debugging — stage tracking + verbose [Meta WhatsApp] log lines, and
    // (below) returning the detailed error to the client instead of a
    // generic message. Revert once the redirect_uri/FedCM investigation is
    // resolved: a real customer should never see raw Meta error text.
    console.log(`[Meta WhatsApp] START tenant=${tenantId}`);
    let stage = "exchangeCodeForToken";
    let accessToken: string;
    let wabaId: string;
    let phoneNumberId: string;
    let displayPhoneNumber: string;
    try {
      accessToken = await exchangeCodeForToken(code, redirectUri);
      console.log(`[Meta WhatsApp] ${stage} ✓`);

      stage = "resolveWabaId";
      wabaId = await resolveWabaId(accessToken);
      console.log(`[Meta WhatsApp] ${stage} ✓ waba_id=${wabaId}`);

      stage = "resolvePhoneNumber";
      ({ phoneNumberId, displayPhoneNumber } = await resolvePhoneNumber(wabaId, accessToken));
      console.log(`[Meta WhatsApp] ${stage} ✓ phone_number_id=${phoneNumberId}`);
    } catch (err) {
      // Nothing written yet, nothing called on Meta's subscription state —
      // genuinely no partial state at this point, local or external.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[Meta WhatsApp] ${stage} FAILED for tenant ${tenantId}: ${detail}`);
      // TEMPORARY: surfacing the real stage + Meta error detail to the
      // client for live debugging. No token/code/secret is ever in this
      // string — describeMetaError only ever extracts message/type/code/
      // error_subcode/fbtrace_id. Revert to a generic message afterward.
      return { status: "error", message: `[${stage}] ${detail}` };
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
      // TEMPORARY: see note above.
      return { status: "error", message: `[subscribeAppToWaba] ${reason}` };
    }
    console.log(`[Meta WhatsApp] subscribeAppToWaba ✓`);

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
