import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { createCheckoutSession } from "@/lib/stripe-server";
import { INVOICES } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/settings/billing")({
  component: BillingSettings,
});

const PLANS = [
  { id: "solo" as const, label: "Solo", price: "$8/mo" },
  { id: "crew" as const, label: "Crew", price: "$19/mo" },
];

function BillingSettings() {
  const [checkingOut, setCheckingOut] = useState<"solo" | "crew" | null>(null);

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
              <Button
                key={plan.id}
                variant="outline"
                onClick={() => void startCheckout(plan.id)}
                disabled={checkingOut !== null}
              >
                {checkingOut === plan.id ? "Redirecting…" : `Switch to ${plan.label} — ${plan.price}`}
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
          <Button
            size="sm"
            variant="outline"
            onClick={() => toast.info("Payment method update isn't wired up yet.")}
          >
            Update
          </Button>
        }
      >
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
              <div className="flex items-center gap-3">
                <span className="num text-sm text-foreground">{inv.amount}</span>
                <button
                  className="text-xs font-semibold text-primary hover:underline"
                  onClick={() => toast.info("PDF export isn't wired up yet.")}
                >
                  Download
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
