import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Code2, Inbox } from "lucide-react";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { StatusPill } from "@/components/app/StatusPill";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { useAuth } from "@/lib/use-auth";
import { getMyTenant } from "@/lib/tenant-server";
import { listMyLeads } from "@/lib/leads-server";
import { LEADS, TENANT, type Lead, type Tenant, embedSnippet, lineItemsTotal, money, quoteLink } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/")({
  component: DashboardHome,
});

function DashboardHome() {
  const { user, loading: authLoading } = useAuth();
  const [tenant, setTenant] = useState<Tenant>(TENANT);
  const [leads, setLeads] = useState<Lead[]>(LEADS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setTenant(TENANT);
      setLeads(LEADS);
      setLoading(false);
      return;
    }
    let active = true;
    Promise.all([getMyTenant(), listMyLeads()])
      .then(([realTenant, realLeads]) => {
        if (!active) return;
        setTenant(realTenant);
        setLeads(realLeads);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load your dashboard.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  const newCount = leads.filter((l) => l.status === "new").length;
  const quotedCount = leads.filter((l) => l.status === "quoted").length;
  const bookedCount = leads.filter((l) => l.status === "booked").length;
  const recent = leads.slice(0, 4);

  if (loading) {
    return (
      <div className="space-y-8 p-6 lg:p-10">
        <PageHeader eyebrow="Today" title="Loading…" description="" />
      </div>
    );
  }

  return (
    <div className="space-y-8 p-6 lg:p-10">
      <PageHeader
        eyebrow="Today"
        title={`Welcome back, ${tenant.name}`}
        description={
          user
            ? `${leads.length} lead${leads.length === 1 ? "" : "s"} total, ${newCount} still new.`
            : `${LEADS.filter((l) => l.requested.startsWith("Today")).length} requests came in today across your widget and shared link.`
        }
        actions={
          <Button asChild>
            <Link to="/dashboard/leads">
              <Inbox className="mr-2 h-4 w-4" /> Open lead inbox
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Panel title="New">
          <p className="num font-display text-4xl font-extrabold text-foreground">{newCount}</p>
          <p className="mt-1 text-sm text-muted-foreground">waiting on a first read</p>
        </Panel>
        <Panel title="Quoted">
          <p className="num font-display text-4xl font-extrabold text-foreground">{quotedCount}</p>
          <p className="mt-1 text-sm text-muted-foreground">priced, not booked yet</p>
        </Panel>
        <Panel title="Booked">
          <p className="num font-display text-4xl font-extrabold text-foreground">{bookedCount}</p>
          <p className="mt-1 text-sm text-muted-foreground">on the calendar</p>
        </Panel>
      </div>

      <Panel
        title="Recent activity"
        aside={
          <Link
            to="/dashboard/leads"
            className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
          >
            View all <ArrowRight className="h-3 w-3" />
          </Link>
        }
      >
        {recent.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">No leads yet — they'll show up here as they come in.</p>
        ) : (
          <ul className="divide-y divide-border">
            {recent.map((lead) => (
              <li key={lead.id}>
                <Link
                  to="/dashboard/leads/$id"
                  params={{ id: lead.id }}
                  className="flex items-center justify-between gap-4 py-3 hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{lead.customer}</p>
                    <p className="truncate text-xs text-muted-foreground">{lead.problem}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="num text-sm text-foreground">{money(lineItemsTotal(lead.lineItems))}</span>
                    <StatusPill status={lead.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Your widget">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-md text-sm text-muted-foreground">
            Paste this on your site, or share the standalone link directly — same flow either way.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => copyText(embedSnippet(tenant.slug), "Embed code copied")}
            >
              <Code2 className="mr-2 h-4 w-4" /> Copy embed code
            </Button>
            <Button variant="outline" onClick={() => copyText(quoteLink(tenant.slug), "Link copied")}>
              Copy shareable link
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
