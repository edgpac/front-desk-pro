import { useState } from "react";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, Calendar, FileText, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { StatusPill } from "@/components/app/StatusPill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getLead,
  lineItemsTotal,
  money,
  STATUS_LABEL,
  TENANT,
  type LeadStatus,
  type LineItem,
} from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/leads/$id/")({
  loader: ({ params }) => {
    const lead = getLead(params.id);
    if (!lead) throw notFound();
    return lead;
  },
  component: LeadDetail,
});

const STATUS_ACTIONS: LeadStatus[] = ["quoted", "booked", "won", "lost"];

function LeadDetail() {
  const initial = Route.useLoaderData();
  const [status, setStatus] = useState(initial.status);
  const [lineItems, setLineItems] = useState(initial.lineItems);
  const [message, setMessage] = useState("");
  const [thread, setThread] = useState(initial.followUps);

  const total = lineItemsTotal(lineItems);

  function updateItem<K extends keyof LineItem>(id: string, key: K, value: LineItem[K]) {
    setLineItems((items) => items.map((i) => (i.id === id ? { ...i, [key]: value } : i)));
  }

  function removeItem(id: string) {
    setLineItems((items) => items.filter((i) => i.id !== id));
  }

  function addItem() {
    setLineItems((items) => [
      ...items,
      { id: `new-${Date.now()}`, description: "New line item", qty: 1, unit: "job", rate: 0 },
    ]);
  }

  function sendMessage() {
    if (!message.trim()) return;
    setThread((t) => [...t, { role: "assistant", text: message }]);
    setMessage("");
    toast.success("Sent to the customer's thread");
  }

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <Link
        to="/dashboard/leads"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to lead inbox
      </Link>

      <PageHeader
        eyebrow={initial.requested}
        title={initial.customer}
        description={`${initial.phone} · ${initial.address} · via ${initial.channel}`}
        actions={<StatusPill status={status} className="text-sm" />}
      />

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-6">
          <Panel title="Photo & description">
            <img
              src={initial.photo}
              alt={initial.problem}
              className="aspect-video w-full rounded-sm object-cover"
            />
            <p className="mt-3 text-sm text-foreground">{initial.problem}</p>
          </Panel>

          <Panel
            title="AI diagnosis"
            aside={
              <button
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                onClick={() => toast.info("Re-analysis needs this lead wired to a live backend first.")}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Ask AI to re-analyze
              </button>
            }
          >
            <p className="text-xs text-muted-foreground">
              Confidence: <span className="font-semibold text-foreground">{initial.confidence}</span>
            </p>
            <p className="mt-2 text-sm leading-relaxed text-foreground">{initial.diagnosis}</p>
          </Panel>

          <Panel title="Line items — edit before sending">
            <ul className="divide-y divide-border">
              {lineItems.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center gap-2 py-3">
                  <Input
                    value={item.description}
                    onChange={(e) => updateItem(item.id, "description", e.target.value)}
                    className="min-w-[200px] flex-1"
                    aria-label="Description"
                  />
                  <Input
                    type="number"
                    value={item.qty}
                    onChange={(e) => updateItem(item.id, "qty", e.target.valueAsNumber || 0)}
                    className="w-16 text-right"
                    aria-label={`Quantity for ${item.description}`}
                  />
                  <Input
                    value={item.unit}
                    onChange={(e) => updateItem(item.id, "unit", e.target.value)}
                    className="w-20"
                    aria-label={`Unit for ${item.description}`}
                  />
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm text-muted-foreground">$</span>
                    <Input
                      type="number"
                      value={item.rate}
                      onChange={(e) => updateItem(item.id, "rate", e.target.valueAsNumber || 0)}
                      className="w-24 text-right"
                      aria-label={`Rate for ${item.description}`}
                    />
                  </div>
                  <button
                    onClick={() => removeItem(item.id)}
                    className="rounded-sm p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Remove ${item.description}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t border-border-strong pt-3">
              <Button variant="outline" size="sm" onClick={addItem}>
                <Plus className="mr-2 h-4 w-4" /> Add line item
              </Button>
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-border-strong pt-3">
              <span className="text-sm font-semibold text-foreground">Total</span>
              <span className="num text-lg font-extrabold text-foreground">{money(total)}</span>
            </div>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Move this lead">
            <div className="flex flex-wrap gap-2">
              {STATUS_ACTIONS.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={status === s ? "default" : "outline"}
                  onClick={() => {
                    setStatus(s);
                    toast.success(`Marked ${STATUS_LABEL[s]}`);
                  }}
                >
                  {STATUS_LABEL[s]}
                </Button>
              ))}
            </div>
          </Panel>

          <Panel title="Take action">
            <p className="mb-3 text-xs text-muted-foreground">
              Each of these stands on its own — generate whichever one fits the job, in any order.
            </p>
            <div className="space-y-2">
              <Button asChild className="w-full">
                <Link to="/dashboard/leads/$id/proposal" params={{ id: initial.id }}>
                  <FileText className="mr-2 h-4 w-4" /> Generate proposal
                </Link>
              </Button>
              <Button variant="outline" asChild className="w-full">
                <Link to="/dashboard/leads/$id/invoice" params={{ id: initial.id }}>
                  <FileText className="mr-2 h-4 w-4" /> Generate invoice
                </Link>
              </Button>
              <Button variant="outline" asChild className="w-full">
                <Link to="/dashboard/leads/$id/receipt" params={{ id: initial.id }}>
                  <FileText className="mr-2 h-4 w-4" /> Generate receipt
                </Link>
              </Button>
              <Button variant="outline" asChild className="w-full">
                <a href={TENANT.calendarLink} target="_blank" rel="noreferrer">
                  <Calendar className="mr-2 h-4 w-4" /> Add to calendar
                </a>
              </Button>
            </div>
          </Panel>

          <Panel title="Message thread">
            <div className="space-y-2.5">
              {thread.length === 0 && (
                <p className="text-sm text-muted-foreground">No messages yet.</p>
              )}
              {thread.map((m, i) => (
                <div
                  key={i}
                  className={
                    m.role === "customer"
                      ? "rounded-sm bg-muted px-3 py-2 text-sm text-foreground"
                      : "ml-4 rounded-sm bg-ink px-3 py-2 text-sm text-ink-foreground"
                  }
                >
                  {m.text}
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                placeholder="Reply to the customer…"
                aria-label="Message the customer"
              />
              <Button variant="outline" onClick={sendMessage} disabled={!message.trim()} aria-label="Send">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
