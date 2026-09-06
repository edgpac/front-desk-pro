import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

// Shared auth state for Job It Ready. Returns the current user (or null) and a
// loading flag while the initial session check is in flight.
export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    // supabase.auth throws synchronously (not a rejected promise) if the
    // client isn't configured — a plain .catch() after .getSession() can't
    // catch that, since the throw happens before the chain even attaches.
    try {
      supabase.auth
        .getSession()
        .then(({ data }) => {
          if (active) {
            setUser(data.session?.user ?? null);
            setLoading(false);
          }
        })
        .catch(() => {
          if (active) setLoading(false);
        });

      const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
        setUser(session?.user ?? null);
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
