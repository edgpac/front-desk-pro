import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Calendar, FileText, Paperclip, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { StatusPill } from "@/components/app/StatusPill";
import { DOCUMENT_LABEL, formatDocNumber, type DocumentKind } from "@/components/app/BusinessDocument";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/use-auth";
import {
  getMyLead,
  saveLeadLineItems,
  updateLeadStatus,
  updateLeadContact,
  addLeadMessage,
} from "@/lib/leads-server";
import { getMyTenant } from "@/lib/tenant-server";
import { buildSuggestedReply, lineItemsMatch } from "@/lib/reply-composer";
import {
  getLead,
  lineItemsTotal,
  money,
  STATUS_LABEL,
  TENANT,
  type Lead,
  type LeadStatus,
  type LineItem,
  type Tenant,
} from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/leads/$id/")({
  component: LeadDetail,
});

const STATUS_ACTIONS: LeadStatus[] = ["quoted", "booked", "won", "lost"];

function LeadDetail() {
  const { id } = Route.useParams();
  const { user, loading: authLoading } = useAuth();

  const [lead, setLead] = useState<Lead | null>(null);
  const [aiSnapshot, setAiSnapshot] = useState<LineItem[] | null>(null);
  const [tenant, setTenant] = useState<Tenant>(TENANT);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [status, setStatus] = useState<LeadStatus>("new");
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [thread, setThread] = useState<{ role: "customer" | "assistant"; text: string }[]>([]);
  const [contact, setContact] = useState({ customer: "", phone: "", address: "" });
  // null = "untouched" — the box tracks the AI-drafted suggestion live. Once
  // the user types, it holds their exact text until they send or explicitly
  // revert, at which point it goes back to null so it starts tracking again.
  const [manualMessage, setManualMessage] = useState<string | null>(null);
  const [savingLineItems, setSavingLineItems] = useState(false);
  const [savingContact, setSavingContact] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      const mockLead = getLead(id);
      if (!mockLead) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setLead(mockLead);
      setAiSnapshot(mockLead.lineItems);
      setStatus(mockLead.status);
      setLineItems(mockLead.lineItems);
      setThread(mockLead.followUps);
      setContact({ customer: mockLead.customer, phone: mockLead.phone, address: mockLead.address });
      setTenant(TENANT);
      setLoading(false);
      return;
    }
    let active = true;
    Promise.all([getMyLead({ data: id }), getMyTenant()])
      .then(([realLead, realTenant]) => {
        if (!active) return;
        setLead(realLead);
        setAiSnapshot(realLead.aiLineItemsSnapshot);
        setStatus(realLead.status);
        setLineItems(realLead.lineItems);
        setThread(realLead.followUps);
        setContact({ customer: realLead.customer, phone: realLead.phone, address: realLead.address });
        setTenant(realTenant);
      })
      .catch(() => {
        if (active) setNotFound(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user, id]);

  const total = lineItemsTotal(lineItems);
  const isEdited = aiSnapshot ? !lineItemsMatch(lineItems, aiSnapshot) : false;

  // The message draft is derived straight from the diagnosis + whatever the
  // line items currently total — so when the AI gets the job right, there's
  // nothing to edit here either: the price is already correct, and sending
  // it is the only action left.
  const suggestedReply = lead
    ? buildSuggestedReply({
        problem: lead.problem,
        diagnosis: lead.diagnosis,
        total,
        currency: tenant.currency,
      })
    : "";
  const message = manualMessage ?? suggestedReply;

  function updateItem<K extends keyof LineItem>(itemId: string, key: K, value: LineItem[K]) {
    setLineItems((items) => items.map((i) => (i.id === itemId ? { ...i, [key]: value } : i)));
  }

  function removeItem(itemId: string) {
    setLineItems((items) => items.filter((i) => i.id !== itemId));
  }

  function addItem() {
    setLineItems((items) => [
      ...items,
      { id: `new-${Date.now()}`, description: "New line item", qty: 1, unit: "job", rate: 0 },
    ]);
  }

  async function saveLineItems() {
    if (!user) {
      toast.success("Saved (sample data — sign up to save your real leads)");
      return;
    }
    setSavingLineItems(true);
    try {
      await saveLeadLineItems({
        data: {
          leadId: id,
          items: lineItems.map((i) => ({ description: i.description, qty: i.qty, unit: i.unit, rate: i.rate })),
        },
      });
      toast.success("Line items saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save line items.");
    } finally {
      setSavingLineItems(false);
    }
  }

  function updateContact<K extends keyof typeof contact>(key: K, value: (typeof contact)[K]) {
    setContact((c) => ({ ...c, [key]: value }));
  }

  async function saveContact() {
    if (!user) {
      toast.success("Saved (sample data — sign up to save your real leads)");
      return;
    }
    setSavingContact(true);
    try {
      await updateLeadContact({
        data: { id, customerName: contact.customer, phone: contact.phone, address: contact.address },
      });
      toast.success("Contact info saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save contact info.");
    } finally {
      setSavingContact(false);
    }
  }

  async function changeStatus(next: LeadStatus) {
    setStatus(next);
    toast.success(`Marked ${STATUS_LABEL[next]}`);
    if (!user) return;
    try {
      await updateLeadStatus({ data: { id, status: next } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update status.");
    }
  }

  async function sendMessage() {
    if (!message.trim()) return;
    const body = message.trim();
    setThread((t) => [...t, { role: "assistant", text: body }]);
    setManualMessage(null);
    if (user) {
      try {
        await addLeadMessage({ data: { leadId: id, body } });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not send message.");
        return;
      }
    }
    toast.success("Sent to the customer's thread");
  }

  // UI hook for whenever a real outbound channel (WhatsApp/SMS/email) exists —
  // for now this only adds a reference line to the draft; there's no
  // attachment or delivery happening yet.
  function shareDocument(kind: DocumentKind) {
    if (!lead) return;
    const docNumber = formatDocNumber(kind, lead.id);
    const line = `📎 Sharing your ${DOCUMENT_LABEL[kind].toLowerCase()} (${docNumber}) — ${money(total, tenant.currency)} total.`;
    setManualMessage(message.trim() ? `${message}\n\n${line}` : line);
    toast.info("Added to the draft — will actually attach the document once a real channel is wired up.");
  }

  if (loading) {
    return <div className="p-10 text-sm text-muted-foreground">Loading…</div>;
  }
  if (notFound || !lead) {
    return <div className="p-10 text-sm text-muted-foreground">Lead not found.</div>;
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
        eyebrow={lead.requested}
        title={contact.customer}
        description={`${contact.phone} · ${contact.address} · via ${lead.channel}`}
        actions={<StatusPill status={status} className="text-sm" />}
      />

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-6">
          <Panel title="Customer">
            <p className="mb-3 text-xs text-muted-foreground">
              Confirm who this is for — a WhatsApp or widget name isn't always the actual customer (e.g. a
              rental's property manager texting on a tenant's behalf).
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                value={contact.customer}
                onChange={(e) => updateContact("customer", e.target.value)}
                aria-label="Customer name"
                placeholder="Customer name"
              />
              <Input
                value={contact.phone}
                onChange={(e) => updateContact("phone", e.target.value)}
                aria-label="Customer phone"
                placeholder="Phone"
              />
              <Input
                value={contact.address}
                onChange={(e) => updateContact("address", e.target.value)}
                aria-label="Customer address"
                placeholder="Address (incl. cross streets / zip)"
                className="sm:col-span-2"
              />
            </div>
            <div className="mt-3 flex justify-end border-t border-border-strong pt-3">
              <Button size="sm" variant="outline" onClick={() => void saveContact()} disabled={savingContact}>
                {savingContact ? "Saving…" : "Save contact info"}
              </Button>
            </div>
          </Panel>

          <Panel title="Photo & description">
            <img src={lead.photo} alt={lead.problem} className="aspect-video w-full rounded-sm object-cover" />
            <p className="mt-3 text-sm text-foreground">{lead.problem}</p>
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
              Confidence: <span className="font-semibold text-foreground">{lead.confidence}</span>
              {aiSnapshot && !isEdited && (
                <span className="ml-2 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
                  Matches AI pricing — nothing edited
                </span>
              )}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-foreground">{lead.diagnosis}</p>
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
            <div className="mt-3 flex items-center justify-between border-t border-border-strong pt-3">
              <Button variant="outline" size="sm" onClick={addItem}>
                <Plus className="mr-2 h-4 w-4" /> Add line item
              </Button>
              <Button size="sm" variant="outline" onClick={() => void saveLineItems()} disabled={savingLineItems}>
                {savingLineItems ? "Saving…" : "Save line items"}
              </Button>
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-border-strong pt-3">
              <span className="text-sm font-semibold text-foreground">Total</span>
              <span className="num text-lg font-extrabold text-foreground">{money(total, tenant.currency)}</span>
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
                  onClick={() => void changeStatus(s)}
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
                <Link to="/dashboard/leads/$id/proposal" params={{ id: lead.id }}>
                  <FileText className="mr-2 h-4 w-4" /> Generate proposal
                </Link>
              </Button>
              <Button variant="outline" asChild className="w-full">
                <Link to="/dashboard/leads/$id/invoice" params={{ id: lead.id }}>
                  <FileText className="mr-2 h-4 w-4" /> Generate invoice
                </Link>
              </Button>
              <Button variant="outline" asChild className="w-full">
                <Link to="/dashboard/leads/$id/receipt" params={{ id: lead.id }}>
                  <FileText className="mr-2 h-4 w-4" /> Generate receipt
                </Link>
              </Button>
              <Button variant="outline" asChild className="w-full">
                <a href={tenant.calendarLink} target="_blank" rel="noreferrer">
                  <Calendar className="mr-2 h-4 w-4" /> Add to calendar
                </a>
              </Button>
            </div>
          </Panel>

          <Panel title="Message thread">
            <div className="space-y-2.5">
              {thread.length === 0 && <p className="text-sm text-muted-foreground">No messages yet.</p>}
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
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(["proposal", "invoice", "receipt"] as DocumentKind[]).map((kind) => (
                <button
                  key={kind}
                  onClick={() => shareDocument(kind)}
                  className="inline-flex items-center gap-1 rounded-sm border border-border-strong px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Paperclip className="h-3 w-3" /> Share {DOCUMENT_LABEL[kind].toLowerCase()}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Drafted from the diagnosis and current total — edit it, or just send.
            </p>
            <div className="mt-1.5 flex gap-2">
              <Textarea
                value={message}
                onChange={(e) => setManualMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder="Reply to the customer…"
                aria-label="Message the customer"
                rows={3}
                className="text-sm"
              />
              <Button variant="outline" onClick={() => void sendMessage()} disabled={!message.trim()} aria-label="Send">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
