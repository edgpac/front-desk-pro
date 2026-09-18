import { createClient } from "@supabase/supabase-js";

// "Keep me signed in" (login.tsx/signup.tsx) — a plain, non-secret
// preference flag, read fresh on every storage call rather than fixed at
// client creation. That's what makes this compatible with the lazy
// singleton below: the login page can flip the flag via setRememberMe()
// right before signing in, and the very next read/write this client does
// (during that same sign-in call) already sees the new choice — no need to
// know the preference before the client exists.
const REMEMBER_KEY = "jir-remember-me";

function rememberMe(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(REMEMBER_KEY) !== "false";
}

export function setRememberMe(remember: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(REMEMBER_KEY, remember ? "true" : "false");
}

// Unchecked → sessionStorage, so the session disappears when the browser/tab
// closes. Checked (default, matches today's existing behavior) →
// localStorage, so it survives a restart.
const dynamicAuthStorage = {
  getItem: (key: string) => (rememberMe() ? window.localStorage : window.sessionStorage).getItem(key),
  setItem: (key: string, value: string) =>
    (rememberMe() ? window.localStorage : window.sessionStorage).setItem(key, value),
  removeItem: (key: string) => (rememberMe() ? window.localStorage : window.sessionStorage).removeItem(key),
};

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
      storage: typeof window !== "undefined" ? dynamicAuthStorage : undefined,
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
