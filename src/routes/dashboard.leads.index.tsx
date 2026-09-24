import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { StatusPill } from "@/components/app/StatusPill";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/use-auth";
import { listMyLeads, exportMyLeadsCsv } from "@/lib/leads-server";
import { createLead } from "@/lib/public-lead-server";
import { getMyTenant } from "@/lib/tenant-server";
import { getMyBillingInfo } from "@/lib/stripe-server";
import { LEADS, type Lead, type LeadStatus, STATUS_LABEL, getLeadPricingStatus, money } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/leads/")({
  component: LeadInbox,
});

const FILTERS: Array<LeadStatus | "all"> = ["all", "new", "quoted", "booked", "won", "lost"];

function LeadInbox() {
  const { user, loading: authLoading } = useAuth();
  const [allLeads, setAllLeads] = useState<Lead[]>(LEADS);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<LeadStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [sendingTest, setSendingTest] = useState(false);
  const [plan, setPlan] = useState<"solo" | "crew" | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setAllLeads(LEADS);
      setLoading(false);
      return;
    }
    let active = true;
    listMyLeads()
      .then((leads) => {
        if (active) setAllLeads(leads);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load leads.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    // Only used to decide which control to render (real export vs. upgrade
    // prompt) — the actual protection is server-side in exportMyLeadsCsv,
    // this is just so Solo isn't shown a button that would fail on click.
    getMyBillingInfo()
      .then((info) => {
        if (active) setPlan(info.plan);
      })
      .catch(() => {
        // Non-fatal — leave plan null, which just shows the upgrade prompt.
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  async function exportCsv() {
    setExporting(true);
    try {
      const csv = await exportMyLeadsCsv();
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `job-it-ready-leads-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't export leads.");
    } finally {
      setExporting(false);
    }
  }

  async function sendTestLead() {
    setSendingTest(true);
    try {
      const tenant = await getMyTenant();
      await createLead({
        data: {
          tenantSlug: tenant.slug,
          customerName: "Test Customer",
          phone: "(555) 555-0100",
          address: "123 Test St",
          channel: "Widget",
          problem: "Testing the lead notification — kitchen faucet is dripping.",
          diagnosis: "Worn cartridge, straightforward swap. This is a test lead to confirm the notification email works.",
          confidence: "High",
          lineItems: [{ description: "Cartridge replacement", qty: 1, unit: "job", rate: 95 }],
        },
      });
      const fresh = await listMyLeads();
      setAllLeads(fresh);
      toast.success("Test lead created — check your email for the notification.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send a test lead.");
    } finally {
      setSendingTest(false);
    }
  }

  const leads = useMemo(() => {
    return allLeads.filter((l) => filter === "all" || l.status === filter).filter((l) =>
      search.trim()
        ? `${l.customer} ${l.problem}`.toLowerCase().includes(search.trim().toLowerCase())
        : true,
    );
  }, [allLeads, filter, search]);

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader
        eyebrow="Lead inbox"
        title="Every request, in one list"
        {...(!user
          ? { description: "You're viewing sample leads — real ones will show up here once you're live." }
          : {})}
        actions={
          user ? (
            <div className="flex flex-wrap items-center gap-2">
              {plan === "crew" ? (
                <Button variant="outline" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
                  {exporting ? "Exporting…" : "Export CSV"}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  CSV export is available on Crew.{" "}
                  <Link to="/pricing" className="font-semibold text-primary underline-offset-4 hover:underline">
                    Upgrade
                  </Link>
                </span>
              )}
              <Button variant="outline" size="sm" onClick={() => void sendTestLead()} disabled={sendingTest}>
                {sendingTest ? "Sending…" : "Send yourself a test lead"}
              </Button>
            </div>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "default" : "outline"}
              onClick={() => setFilter(f)}
              className="capitalize"
            >
              {f === "all" ? "All" : STATUS_LABEL[f]}
            </Button>
          ))}
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or problem…"
          className="max-w-xs"
          aria-label="Search leads"
        />
      </div>

      <Panel>
        <ul className="-m-4 divide-y divide-border">
          {leads.map((lead) => (
            <li key={lead.id}>
              <Link
                to="/dashboard/leads/$id"
                params={{ id: lead.id }}
                className="grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-4 px-4 py-3 text-left hover:bg-muted/40"
              >
                <img
                  src={lead.photo}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded-sm object-cover"
                  loading="lazy"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{lead.customer}</p>
                  <p className="truncate text-xs text-muted-foreground">{lead.problem}</p>
                </div>
                <span className="hidden text-xs text-muted-foreground sm:inline">{lead.requested}</span>
                <span className="num hidden text-sm font-medium text-foreground sm:inline">
                  {(() => {
                    const pricing = getLeadPricingStatus(lead);
                    return pricing.priced ? money(pricing.amount) : pricing.label;
                  })()}
                </span>
                <StatusPill status={lead.status} />
              </Link>
            </li>
          ))}
          {!loading && leads.length === 0 && (
            <li className={cn("px-4 py-10 text-center text-sm text-muted-foreground")}>
              {allLeads.length === 0 ? "No leads yet." : "No leads match that filter."}
            </li>
          )}
        </ul>
      </Panel>
    </div>
  );
}
