import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Menu, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/brand/Wordmark";

const nav = [
  { to: "/", label: "Home" },
  { to: "/demo", label: "Live demo" },
  { to: "/pricing", label: "Pricing" },
] as const;

export function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-border-strong bg-background/95 backdrop-blur-[2px]">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
        <Link to="/" className="shrink-0">
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              activeProps={{ className: "text-foreground" }}
              activeOptions={{ exact: item.to === "/" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-2 md:flex">
          <Button asChild variant="ghost" size="sm">
            <Link to="/login">Log in</Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/signup">Start free trial</Link>
          </Button>
        </div>

        <button
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-sm border border-border-strong md:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-label="Menu"
        >
          {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-border bg-card px-5 py-4 md:hidden">
          <div className="flex flex-col gap-3">
            {nav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                onClick={() => setOpen(false)}
                className="text-sm font-medium text-foreground"
              >
                {item.label}
              </Link>
            ))}
            <div className="mt-2 flex gap-2">
              <Button asChild variant="outline" size="sm" className="flex-1">
                <Link to="/login">Log in</Link>
              </Button>
              <Button asChild size="sm" className="flex-1">
                <Link to="/signup">Start free trial</Link>
              </Button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
