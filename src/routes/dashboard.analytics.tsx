import { createFileRoute } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { FUNNEL, WEEKDAYS, LEADS, lineItemsTotal, money } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/analytics")({
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const wonLeads = LEADS.filter((l) => l.status === "won");
  const avgJobValue =
    wonLeads.length > 0
      ? wonLeads.reduce((sum, l) => sum + lineItemsTotal(l.lineItems), 0) / wonLeads.length
      : 0;
  const firstStage = FUNNEL[0]?.count ?? 0;
  const wonStage = FUNNEL[FUNNEL.length - 1]?.count ?? 0;
  const conversion = firstStage > 0 ? Math.round((wonStage / firstStage) * 100) : 0;
  const busiestDay = WEEKDAYS.reduce<(typeof WEEKDAYS)[number] | undefined>(
    (max, d) => (!max || d.leads > max.leads ? d : max),
    undefined,
  );

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader eyebrow="Analytics" title="How requests turn into revenue" />

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
            <BarChart data={FUNNEL} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
            <BarChart data={WEEKDAYS} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
