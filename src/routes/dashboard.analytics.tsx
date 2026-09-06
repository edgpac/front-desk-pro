import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { useAuth } from "@/lib/use-auth";
import { listMyLeads } from "@/lib/leads-server";
import { FUNNEL, WEEKDAYS, LEADS, type Lead, lineItemsTotal, money } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/analytics")({
  component: AnalyticsPage,
});

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WINDOW_MS = 28 * 24 * 60 * 60 * 1000;

function computeRealAnalytics(leads: Lead[]) {
  const cutoff = Date.now() - WINDOW_MS;
  const recent = leads.filter((l) => l.createdAt && new Date(l.createdAt).getTime() >= cutoff);

  const stageCount = (statuses: Lead["status"][]) => recent.filter((l) => statuses.includes(l.status)).length;
  const funnel = [
    { stage: "Requests", count: recent.length },
    { stage: "Quoted", count: stageCount(["quoted", "booked", "won"]) },
    { stage: "Booked", count: stageCount(["booked", "won"]) },
    { stage: "Won", count: stageCount(["won"]) },
  ];
  const conversion = recent.length > 0 ? Math.round((funnel[3]!.count / recent.length) * 100) : 0;

  const wonLeads = recent.filter((l) => l.status === "won");
  const avgJobValue =
    wonLeads.length > 0
      ? wonLeads.reduce((sum, l) => sum + lineItemsTotal(l.lineItems), 0) / wonLeads.length
      : 0;

  const weekdayCounts = DAY_LABELS.map((day) => ({ day, leads: 0 }));
  for (const lead of recent) {
    if (!lead.createdAt) continue;
    const jsDay = new Date(lead.createdAt).getDay(); // 0 = Sun
    const index = jsDay === 0 ? 6 : jsDay - 1; // realign to Mon-first
    weekdayCounts[index]!.leads++;
  }
  const busiestDay = weekdayCounts.reduce<(typeof weekdayCounts)[number] | undefined>(
    (max, d) => (!max || d.leads > max.leads) ? d : max,
    undefined,
  );

  return { funnel, weekdays: weekdayCounts, conversion, avgJobValue, busiestDay, recentCount: recent.length };
}

function AnalyticsPage() {
  const { user, loading: authLoading } = useAuth();
  const [leads, setLeads] = useState<Lead[]>(LEADS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLeads(LEADS);
      setLoading(false);
      return;
    }
    let active = true;
    listMyLeads()
      .then((real) => {
        if (active) setLeads(real);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load analytics.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  if (loading) {
    return (
      <div className="space-y-6 p-6 lg:p-10">
        <PageHeader eyebrow="Analytics" title="Loading…" />
      </div>
    );
  }

  // Sample/logged-out preview keeps the original hand-authored constants and
  // the original computation exactly as it was — real per-lead dates would
  // just make an empty demo account look broken.
  let funnel, weekdays, conversion, avgJobValue, busiestDay, recentCount;
  if (user) {
    ({ funnel, weekdays, conversion, avgJobValue, busiestDay, recentCount } = computeRealAnalytics(leads));
  } else {
    const wonLeads = LEADS.filter((l) => l.status === "won");
    avgJobValue =
      wonLeads.length > 0
        ? wonLeads.reduce((sum, l) => sum + lineItemsTotal(l.lineItems), 0) / wonLeads.length
        : 0;
    const firstStage = FUNNEL[0]?.count ?? 0;
    const wonStage = FUNNEL[FUNNEL.length - 1]?.count ?? 0;
    conversion = firstStage > 0 ? Math.round((wonStage / firstStage) * 100) : 0;
    busiestDay = WEEKDAYS.reduce<(typeof WEEKDAYS)[number] | undefined>(
      (max, d) => (!max || d.leads > max.leads ? d : max),
      undefined,
    );
    funnel = FUNNEL;
    weekdays = WEEKDAYS;
    recentCount = 1; // never shows the empty-state note in sample mode
  }

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader eyebrow="Analytics" title="How requests turn into revenue" />

      {user && recentCount === 0 ? (
        <Panel>
          <p className="text-sm text-muted-foreground">
            No leads in the last 28 days yet — these charts will fill in as requests come in.
          </p>
        </Panel>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Panel title="Requests → Won">
          <p className="num font-display text-4xl font-extrabold text-foreground">{conversion}%</p>
          <p className="mt-1 text-sm text-muted-foreground">last 28 days</p>
        </Panel>
        <Panel title="Average job value">
          <p className="num font-display text-4xl font-extrabold text-foreground">{money(avgJobValue)}</p>
          <p className="mt-1 text-sm text-muted-foreground">on won leads</p>
        </Panel>
        <Panel title="Busiest day">
          <p className="num font-display text-4xl font-extrabold text-foreground">
            {busiestDay?.day ?? "—"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">by request volume</p>
        </Panel>
      </div>

      <Panel title="Funnel">
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={funnel} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
              <XAxis dataKey="stage" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} width={32} />
              <Tooltip
                cursor={{ fill: "var(--muted)" }}
                contentStyle={{ borderRadius: 2, borderColor: "var(--border-strong)", fontSize: 13 }}
              />
              <Bar dataKey="count" fill="var(--primary)" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <Panel title="Requests by day of week">
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weekdays} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
              <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} width={32} />
              <Tooltip
                cursor={{ fill: "var(--muted)" }}
                contentStyle={{ borderRadius: 2, borderColor: "var(--border-strong)", fontSize: 13 }}
              />
              <Bar dataKey="leads" fill="var(--accent)" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>
    </div>
  );
}
