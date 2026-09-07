import { createFileRoute } from "@tanstack/react-router";
import { exchangeCodeForToken } from "@/lib/meta-whatsapp-server";

// TEMPORARY DIAGNOSTIC ROUTE — supports public/meta-test.html only.
//
// Purpose: let the isolated, plain-HTML test page ask "does Meta's
// /oauth/access_token exchange accept a code obtained from a given
// Facebook Login for Business configuration?" without needing a
// Supabase session (the real completeMetaWhatsAppSignup is auth-gated
// and writes to the database; a static test page can do neither).
//
// This calls the exact same, unmodified exchangeCodeForToken() the real
// flow uses — no duplicated logic, no behavior difference. It never
// returns the access token itself, never touches whatsapp_connections,
// never resolves a tenant, and never logs the code. Delete this file
// (and the `export` on exchangeCodeForToken) once the A/B configuration
// test is complete.
export const Route = createFileRoute("/api/meta-test-exchange")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        let code: unknown;
        try {
          const body = (await request.json()) as { code?: unknown };
          code = body.code;
        } catch {
          return Response.json({ status: "error", message: "Invalid JSON body." }, { status: 400 });
        }
        if (typeof code !== "string" || !code.trim()) {
          return Response.json({ status: "error", message: "Missing code." }, { status: 400 });
        }
        try {
          await exchangeCodeForToken(code.trim());
          return Response.json({ status: "success" });
        } catch (err) {
          return Response.json({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
  },
});
