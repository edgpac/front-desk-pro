import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { INVOICES } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/settings/billing")({
  component: BillingSettings,
});

function BillingSettings() {
  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader eyebrow="Settings" title="Billing" />

      <Panel title="Current plan">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-lg font-semibold text-foreground">Crew — $79/mo</p>
            <p className="text-sm text-muted-foreground">Trial ends in 9 days. Cancel anytime.</p>
          </div>
          <Button variant="outline" onClick={() => toast.info("Plan comparison isn't wired up yet.")}>
            Change plan
          </Button>
        </div>
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
