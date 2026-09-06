import { createClient } from "@supabase/supabase-js";

// Job It Ready's own Supabase project — separate from any other product's.
// Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env and in Vercel.
function makeClient() {
  const url = import.meta.env["VITE_SUPABASE_URL"] as string | undefined;
  const key = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] as string | undefined;
  if (!url || !key) {
    throw new Error(
      "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Set them in your environment.",
    );
  }
  return createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: typeof window !== "undefined" ? window.localStorage : undefined,
    },
  });
}

let _client: ReturnType<typeof makeClient> | undefined;

// Lazy proxy: the client is only created on first use, so public pages that
// never touch auth won't crash if the env vars aren't present yet.
export const supabase = new Proxy({} as ReturnType<typeof makeClient>, {
  get(_target, prop, receiver) {
    if (!_client) _client = makeClient();
    return Reflect.get(_client, prop, receiver);
  },
});
