import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { ArrowLeft } from "lucide-react";

import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import heroMockup from "@/assets/aircraft-detailing-mockup.png";

export const Route = createFileRoute("/forgot-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Reset your password — Job It Ready" },
      { name: "description", content: "Request a password reset link for your Job It Ready account." },
    ],
  }),
  component: ForgotPassword,
});

function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  // Once true, always shows the generic confirmation — never reverts to the
  // form on a second submit, so there's no behavioral tell either way.
  const [submitted, setSubmitted] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Deliberately no error branch that varies by whether the email
      // exists — Supabase's own resetPasswordForEmail already returns
      // success regardless of account existence, so a thrown error here is
      // a genuine infra issue (bad config, rate limit), never an
      // enumeration signal. Still shown as a toast, not a different final
      // state, so a user hitting a real problem gets useful feedback.
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setSubmitted(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1fr]">
      <div className="flex flex-col justify-center px-5 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to log in
          </Link>
          <div className="mt-6">
            <Link to="/">
              <Wordmark />
            </Link>
          </div>

          {submitted ? (
            <>
              <h1 className="mt-10 text-3xl">Check your email.</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                If an account exists for <span className="font-medium text-foreground">{email}</span>, a
                password reset link is on its way. It may take a few minutes to arrive.
              </p>
            </>
          ) : (
            <>
              <h1 className="mt-10 text-3xl">Forgot your password?</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Enter your email and we'll send you a link to reset it.
              </p>

              <form className="mt-8 space-y-4" onSubmit={submit}>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    className="mt-1.5"
                    placeholder="ray@delgadoplumbing.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" size="lg" className="w-full" disabled={busy}>
                  {busy ? "Sending…" : "Send reset link"}
                </Button>
              </form>
            </>
          )}

          <p className="mt-6 text-sm text-muted-foreground">
            Remembered it?{" "}
            <Link to="/login" className="font-semibold text-primary underline-offset-4 hover:underline">
              Log in
            </Link>
          </p>
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
