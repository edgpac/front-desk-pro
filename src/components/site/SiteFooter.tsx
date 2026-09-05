import { Link } from "@tanstack/react-router";

import { Wordmark } from "@/components/brand/Wordmark";

export function SiteFooter() {
  return (
    <footer className="border-t border-border-strong bg-ink text-ink-foreground">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Wordmark tone="light" />
          <p className="mt-3 max-w-xs text-sm text-ink-muted">
            The front desk for trades that don't have one. Photo in, priced estimate out, job on the
            calendar.
          </p>
        </div>
        <div>
          <p className="label-caps text-primary">Product</p>
          <ul className="mt-3 space-y-2 text-sm text-ink-muted">
            <li>
              <Link to="/demo" className="hover:text-ink-foreground">
                Live demo
              </Link>
            </li>
            <li>
              <Link to="/pricing" className="hover:text-ink-foreground">
                Pricing
              </Link>
            </li>
            <li>
              <Link to="/pricing" className="hover:text-ink-foreground">
                Get started
              </Link>
            </li>
          </ul>
        </div>
        <div>
          <p className="label-caps text-primary">Account</p>
          <ul className="mt-3 space-y-2 text-sm text-ink-muted">
            <li>
              <Link to="/login" className="hover:text-ink-foreground">
                Log in
              </Link>
            </li>
            <li>
              <Link to="/dashboard" className="hover:text-ink-foreground">
                Dashboard
              </Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-5 py-5 text-xs text-ink-muted">
          <p>© 2026 FrontDesk Tools. Built for people who work with their hands.</p>
          <p>Austin, Texas</p>
        </div>
      </div>
    </footer>
  );
}
