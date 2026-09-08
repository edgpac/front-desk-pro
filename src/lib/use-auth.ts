import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { isOwnerEmail } from "@/lib/owner-gate";

// Shared auth state for Job It Ready. Returns the current user (or null) and a
// loading flag while the initial session check is in flight.
//
// A non-owner session is never surfaced as logged in, from here — not just
// at the login/signup submit handlers. Those handlers give an immediate
// "coming soon" message on the happy path, but Supabase syncs sessions
// across tabs/storage, so a non-owner session could otherwise still reach
// this hook (and every real, requireSupabaseAuth-gated call a consumer
// makes off the back of `user`) via a different tab or a failed signOut()
// at the call site. Checking here closes that regardless of how the
// session arrived.
export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    function applySession(sessionUser: User | null) {
      if (sessionUser && !isOwnerEmail(sessionUser.email)) {
        void supabase.auth.signOut();
        setUser(null);
        return;
      }
      setUser(sessionUser);
    }

    // supabase.auth throws synchronously (not a rejected promise) if the
    // client isn't configured — a plain .catch() after .getSession() can't
    // catch that, since the throw happens before the chain even attaches.
    try {
      supabase.auth
        .getSession()
        .then(({ data }) => {
          if (active) {
            applySession(data.session?.user ?? null);
            setLoading(false);
          }
        })
        .catch(() => {
          if (active) setLoading(false);
        });

      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
        applySession(session?.user ?? null);
      });
      unsubscribe = () => sub.subscription.unsubscribe();
    } catch {
      // Not configured yet — treat as logged out rather than crashing.
      setLoading(false);
    }

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  return { user, loading };
}
