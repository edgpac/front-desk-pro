import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check } from "lucide-react";
import { toast } from "sonner";

import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import heroMockup from "@/assets/aircraft-detailing-mockup.png";

export const Route = createFileRoute("/signup")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Create your account — Job It Ready" },
      {
        name: "description",
        content:
          "Set up Job It Ready in about 10 minutes: your business details, your price sheet, your logo. No trial — you'll pick a plan as you get set up.",
      },
      { property: "og:title", content: "Create your Job It Ready account" },
      { property: "og:description", content: "About 10 minutes to set up. No trial — you'll pick a plan as you get set up." },
    ],
  }),
  component: Signup,
});

function Signup() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name, phone } },
      });
      if (error) throw error;
      if (data.session) {
        // Email confirmation is off — the user is signed in immediately.
        toast.success("Account created.");
        navigate({ to: "/get-started" });
      } else {
        // Email confirmation is on — a confirmation email was sent.
        toast.success("Check your email to confirm, then log in.");
        navigate({ to: "/login" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create your account.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_0.85fr]">
      <div className="flex flex-col justify-center px-5 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-md">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to home
          </Link>
          <div className="mt-6">
            <Link to="/">
              <Wordmark />
            </Link>
          </div>
          <h1 className="mt-10 text-3xl">Create your account.</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            No card required to sign up — you'll pick a plan as you start setting things up, then
            you're quoting off your own price sheet the same day.
          </p>

          <form className="mt-8 space-y-4" onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="name">Your name</Label>
                <Input
                  id="name"
                  className="mt-1.5"
                  placeholder="Ray Delgado"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="phone">Mobile</Label>
                <Input
                  id="phone"
                  className="mt-1.5"
                  placeholder="(512) 555-0110"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                />
              </div>
            </div>
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
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                className="mt-1.5"
                placeholder="At least 8 characters"
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {busy ? "Creating account…" : "Create account"}
            </Button>
          </form>

          <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
            {[
              "No trial — you'll pick a plan as you get set up",
              "Cancel from the billing page",
              "Your pricing stays yours",
              "Starts empty — this is your real account, not the sample dashboard",
            ].map((p) => (
              <li key={p} className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 text-success" /> {p}
              </li>
            ))}
          </ul>

          <p className="mt-6 text-sm text-muted-foreground">
            Already set up?{" "}
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
