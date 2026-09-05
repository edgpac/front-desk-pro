import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";

// Server-side gate for server functions: verifies the Supabase bearer token and
// exposes a per-user Supabase client (RLS-scoped) + userId to the handler.
export const requireSupabaseAuth = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const SUPABASE_URL = process.env["SUPABASE_URL"];
    const SUPABASE_PUBLISHABLE_KEY = process.env["SUPABASE_PUBLISHABLE_KEY"];
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY in the server environment.");
    }

    const request = getRequest();
    const authHeader = request?.headers?.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new Error("Unauthorized: sign in to continue.");
    }
    const token = authHeader.replace("Bearer ", "");
    if (!token) throw new Error("Unauthorized: no token provided.");

    const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await supabase.auth.getClaims(token);
    if (error || !data?.claims?.sub) {
      throw new Error("Unauthorized: invalid session.");
    }

    return next({ context: { supabase, userId: data.claims.sub as string } });
  },
);
