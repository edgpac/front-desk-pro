import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";

import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import panelPhoto from "@/assets/electrician-panel.jpg";

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "Start your free trial — FrontDesk" },
      {
        name: "description",
        content:
          "Set up FrontDesk in about 10 minutes: your business details, your price sheet, your logo. 14 days free, no card up front.",
      },
      { property: "og:title", content: "Start your FrontDesk free trial" },
      { property: "og:description", content: "14 days free, no card up front, about 10 minutes to set up." },
    ],
  }),
  component: Signup,
});

function Signup() {
  const navigate = useNavigate();

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_0.85fr]">
      <div className="flex flex-col justify-center px-5 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-md">
          <Link to="/">
            <Wordmark />
          </Link>
          <h1 className="mt-10 text-3xl">Start your 14 days.</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            No card up front. You'll be quoting off your own price sheet before the end of the day.
          </p>

          <form
            className="mt-8 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              navigate({ to: "/onboarding/business-info" });
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="name">Your name</Label>
                <Input id="name" className="mt-1.5" placeholder="Ray Delgado" required />
              </div>
              <div>
                <Label htmlFor="phone">Mobile</Label>
                <Input id="phone" className="mt-1.5" placeholder="(512) 555-0110" required />
              </div>
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" className="mt-1.5" placeholder="ray@delgadoplumbing.com" required />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" className="mt-1.5" placeholder="At least 8 characters" required />
            </div>
            <Button type="submit" size="lg" className="w-full">
              Create account
            </Button>
          </form>

          <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
            {["14 days free", "Cancel from the billing page", "Your pricing stays yours"].map((p) => (
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
          src={panelPhoto}
          alt="Electrician's hands working inside a breaker panel"
          loading="lazy"
          width={1200}
          height={1500}
          className="h-full w-full object-cover"
        />
      </div>
    </div>
  );
}
