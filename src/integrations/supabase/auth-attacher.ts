import { createMiddleware } from "@tanstack/react-start";
import { supabase } from "./client";

// Registered as a global `functionMiddleware` in src/start.ts so the browser
// attaches the Supabase bearer token to every server-function call.
export const attachSupabaseAuth = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return next({
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
);
