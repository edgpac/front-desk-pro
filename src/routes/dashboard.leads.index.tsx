import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { StatusPill } from "@/components/app/StatusPill";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/use-auth";
import { listMyLeads } from "@/lib/leads-server";
import { LEADS, type Lead, type LeadStatus, STATUS_LABEL, lineItemsTotal, money } from "@/lib/mock-data";

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
    return () => {
      active = false;
    };
  }, [authLoading, user]);

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
                  {money(lineItemsTotal(lead.lineItems))}
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
