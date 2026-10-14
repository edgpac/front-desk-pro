import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import heroMockup from "@/assets/aircraft-detailing-mockup.png";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Set a new password — Job It Ready" }],
  }),
  component: ResetPassword,
});

type SessionState = "checking" | "ready" | "invalid" | "done";

function ResetPassword() {
  const navigate = useNavigate();
  const [sessionState, setSessionState] = useState<SessionState>("checking");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;

    // getSession() awaits the client's own URL-hash-parsing step internally
    // (same guarantee use-auth.ts already relies on) — so this reliably
    // picks up a recovery session established from the link's URL fragment
    // even though that parsing happens before this effect runs, rather than
    // racing it. onAuthStateChange below is a live supplement for the event
    // firing after this initial check, not the primary detection path.
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active && data.session) setSessionState("ready");
        else if (active) setSessionState("invalid");
      })
      .catch(() => {
        if (active) setSessionState("invalid");
      });

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" && active) setSessionState("ready");
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Password updated.");
      setSessionState("done");
      navigate({ to: "/dashboard" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update your password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1fr]">
      <div className="flex flex-col justify-center px-5 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Link to="/">
            <Wordmark />
          </Link>

          {sessionState === "checking" && (
            <p className="mt-10 text-sm text-muted-foreground">Checking your reset link…</p>
          )}

          {sessionState === "invalid" && (
            <>
              <h1 className="mt-10 text-3xl">This link isn't valid.</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                It may have expired or already been used. Reset links are only good for a limited time and
                for a single use.
              </p>
              <Link to="/forgot-password">
                <Button size="lg" className="mt-6 w-full">
                  Request a new link
                </Button>
              </Link>
            </>
          )}

          {(sessionState === "ready" || sessionState === "done") && (
            <>
              <h1 className="mt-10 text-3xl">Set a new password.</h1>
              <p className="mt-2 text-sm text-muted-foreground">Choose a new password for your account.</p>

              <form className="mt-8 space-y-4" onSubmit={submit}>
                <div>
                  <Label htmlFor="password">New password</Label>
                  <PasswordInput
                    id="password"
                    className="mt-1.5"
                    placeholder="At least 8 characters"
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="confirmPassword">Confirm new password</Label>
                  <PasswordInput
                    id="confirmPassword"
                    className="mt-1.5"
                    placeholder="Re-enter your new password"
                    minLength={8}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" size="lg" className="w-full" disabled={busy || sessionState === "done"}>
                  {busy ? "Updating…" : "Update password"}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
      <div className="hidden bg-ink lg:block">
        <img
          src={heroMockup}
          alt="Job It Ready dashboard on a tablet, showing a priced estimate for an aircraft detailing job"
          loading="lazy"
          width={1178}
          height={1335}
          className="h-full w-full object-cover"
        />
      </div>
    </div>
  );
}
