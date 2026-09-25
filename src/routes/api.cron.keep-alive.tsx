import { createFileRoute } from "@tanstack/react-router";
import { getAdminClient } from "@/lib/public-lead-server";

// Supabase's free tier pauses a project after 7 days with zero API
// activity — this route exists purely to prevent that, triggered by
// Vercel Cron (see vercel.json) well inside that window. A trivial read
// is enough; nothing here needs to do real work.
//
// Vercel signs every cron-triggered request with
// `Authorization: Bearer ${CRON_SECRET}` when that env var is set —
// checked here the same way every other webhook in this codebase
// verifies its caller before doing anything, rather than leaving this
// open to being triggered by anyone who finds the URL.

export const Route = createFileRoute("/api/cron/keep-alive")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const expected = process.env["CRON_SECRET"];
        if (!expected) {
          console.error("CRON_SECRET is not set on the server.");
          return new Response("Forbidden", { status: 403 });
        }
        const auth = request.headers.get("authorization");
        if (auth !== `Bearer ${expected}`) {
          console.error("Rejected keep-alive cron call: invalid or missing Authorization header.");
          return new Response("Forbidden", { status: 403 });
        }

        try {
          const admin = getAdminClient();
          await admin.from("tenants").select("id").limit(1);
        } catch (err) {
          console.error("Keep-alive ping failed:", err);
          return new Response("Error", { status: 500 });
        }

        return new Response("OK", { status: 200 });
      },
    },
  },
});
