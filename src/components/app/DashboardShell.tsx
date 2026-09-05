import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import {
  BarChart3,
  CreditCard,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Tags,
  Code2,
  X,
} from "lucide-react";

import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/use-auth";
import { TENANT } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

const links = [
  { to: "/dashboard", label: "Today", icon: LayoutDashboard, exact: true },
  { to: "/dashboard/leads", label: "Lead inbox", icon: Inbox, exact: false },
  { to: "/dashboard/price-sheet", label: "Price sheet", icon: Tags, exact: false },
  { to: "/dashboard/widget", label: "Widget & link", icon: Code2, exact: false },
  { to: "/dashboard/analytics", label: "Analytics", icon: BarChart3, exact: false },
  { to: "/dashboard/settings/business", label: "Settings", icon: Settings, exact: false },
  { to: "/dashboard/settings/billing", label: "Billing", icon: CreditCard, exact: true },
] as const;

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className="flex flex-col gap-[2px]">
      {links.map(({ to, label, icon: Icon, exact }) => {
        const active = exact ? pathname === to : pathname.startsWith(to);
        return (
          <Link
            key={label}
            to={to}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-sm px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-foreground"
                : "text-ink-muted hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
            )}
          >
            <Icon className={cn("h-4 w-4", active && "text-primary")} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function DashboardShell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { user } = useAuth();

  async function logOut() {
    await supabase.auth.signOut();
    navigate({ to: "/login" });
  }

  return (
    <div className="min-h-screen bg-paper">
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-white/10 bg-sidebar px-4 py-5 lg:flex">
        <Link to="/">
          <Wordmark tone="light" />
        </Link>
        <div className="mt-6 rounded-sm border border-white/10 bg-white/[0.04] px-3 py-2.5">
          <p className="label-caps text-primary">Business</p>
          <p className="mt-1 text-sm font-semibold text-ink-foreground">{TENANT.name}</p>
          <p className="text-xs text-ink-muted">{TENANT.area}</p>
        </div>
        <div className="mt-6">
          <NavList />
        </div>
        <div className="mt-auto space-y-3">
          <div className="rounded-sm border border-white/10 p-3">
            <p className="text-xs text-ink-muted">No trial — subscribe when you're ready</p>
            <Button asChild size="sm" className="mt-2 w-full">
              <Link to="/dashboard/settings/billing">Pick a plan</Link>
            </Button>
          </div>
          {user ? (
            <button
              onClick={() => void logOut()}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-sidebar-accent/60 hover:text-ink-foreground"
            >
              <LogOut className="h-4 w-4" /> Log out
            </button>
          ) : (
            <Link
              to="/login"
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-sidebar-accent/60 hover:text-ink-foreground"
            >
              <LogOut className="h-4 w-4" /> Log in
            </Link>
          )}
        </div>
      </aside>

      <div className="lg:pl-60">
        <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border-strong bg-background/95 px-4 backdrop-blur-[2px] lg:hidden">
          <button
            className="inline-flex h-9 w-9 items-center justify-center rounded-sm border border-border-strong"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>
          <Wordmark />
        </div>

        {open && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div className="absolute inset-0 bg-ink/60" onClick={() => setOpen(false)} />
            <div className="absolute inset-y-0 left-0 w-64 bg-sidebar px-4 py-5">
              <div className="flex items-center justify-between">
                <Wordmark tone="light" />
                <button onClick={() => setOpen(false)} aria-label="Close menu">
                  <X className="h-4 w-4 text-ink-muted" />
                </button>
              </div>
              <div className="mt-6">
                <NavList onNavigate={() => setOpen(false)} />
              </div>
            </div>
          </div>
        )}

        {!user && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2.5 text-sm">
            <span className="text-foreground">
              <strong className="font-semibold">You're looking at sample data</strong> — this isn't a real
              account.
            </span>
            <Link to="/signup" className="font-semibold text-primary hover:underline">
              Sign up to connect your own →
            </Link>
          </div>
        )}

        <Outlet />
      </div>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border-strong pb-5">
      <div>
        {eyebrow && <p className="label-caps text-primary">{eyebrow}</p>}
        <h1 className="mt-1.5 text-2xl text-foreground sm:text-3xl">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({
  title,
  aside,
  children,
  className,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border border-border-strong bg-card", className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 className="font-display text-sm font-bold uppercase tracking-[0.1em]">{title}</h2>
          {aside}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}
