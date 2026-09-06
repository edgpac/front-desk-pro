import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/use-auth";
import { createCheckoutSession, createBillingPortalSession, getMyBillingInfo, type BillingInfo } from "@/lib/stripe-server";
import { INVOICES } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/settings/billing")({
  component: BillingSettings,
});

const PLANS = [
  { id: "solo" as const, label: "Solo", price: "$8/mo" },
  { id: "crew" as const, label: "Crew", price: "$19/mo" },
];

const PLAN_DISPLAY: Record<"solo" | "crew", string> = {
  solo: "Solo — $8/mo",
  crew: "Crew — $19/mo",
};

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function BillingSettings() {
  const { user, loading: authLoading } = useAuth();
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState<"solo" | "crew" | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    let active = true;
    getMyBillingInfo()
      .then((info) => {
        if (active) setBilling(info);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load billing info.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  async function startCheckout(plan: "solo" | "crew") {
    setCheckingOut(plan);
    try {
      const { url } = await createCheckoutSession({ data: { plan } });
      window.location.href = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start checkout.");
      setCheckingOut(null);
    }
  }

  async function openPortal() {
    setOpeningPortal(true);
    try {
      const { url } = await createBillingPortalSession();
      window.location.href = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open the billing portal.");
    } finally {
      setOpeningPortal(false);
    }
  }

  // Sample/logged-out preview — unchanged from before.
  if (!user) {
    return (
      <div className="space-y-6 p-6 lg:p-10">
        <PageHeader eyebrow="Settings" title="Billing" />

        <Panel title="Current plan">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-lg font-semibold text-foreground">Crew — $19/mo</p>
              <p className="text-sm text-muted-foreground">Cancel anytime.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {PLANS.map((plan) => (
                <Button key={plan.id} variant="outline" disabled>
                  Switch to {plan.label} — {plan.price}
                </Button>
              ))}
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Sign up to manage a real subscription.</p>
        </Panel>

        <Panel title="Payment method">
          <p className="text-sm text-muted-foreground">Visa ending in 4242</p>
        </Panel>

        <Panel title="Invoice history">
          <ul className="-m-4 divide-y divide-border">
            {INVOICES.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{inv.id}</p>
                  <p className="text-xs text-muted-foreground">
                    {inv.date} · {inv.plan}
                  </p>
                </div>
                <span className="num text-sm text-foreground">{inv.amount}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6 p-6 lg:p-10">
        <PageHeader eyebrow="Settings" title="Loading…" />
      </div>
    );
  }

  const hasPlan = Boolean(billing?.plan);

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader eyebrow="Settings" title="Billing" />

      <Panel title="Current plan">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-lg font-semibold text-foreground">
              {billing?.plan ? PLAN_DISPLAY[billing.plan] : "No active plan"}
            </p>
            <p className="text-sm text-muted-foreground">
              {hasPlan ? `Status: ${billing?.subscriptionStatus ?? "unknown"}` : "Pick a plan to start quoting real jobs."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {PLANS.filter((plan) => plan.id !== billing?.plan).map((plan) => (
              <Button
                key={plan.id}
                variant="outline"
                onClick={() => void startCheckout(plan.id)}
                disabled={checkingOut !== null}
              >
                {checkingOut === plan.id
                  ? "Redirecting…"
                  : hasPlan
                    ? `Switch to ${plan.label} — ${plan.price}`
                    : `Start ${plan.label} — ${plan.price}`}
              </Button>
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Checkout uses the email on your FrontDesk account — no need to type it again.
        </p>
      </Panel>

      <Panel
        title="Payment method"
        aside={
          <Button size="sm" variant="outline" onClick={() => void openPortal()} disabled={openingPortal || !hasPlan}>
            {openingPortal ? "Opening…" : "Manage in Stripe"}
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">
          {billing?.paymentMethod
            ? `${capitalize(billing.paymentMethod.brand)} ending in ${billing.paymentMethod.last4}`
            : "No card on file yet."}
        </p>
      </Panel>

      <Panel title="Invoice history">
        {billing && billing.invoices.length > 0 ? (
          <ul className="-m-4 divide-y divide-border">
            {billing.invoices.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{inv.id}</p>
                  <p className="text-xs text-muted-foreground">
                    {inv.date} · {inv.plan}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="num text-sm text-foreground">{inv.amount}</span>
                  {inv.hostedUrl ? (
                    <a
                      href={inv.hostedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-semibold text-primary hover:underline"
                    >
                      View
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-sm text-muted-foreground">No invoices yet.</p>
        )}
      </Panel>
    </div>
  );
}
