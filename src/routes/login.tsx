import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import vanPhoto from "@/assets/work-van.jpg";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Log in — FrontDesk" },
      { name: "description", content: "Log in to your FrontDesk lead inbox, price sheet and proposals." },
      { property: "og:title", content: "Log in to FrontDesk" },
      { property: "og:description", content: "Your lead inbox, price sheet and proposals." },
    ],
  }),
  component: Login,
});

function Login() {
  const navigate = useNavigate();

  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1fr]">
      <div className="flex flex-col justify-center px-5 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Link to="/">
            <Wordmark />
          </Link>
          <h1 className="mt-10 text-3xl">Welcome back.</h1>
          <p className="mt-2 text-sm text-muted-foreground">Pick up where the last job left off.</p>

          <form
            className="mt-8 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              navigate({ to: "/dashboard" });
            }}
          >
            <div>
              <Label htmlFor="email">Email or phone</Label>
              <Input id="email" className="mt-1.5" placeholder="ray@delgadoplumbing.com" required />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" className="mt-1.5" placeholder="••••••••" required />
            </div>
            <Button type="submit" size="lg" className="w-full">
              Log in
            </Button>
          </form>

          <p className="mt-6 text-sm text-muted-foreground">
            No account yet?{" "}
            <Link to="/signup" className="font-semibold text-primary underline-offset-4 hover:underline">
              Start a free trial
            </Link>
          </p>
        </div>
      </div>
      <div className="hidden bg-ink lg:block">
        <img
          src={vanPhoto}
          alt="Work van parked in a driveway at the end of a shift"
          loading="lazy"
          width={1400}
          height={900}
          className="h-full w-full object-cover"
        />
      </div>
    </div>
  );
}
