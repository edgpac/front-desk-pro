import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, Printer } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getLead, lineItemsTotal, money, TENANT } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/leads/$id/proposal")({
  loader: ({ params }) => {
    const lead = getLead(params.id);
    if (!lead) throw notFound();
    return lead;
  },
  component: Proposal,
});

function Proposal() {
  const lead = Route.useLoaderData();
  const total = lineItemsTotal(lead.lineItems);
  const issued = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const proposalNumber = lead.id.replace("L-", "P-");

  return (
    <div className="bg-paper p-6 lg:p-10 print:bg-white print:p-0">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between print:hidden">
          <Link
            to="/dashboard/leads/$id"
            params={{ id: lead.id }}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to lead
          </Link>
          <Button onClick={() => window.print()}>
            <Printer className="mr-2 h-4 w-4" /> Print / Save as PDF
          </Button>
        </div>

        <div className="border border-border-strong bg-card p-8 print:border-0 print:p-0 sm:p-12">
          <div className="flex items-start justify-between border-b-2 border-ink pb-5">
            <div>
              <p className="font-display text-lg font-extrabold text-foreground">{TENANT.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">{TENANT.trade} services</p>
              <p className="text-sm text-muted-foreground">{TENANT.phone}</p>
              <p className="text-sm text-muted-foreground">{TENANT.area}</p>
            </div>
            <div className="text-right">
              <p className="font-display text-base font-bold text-foreground">#{proposalNumber}</p>
              <p className="mt-1 text-sm text-muted-foreground">Date: {issued}</p>
              <p className="text-sm text-muted-foreground">Valid for 30 days</p>
            </div>
          </div>

          <h1 className="my-8 text-center font-display text-4xl italic text-foreground">Proposal</h1>

          <div className="flex items-start justify-between border-l-4 border-ink bg-muted px-4 py-3">
            <div>
              <p className="font-semibold text-foreground">{lead.customer}</p>
              <p className="text-sm text-muted-foreground">{lead.phone}</p>
              <p className="text-sm text-muted-foreground">{lead.address}</p>
            </div>
            <div className="text-right text-sm text-muted-foreground">
              <p>
                <span className="font-semibold text-foreground">Issue:</span> {lead.problem}
              </p>
            </div>
          </div>

          <table className="mt-6 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-ink text-left text-xs font-bold uppercase tracking-wide text-muted-foreground">
                <th className="py-2">Description</th>
                <th className="py-2 text-right">Qty</th>
                <th className="py-2 text-right">Rate</th>
                <th className="py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {lead.lineItems.map((item) => (
                <tr key={item.id} className="border-b border-border">
                  <td className="py-3 pr-4 font-medium text-foreground">{item.description}</td>
                  <td className="py-3 text-right text-muted-foreground">
                    {item.qty} {item.unit}
                  </td>
                  <td className="py-3 text-right text-muted-foreground">{money(item.rate)}</td>
                  <td className="num py-3 text-right font-semibold text-foreground">
                    {money(item.qty * item.rate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 flex justify-end">
            <div className="w-64">
              <div className="flex justify-between border-t-2 border-ink pt-3 text-base font-bold text-foreground">
                <span>Total estimate</span>
                <span className="num">{money(total)}</span>
              </div>
            </div>
          </div>

          <div className="mt-8 space-y-4 border-t border-border pt-6 text-sm text-muted-foreground">
            <div>
              <h3 className="font-semibold text-foreground">Diagnosis</h3>
              <p className="mt-1">{lead.diagnosis}</p>
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Payment & warranty</h3>
              <p className="mt-1">50% deposit at start · 50% upon completion · 30-day warranty on workmanship.</p>
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Contact</h3>
              <p className="mt-1">{TENANT.phone}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
