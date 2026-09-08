import { createFileRoute } from "@tanstack/react-router";
import { getMetaCredentials, graphUrl, describeMetaError } from "@/lib/meta-whatsapp-server";

// TEMPORARY DIAGNOSTIC ROUTE — supports public/meta-test.html only.
//
// This is what discovered that Meta's /oauth/access_token exchange
// requires the exact redirect_uri the SDK's popup used to open (now
// required in production's exchangeCodeForToken() — see
// meta-whatsapp-server.ts). This route keeps its own copy of the exchange
// request so it can still test the "no redirect_uri" and "wrong
// redirect_uri" cases that production's function no longer allows —
// never returns the access token itself, never touches
// whatsapp_connections, never resolves a tenant, never logs the code.
// Delete this file (and the three `export`s it depends on in
// meta-whatsapp-server.ts) now that the fix is confirmed and shipped.
async function testExchangeCodeForToken(code: string, redirectUri: string): Promise<void> {
  const { appId, appSecret, apiVersion } = getMetaCredentials();
  const url = new URL(graphUrl(apiVersion, "/oauth/access_token"));
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("code", code);
  if (redirectUri) {
    url.searchParams.set("redirect_uri", redirectUri);
  }

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
          await testExchangeCodeForToken(trimmedCode, trimmedRedirectUri);
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
