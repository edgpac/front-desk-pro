import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Minus } from "lucide-react";

import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — FrontDesk for trades" },
      {
        name: "description",
        content:
          "$19/mo solo, $39/mo for a crew, custom for multi-truck shops. 14-day free trial, no card up front, cancel anytime.",
      },
      { property: "og:title", content: "FrontDesk pricing — $19/mo solo, $39/mo crew" },
      {
        property: "og:description",
        content: "One extra booked service call a month covers it. 14 days free, no card up front.",
      },
    ],
  }),
  component: Pricing,
});

const tiers = [
  {
    name: "Solo",
    price: "$19",
    per: "/mo",
    for: "One person, one truck.",
    points: ["Unlimited quote requests", "Photo estimates off your price sheet", "Lead inbox", "Branded proposals", "Widget + shareable link"],
    cta: "Start free trial",
    featured: false,
  },
  {
    name: "Crew",
    price: "$39",
    per: "/mo",
    for: "Two to five techs.",
    points: [
      "Everything in Solo",
      "Hourly + flat + range pricing",
      "Follow-up thread with customers",
      "Analytics and CSV export",
      "Priority quote turnaround",
    ],
    cta: "Start free trial",
    featured: true,
  },
  {
    name: "Shop",
    price: "Custom",
    per: "",
    for: "Multi-truck, multiple trades.",
    points: ["Everything in Crew", "Multiple price sheets", "Per-trade routing", "Onboarding done for you", "Phone support"],
    cta: "Talk to us",
    featured: false,
  },
];

const matrix = [
  { row: "Quote requests", solo: "Unlimited", crew: "Unlimited", shop: "Unlimited" },
  { row: "Price sheet photo extraction", solo: true, crew: true, shop: true },
  { row: "Manual price editing", solo: true, crew: true, shop: true },
  { row: "Hourly labor math", solo: false, crew: true, shop: true },
  { row: "Branded proposal PDF", solo: true, crew: true, shop: true },
  { row: "Customer follow-up thread", solo: false, crew: true, shop: true },
  { row: "Analytics + CSV export", solo: false, crew: true, shop: true },
  { row: "Multiple price sheets", solo: false, crew: false, shop: true },
  { row: "Phone support", solo: false, crew: false, shop: true },
];

function Cell({ v }: { v: boolean | string }) {
  if (typeof v === "string") return <span className="text-sm text-foreground">{v}</span>;
  return v ? (
    <Check className="h-4 w-4 text-success" />
  ) : (
    <Minus className="h-4 w-4 text-muted-foreground" />
  );
}

function Pricing() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <section className="border-b border-border-strong bg-paper">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <p className="label-caps text-primary">Pricing</p>
          <h1 className="mt-3 max-w-2xl text-4xl sm:text-5xl">
            One flat price. It pays for itself on the first job you'd have missed.
          </h1>
          <p className="mt-4 max-w-xl text-[15px] text-muted-foreground">
            14 days free, no card up front. Month to month — cancel from the billing page, no phone call.
          </p>
        </div>
      </section>

      <section className="border-b border-border-strong">
        <div className="mx-auto grid max-w-6xl gap-px bg-border-strong lg:grid-cols-3">
          {tiers.map((t) => (
            <div
              key={t.name}
              className={`flex flex-col bg-card p-7 ${t.featured ? "ring-2 ring-inset ring-primary" : ""}`}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-xl">{t.name}</h2>
                {t.featured && <span className="label-caps text-primary">Most shops pick this</span>}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{t.for}</p>
              <p className="mt-6">
                <span className="num font-display text-4xl font-extrabold text-foreground">{t.price}</span>
                <span className="text-sm text-muted-foreground">{t.per}</span>
              </p>
              <ul className="mt-6 space-y-2.5 border-t border-border pt-6 text-sm">
                {t.points.map((p) => (
                  <li key={p} className="flex gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="text-muted-foreground">{p}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-7 pt-1">
                <Button asChild className="w-full" variant={t.featured ? "default" : "outline"}>
                  <Link to={t.cta === "Talk to us" ? "/demo" : "/signup"}>{t.cta}</Link>
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-paper">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <h2 className="text-2xl">Line by line</h2>
          <div className="mt-6 overflow-x-auto border border-border-strong bg-card">
            <table className="w-full min-w-[560px] text-left">
              <thead>
                <tr className="border-b border-border-strong">
                  <th className="label-caps px-4 py-3 text-muted-foreground">Feature</th>
                  <th className="label-caps px-4 py-3 text-muted-foreground">Solo</th>
                  <th className="label-caps px-4 py-3 text-muted-foreground">Crew</th>
                  <th className="label-caps px-4 py-3 text-muted-foreground">Shop</th>
                </tr>
              </thead>
              <tbody>
                {matrix.map((m) => (
                  <tr key={m.row} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 text-sm text-foreground">{m.row}</td>
                    <td className="px-4 py-3">
                      <Cell v={m.solo} />
                    </td>
                    <td className="px-4 py-3">
                      <Cell v={m.crew} />
                    </td>
                    <td className="px-4 py-3">
                      <Cell v={m.shop} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
