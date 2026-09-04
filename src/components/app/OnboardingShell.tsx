import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Check } from "lucide-react";

import { Wordmark } from "@/components/brand/Wordmark";
import { cn } from "@/lib/utils";

const steps = [
  { to: "/onboarding/business-info", label: "Business" },
  { to: "/onboarding/price-sheet", label: "Prices" },
  { to: "/onboarding/branding", label: "Branding" },
  { to: "/onboarding/calendar", label: "Calendar" },
  { to: "/onboarding/done", label: "Done" },
] as const;

export function OnboardingShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const current = Math.max(
    0,
    steps.findIndex((s) => pathname.startsWith(s.to)),
  );

  return (
    <div className="min-h-screen bg-paper">
      <header className="border-b border-border-strong bg-background">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-5">
          <Link to="/">
            <Wordmark />
          </Link>
          <p className="text-xs text-muted-foreground">
            Step {current + 1} of {steps.length}
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-5 py-8">
        <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-strong pb-5">
          {steps.map((s, i) => {
            const done = i < current;
            const active = i === current;
            return (
              <li key={s.to} className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex items-center gap-2 font-display text-[11px] font-bold uppercase tracking-[0.12em]",
                    active ? "text-foreground" : done ? "text-success" : "text-muted-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-5 w-5 items-center justify-center rounded-sm border text-[10px]",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : done
                          ? "border-success bg-success text-success-foreground"
                          : "border-border-strong text-muted-foreground",
                    )}
                  >
                    {done ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  {s.label}
                </span>
                {i < steps.length - 1 && <span className="hidden h-px w-6 bg-border-strong sm:block" />}
              </li>
            );
          })}
        </ol>

        <div className="py-8">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
