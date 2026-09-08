import { createFileRoute } from "@tanstack/react-router";
import {
  exchangeCodeForToken,
  getMetaCredentials,
  graphUrl,
  describeMetaError,
} from "@/lib/meta-whatsapp-server";

// TEMPORARY DIAGNOSTIC ROUTE — supports public/meta-test.html only.
//
// Purpose: let the isolated, plain-HTML test page ask "does Meta's
// /oauth/access_token exchange accept a code obtained from a given
// Facebook Login for Business configuration?" without needing a
// Supabase session (the real completeMetaWhatsAppSignup is auth-gated
// and writes to the database; a static test page can do neither).
//
// When `redirect_uri` is omitted, this calls the exact same, unmodified
// exchangeCodeForToken() the real flow uses — no duplicated logic, no
// behavior difference from production. When `redirect_uri` is provided,
// a separate, test-only function below builds the same exchange request
// with that value added, to determine whether Meta's exchange requires a
// specific redirect_uri to match the one used in the original OAuth
// dialog request — the production exchange function itself is never
// modified either way.
//
// This never returns the access token itself, never touches
// whatsapp_connections, never resolves a tenant, and never logs the code.
// Delete this file (and the three `export`s it depends on in
// meta-whatsapp-server.ts) once the redirect_uri experiment is complete.
async function exchangeCodeForTokenWithRedirect(code: string, redirectUri: string): Promise<void> {
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
}

export const Route = createFileRoute("/api/meta-test-exchange")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        let code: unknown;
        let redirectUri: unknown;
        try {
          const body = (await request.json()) as { code?: unknown; redirect_uri?: unknown };
          code = body.code;
          redirectUri = body.redirect_uri;
        } catch {
          return Response.json({ status: "error", message: "Invalid JSON body." }, { status: 400 });
        }
        if (typeof code !== "string" || !code.trim()) {
          return Response.json({ status: "error", message: "Missing code." }, { status: 400 });
        }
        const trimmedCode = code.trim();
        const trimmedRedirectUri = typeof redirectUri === "string" ? redirectUri.trim() : "";

        try {
          if (trimmedRedirectUri) {
            await exchangeCodeForTokenWithRedirect(trimmedCode, trimmedRedirectUri);
          } else {
            await exchangeCodeForToken(trimmedCode);
          }
          return Response.json({ status: "success", redirectUriUsed: trimmedRedirectUri || null });
        } catch (err) {
          return Response.json({
            status: "error",
            redirectUriUsed: trimmedRedirectUri || null,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
  },
});
