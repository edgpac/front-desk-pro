import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { StatusPill } from "@/components/app/StatusPill";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/use-auth";
import { listMyLeads, exportMyLeadsCsv, deleteLead, deleteLeads } from "@/lib/leads-server";
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

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

  async function handleDelete(id: string, customerName: string) {
    if (!window.confirm(`Delete the lead from "${customerName}"? This can't be undone.`)) return;
    if (!user) {
      setAllLeads((l) => l.filter((lead) => lead.id !== id));
      return;
    }
    const previous = allLeads;
    setAllLeads((l) => l.filter((lead) => lead.id !== id));
    setSelected((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    try {
      await deleteLead({ data: id });
    } catch (err) {
      setAllLeads(previous);
      toast.error(err instanceof Error ? err.message : "Could not delete lead.");
    }
  }

  function toggleSelected(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelected((s) => {
      const allVisibleSelected = leads.length > 0 && leads.every((l) => s.has(l.id));
      if (allVisibleSelected) {
        const next = new Set(s);
        for (const l of leads) next.delete(l.id);
        return next;
      }
      const next = new Set(s);
      for (const l of leads) next.add(l.id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} lead${ids.length === 1 ? "" : "s"}? This can't be undone.`)) return;
    if (!user) {
      setAllLeads((l) => l.filter((lead) => !selected.has(lead.id)));
      setSelected(new Set());
      return;
    }
    const previous = allLeads;
    setBulkDeleting(true);
    setAllLeads((l) => l.filter((lead) => !selected.has(lead.id)));
    setSelected(new Set());
    try {
      await deleteLeads({ data: ids });
    } catch (err) {
      setAllLeads(previous);
      toast.error(err instanceof Error ? err.message : "Could not delete the selected leads.");
    } finally {
      setBulkDeleting(false);
    }
  }

  const leads = useMemo(() => {
    return allLeads.filter((l) => filter === "all" || l.status === filter).filter((l) =>
      search.trim()
        ? `${l.customer} ${l.problem}`.toLowerCase().includes(search.trim().toLowerCase())
        : true,
    );
  }, [allLeads, filter, search]);

  const allVisibleSelected = leads.length > 0 && leads.every((l) => selected.has(l.id));

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
        <div className="flex flex-wrap items-center gap-2">
          {selected.size > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleBulkDelete()}
              disabled={bulkDeleting}
              className="text-destructive hover:text-destructive"
            >
              {bulkDeleting ? "Deleting…" : `Delete ${selected.size} selected`}
            </Button>
          )}
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or problem…"
            className="max-w-xs"
            aria-label="Search leads"
          />
        </div>
      </div>

      <Panel>
        {leads.length > 0 && (
          <div className="-mx-4 -mt-4 mb-2 flex items-center gap-3 border-b border-border px-4 py-2">
            <Checkbox
              checked={allVisibleSelected}
              onCheckedChange={() => toggleSelectAllVisible()}
              aria-label="Select all visible leads"
            />
            <span className="text-xs text-muted-foreground">
              {selected.size > 0 ? `${selected.size} selected` : "Select all"}
            </span>
          </div>
        )}
        <ul className="-m-4 mt-0 divide-y divide-border">
          {leads.map((lead) => (
            <li key={lead.id} className="flex items-center hover:bg-muted/40">
              <div className="pl-4">
                <Checkbox
                  checked={selected.has(lead.id)}
                  onCheckedChange={() => toggleSelected(lead.id)}
                  aria-label={`Select lead from ${lead.customer}`}
                />
              </div>
              <Link
                to="/dashboard/leads/$id"
                params={{ id: lead.id }}
                className="grid flex-1 grid-cols-[auto_1fr_auto_auto_auto] items-center gap-4 px-4 py-3 text-left"
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
                    if (!pricing.priced) return pricing.label;
                    // P2 mixed-pricing: real total, plus a visible marker
                    // that it isn't the whole request — the StatusPill
                    // below already shows "NEEDS REVIEW" for this lead
                    // (status: 'flagged' regardless of which flag_type),
                    // this just distinguishes the total from a plain
                    // fully-priced lead's.
                    return pricing.hasDeferredPortion ? `${money(pricing.amount)} + pending` : money(pricing.amount);
                  })()}
                </span>
                <StatusPill status={lead.status} />
              </Link>
              <button
                onClick={() => void handleDelete(lead.id, lead.customer)}
                aria-label={`Delete lead from ${lead.customer}`}
                className="shrink-0 px-3 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </button>
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
