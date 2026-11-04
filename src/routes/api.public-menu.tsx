import { createFileRoute } from "@tanstack/react-router";
import { getAdminClient } from "@/lib/public-lead-server";
import { performGetPublicServiceMenu } from "@/lib/service-menu-server";

// A plain JSON mirror of the existing /menu/:slug page's data, for a
// tenant's OWN marketing site to fetch and render with its own branding
// — caboshandyman.com/pricing is the first consumer. Entirely additive:
// /menu/:slug itself is completely untouched, and this calls the exact
// same read-only, tenant-scoped, subscription-gated
// performGetPublicServiceMenu that route already uses, so there is no
// new data-access logic to get wrong here, only transport.
//
// CORS is scoped to a fixed allowlist, never "*" — this is public data,
// but there is no reason to let an arbitrary third-party site fetch it
// from a browser when exactly one real consumer exists today.
const ALLOWED_ORIGINS = new Set(["https://www.caboshandyman.com", "https://caboshandyman.com"]);

function corsHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "Origin";
  }
  return headers;
}

export const Route = createFileRoute("/api/public-menu")({
  server: {
    handlers: {
      OPTIONS: async ({ request }: { request: Request }) => {
        const origin = request.headers.get("origin");
        return new Response(null, {
          status: 204,
          headers: {
            ...corsHeaders(origin),
            "access-control-allow-methods": "GET, OPTIONS",
          },
        });
      },
      GET: async ({ request }: { request: Request }) => {
        const origin = request.headers.get("origin");
        const slug = new URL(request.url).searchParams.get("slug");
        if (!slug) {
          return new Response(JSON.stringify({ error: "Missing slug parameter." }), {
            status: 400,
            headers: corsHeaders(origin),
          });
        }
        try {
          const menu = await performGetPublicServiceMenu(getAdminClient(), slug);
          return new Response(JSON.stringify(menu), {
            status: 200,
            headers: corsHeaders(origin),
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "This service menu is currently unavailable.";
          return new Response(JSON.stringify({ error: message }), {
            status: 404,
            headers: corsHeaders(origin),
          });
        }
      },
    },
  },
});
