import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getAdminClient } from "@/lib/public-lead-server";

// Meta WhatsApp Cloud API — Stage 2B: Embedded Signup + OAuth/token
// exchange only. No webhook, no inbound/outbound messaging, no templates —
// those are later sub-stages. Mirrors twilio-server.ts's shape (a small
// getCredentials()-style helper plus the actual calls), but nothing here
// is imported by whatsapp-conversation-server.ts or api.whatsapp.webhook.tsx
// — the two channels stay fully independent.

function getMetaCredentials() {
  const appId = process.env["VITE_META_APP_ID"];
  const appSecret = process.env["META_APP_SECRET"];
  const apiVersion = process.env["META_API_VERSION"] || "v26.0";
  if (!appId || !appSecret) {
    throw new Error("Missing VITE_META_APP_ID or META_APP_SECRET on the server.");
  }
  return { appId, appSecret, apiVersion };
}

function graphUrl(apiVersion: string, path: string) {
  return `https://graph.facebook.com/${apiVersion}${path}`;
}

// Must exactly match both the Meta app's registered Valid OAuth Redirect
// URIs entry and the redirect_uri sent by FB.login() in
// ConnectWhatsAppMeta.tsx (same literal, independently defined in each
// file — the value is fixed and non-secret, so there's no need to widen
// completeMetaWhatsAppSignup's input beyond {code} to pass it through).
const META_REDIRECT_URI = "https://front-desk-pro-ten.vercel.app/dashboard/settings/business";

type MetaSignupSuccess = { status: "connected"; displayPhoneNumber: string };
type MetaSignupError = { status: "error"; message: string };
export type MetaSignupResult = MetaSignupSuccess | MetaSignupError;

async function exchangeCodeForToken(code: string): Promise<string> {
  const { appId, appSecret, apiVersion } = getMetaCredentials();
  const url = new URL(graphUrl(apiVersion, "/oauth/access_token"));
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", code);
  url.searchParams.set("redirect_uri", META_REDIRECT_URI);

  const response = await fetch(url.toString());
  if (!response.ok) {
    // Diagnostic only: surface Meta's safe, non-secret error fields (never
    // the raw body/URL — this endpoint is called with the app secret and
    // authorization code as query params, so the full request/response
    // must never be logged). Meta's error shape is
    // {error: {message, type, code, fbtrace_id}} — pull out exactly those
    // four fields and nothing else.
    let detail = `HTTP ${response.status}`;
    try {
      const errorJson = (await response.json()) as {
        error?: { message?: string; type?: string; code?: number; fbtrace_id?: string };
      };
      const e = errorJson.error;
      if (e) {
        detail = [
          e.message && `message="${e.message}"`,
          e.type && `type=${e.type}`,
          e.code !== undefined && `code=${e.code}`,
          e.fbtrace_id && `fbtrace_id=${e.fbtrace_id}`,
        ]
          .filter(Boolean)
          .join(", ") || detail;
      }
    } catch {
      // Body wasn't JSON (or had no error field) — fall back to just the
      // HTTP status, still no raw body logged.
    }
    throw new Error(`Meta token exchange failed (${response.status}): ${detail}`);
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
    throw new Error(`Meta debug_token check failed (${response.status}).`);
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
    throw new Error(`Could not list phone numbers for this WhatsApp Business Account (${response.status}).`);
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
    throw new Error(`Could not subscribe to this WhatsApp Business Account's webhooks (${response.status}).`);
  }
}

export const completeMetaWhatsAppSignup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { code: string }) => input)
  .handler(async ({ context, data }): Promise<MetaSignupResult> => {
    const code = data.code?.trim();
    if (!code) {
      return { status: "error", message: "Missing signup code." };
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

    let accessToken: string;
    let wabaId: string;
    let phoneNumberId: string;
    let displayPhoneNumber: string;
    try {
      accessToken = await exchangeCodeForToken(code);
      wabaId = await resolveWabaId(accessToken);
      ({ phoneNumberId, displayPhoneNumber } = await resolvePhoneNumber(wabaId, accessToken));
    } catch (err) {
      // Nothing written yet, nothing called on Meta's subscription state —
      // genuinely no partial state at this point, local or external.
      console.error(`Meta WhatsApp signup failed for tenant ${tenantId}:`, err instanceof Error ? err.message : err);
      return { status: "error", message: "Couldn't complete the WhatsApp connection. Please try again." };
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
      console.error(`Meta subscribed_apps failed for tenant ${tenantId}:`, reason);
      return { status: "error", message: "Connected to Meta, but couldn't finish setting up notifications. Please try again." };
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
      console.error(`Could not finalize WhatsApp connection status for tenant ${tenantId}:`, updateError.message);
      return { status: "error", message: "Connected, but finishing setup is taking longer than expected. Please refresh in a moment." };
    }

    return { status: "connected", displayPhoneNumber };
  });
