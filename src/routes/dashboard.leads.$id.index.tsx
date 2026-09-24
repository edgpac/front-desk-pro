import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
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
  updateLeadDiagnosis,
  deleteLead,
} from "@/lib/leads-server";
import { sendLeadReply, sendLeadReplyWithTemplate } from "@/lib/lead-reply-server";
import { listMyWhatsAppTemplates, countTemplateVariables, type WhatsAppTemplate } from "@/lib/whatsapp-templates-server";
import { getMyTenant } from "@/lib/tenant-server";
import { buildSuggestedReply, lineItemsMatch } from "@/lib/reply-composer";
import {
  getLead,
  getLeadPricingStatus,
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
  const navigate = useNavigate();

  const [lead, setLead] = useState<Lead | null>(null);
  const [aiSnapshot, setAiSnapshot] = useState<LineItem[] | null>(null);
  const [tenant, setTenant] = useState<Tenant>(TENANT);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [status, setStatus] = useState<LeadStatus>("new");
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [thread, setThread] = useState<{ role: "customer" | "assistant"; text: string }[]>([]);
  const [contact, setContact] = useState({ customer: "", phone: "", address: "" });
  const [diagnosis, setDiagnosis] = useState("");
  const [originalDiagnosis, setOriginalDiagnosis] = useState("");
  // null = "untouched" — the box tracks the AI-drafted suggestion live. Once
  // the user types, it holds their exact text until they send or explicitly
  // revert, at which point it goes back to null so it starts tracking again.
  const [manualMessage, setManualMessage] = useState<string | null>(null);
  const [savingLineItems, setSavingLineItems] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  const [savingDiagnosis, setSavingDiagnosis] = useState(false);
  const [sending, setSending] = useState(false);
  // Only surfaced once sendMessage() actually hits Meta's 24h-window error —
  // approved templates are loaded eagerly (cheap, small list) but the
  // picker itself stays hidden until it's actually needed.
  const [approvedTemplates, setApprovedTemplates] = useState<WhatsAppTemplate[]>([]);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templateParams, setTemplateParams] = useState<string[]>([]);

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
      setDiagnosis(mockLead.diagnosis);
      setOriginalDiagnosis(mockLead.diagnosis);
      setTenant(TENANT);
      setLoading(false);
      return;
    }
    let active = true;
    Promise.all([getMyLead({ data: id }), getMyTenant(), listMyWhatsAppTemplates().catch(() => [])])
      .then(([realLead, realTenant, templates]) => {
        if (!active) return;
        setApprovedTemplates(templates.filter((t) => t.status === "approved"));
        setLead(realLead);
        setAiSnapshot(realLead.aiLineItemsSnapshot);
        setStatus(realLead.status);
        setLineItems(realLead.lineItems);
        setThread(realLead.followUps);
        setContact({ customer: realLead.customer, phone: realLead.phone, address: realLead.address });
        setDiagnosis(realLead.diagnosis);
        setOriginalDiagnosis(realLead.diagnosis);
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

  // isPendingPrice: narrower than pricingStatus below — specifically "is the
  // pending_negotiated_price flag still active," used only for the flagged-
  // review panel's title/copy (why this lead needs review), not for whether
  // a total/document can be shown.
  const isPendingPrice = lead?.flagType === "pending_negotiated_price";
  // P2 mixed-pricing: same narrow purpose as isPendingPrice above, for the
  // flagged-review panel's title/copy specifically — never reuses
  // isPendingPrice's "the entire price is pending" wording, since here
  // part of the request already has a real, confirmed price.
  const isPartiallyPriced = lead?.flagType === "partially_priced";
  // P1-B: the authoritative answer to "can a real total be shown/used for
  // this lead right now" — covers both the active-flag case and the case a
  // flag was cleared (e.g. "Mark reviewed") without a price ever being
  // added, which used to fall straight through to a bare, indistinguishable-
  // from-real $0. See mock-data.ts's getLeadPricingStatus.
  const pricingStatus = lead ? getLeadPricingStatus({ flagType: lead.flagType, lineItems }) : ({ priced: false, label: "Not yet priced" } as const);
  const total = pricingStatus.priced ? pricingStatus.amount : 0;
  const isEdited = aiSnapshot ? !lineItemsMatch(lineItems, aiSnapshot) : false;
  const diagnosisEdited = diagnosis !== originalDiagnosis;

  // The message draft is derived straight from the diagnosis + whatever the
  // line items currently total — so when the AI gets the job right, there's
  // nothing to edit here either: the price is already correct, and sending
  // it is the only action left. Correcting the diagnosis text below feeds
  // straight into this draft and into the proposal/invoice documents, since
  // both read the same field.
  const suggestedReply = lead
    ? buildSuggestedReply({
        problem: lead.problem,
        diagnosis,
        total,
        currency: tenant.currency,
        noPriceYet: !pricingStatus.priced,
        hasDeferredPortion: pricingStatus.priced && Boolean(pricingStatus.hasDeferredPortion),
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

  async function saveDiagnosis() {
    if (!user) {
      setOriginalDiagnosis(diagnosis);
      toast.success("Saved (sample data — sign up to save your real leads)");
      return;
    }
    setSavingDiagnosis(true);
    try {
      await updateLeadDiagnosis({ data: { id, diagnosis } });
      setOriginalDiagnosis(diagnosis);
      toast.success("Diagnosis saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save diagnosis.");
    } finally {
      setSavingDiagnosis(false);
    }
  }

  async function handleDeleteLead() {
    if (!lead) return;
    if (!window.confirm(`Delete the lead from "${lead.customer}"? This can't be undone.`)) return;
    if (!user) {
      toast.success("Deleted (sample data — nothing real to remove)");
      void navigate({ to: "/dashboard/leads" });
      return;
    }
    try {
      await deleteLead({ data: id });
      toast.success("Lead deleted");
      void navigate({ to: "/dashboard/leads" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete lead.");
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
    if (!message.trim() || sending) return;
    const body = message.trim();

    if (!user) {
      // Sample/demo mode — no real backend, no real channel to fail on.
      setThread((t) => [...t, { role: "assistant", text: body }]);
      setManualMessage(null);
      toast.success("Sent to the customer's thread");
      return;
    }

    setSending(true);
    try {
      const result = await sendLeadReply({ data: { leadId: id, body } });
      if (result.status === "sent") {
        // Only added to the visible thread once the real send (if this
        // lead came in on WhatsApp) actually succeeded — the thread should
        // never claim delivery that didn't happen.
        setThread((t) => [...t, { role: "assistant", text: body }]);
        setManualMessage(null);
        toast.success("Sent to the customer's thread");
      } else if (result.status === "outside_window") {
        const first = approvedTemplates[0];
        if (first) {
          setSelectedTemplateId(first.id);
          setTemplateParams(new Array(countTemplateVariables(first.bodyText)).fill(""));
          setShowTemplatePicker(true);
        } else {
          toast.error(
            "It's been more than 24 hours since this customer's last message — WhatsApp requires a pre-approved template to reach them now, and you don't have one approved yet.",
          );
        }
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send message.");
    } finally {
      setSending(false);
    }
  }

  async function sendTemplate() {
    const template = approvedTemplates.find((t) => t.id === selectedTemplateId);
    if (!template || sending) return;
    setSending(true);
    try {
      const result = await sendLeadReplyWithTemplate({
        data: { leadId: id, templateId: template.id, bodyParams: templateParams },
      });
      if (result.status === "sent") {
        setThread((t) => [...t, { role: "assistant", text: template.bodyText }]);
        setShowTemplatePicker(false);
        toast.success("Template sent");
      } else if (result.status === "error") {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send template.");
    } finally {
      setSending(false);
    }
  }

  // UI hook for whenever a real outbound channel (WhatsApp/SMS/email) exists —
  // for now this only adds a reference line to the draft; there's no
  // attachment or delivery happening yet.
  function shareDocument(kind: DocumentKind) {
    if (!lead) return;
    const docNumber = formatDocNumber(kind, lead.id);
    // Found in P0B's required repo-wide search: this bypassed
    // BusinessDocument.tsx's pending-price guard entirely (that only
    // protects the separate document page, not this shortcut), inserting
    // "$0 total" straight into the reply draft for a lead with no
    // determined price. P1-B broadens this from isPendingPrice alone to
    // pricingStatus — the same fix needed for the "reviewed but never
    // priced" case, which is a different lead state but the identical bug.
    if (!pricingStatus.priced) {
      toast.error(
        pricingStatus.label === "Price pending"
          ? "This job's price is still pending — confirm it with the customer before sharing a document."
          : "This job doesn't have a price yet — add a line item before sharing a document.",
      );
      return;
    }
    // P2 mixed-pricing: same reasoning as BusinessDocument.tsx's guard —
    // an invoice/receipt implies a final, complete charge, which a
    // partially-priced lead isn't. A proposal (an estimate by nature) is
    // still fine to share.
    if (pricingStatus.hasDeferredPortion && kind !== "proposal") {
      toast.error(
        `Part of this request still needs pricing — a ${DOCUMENT_LABEL[kind].toLowerCase()} can't be shared until the whole job is priced. A proposal is fine to share in the meantime.`,
      );
      return;
    }
    const pendingNote = pricingStatus.hasDeferredPortion ? " (pricing pending for part of this request)" : "";
    const line = `📎 Sharing your ${DOCUMENT_LABEL[kind].toLowerCase()} (${docNumber}) — ${money(total, tenant.currency)} total${pendingNote}.`;
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

          {lead.status === "flagged" ? (
            <Panel title={isPendingPrice ? "Pricing pending" : isPartiallyPriced ? "Partially priced" : "Needs your review"}>
              <p className="text-sm text-foreground">
                {lead.flagReason || "The AI couldn't safely quote this automatically."}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {isPendingPrice
                  ? "Call the customer to confirm the service-call/diagnostic fee, then add it as a line item below and mark this reviewed."
                  : isPartiallyPriced
                    ? "Part of this request already has a real, priced line item below. Call the customer to confirm pricing for the rest, add it as another line item, then mark this reviewed."
                    : "No price was invented for this — reply to the customer yourself from the message thread below once you've worked out a number."}
              </p>
              <div className="mt-3 flex justify-end">
                <Button size="sm" variant="outline" onClick={() => void changeStatus("new")}>
                  Mark reviewed
                </Button>
              </div>
            </Panel>
          ) : (
            <Panel
              title={
                <span className="flex flex-col gap-0.5">
                  AI diagnosis
                  <span className="text-[11px] font-normal normal-case tracking-normal text-muted-foreground">
                    Double check responses
                  </span>
                </span>
              }
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
                {diagnosisEdited && (
                  <span className="ml-2 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
                    Diagnosis edited by you
                  </span>
                )}
              </p>
              <Textarea
                value={diagnosis}
                onChange={(e) => setDiagnosis(e.target.value)}
                className="mt-2 text-sm leading-relaxed"
                rows={4}
                aria-label="AI diagnosis"
              />
              <div className="mt-2 flex justify-end">
                <Button size="sm" variant="outline" onClick={() => void saveDiagnosis()} disabled={savingDiagnosis}>
                  {savingDiagnosis ? "Saving…" : "Save diagnosis"}
                </Button>
              </div>
            </Panel>
          )}

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
                    className="rounded-sm p-2.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
              {pricingStatus.priced ? (
                <span className="text-right">
                  <span className="num block text-lg font-extrabold text-foreground">
                    {money(pricingStatus.amount, tenant.currency)}
                  </span>
                  {pricingStatus.hasDeferredPortion && (
                    <span className="block text-xs font-medium text-muted-foreground">
                      + pricing pending for part of this request
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-sm font-semibold text-muted-foreground">{pricingStatus.label}</span>
              )}
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
            <button
              onClick={() => void handleDeleteLead()}
              className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete this lead
            </button>
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
              <Button
                variant="outline"
                onClick={() => void sendMessage()}
                disabled={!message.trim() || sending}
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>

            {showTemplatePicker && (
              <div className="mt-3 rounded-sm border border-border-strong bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">
                  It's been more than 24 hours since this customer's last message — send an approved template
                  instead.
                </p>
                <select
                  className="mt-2 h-9 w-full rounded-sm border border-border-strong bg-background px-2 text-sm"
                  value={selectedTemplateId}
                  onChange={(e) => {
                    const tpl = approvedTemplates.find((t) => t.id === e.target.value);
                    setSelectedTemplateId(e.target.value);
                    setTemplateParams(new Array(tpl ? countTemplateVariables(tpl.bodyText) : 0).fill(""));
                  }}
                >
                  {approvedTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {templateParams.map((value, i) => (
                  <Input
                    key={i}
                    className="mt-2"
                    value={value}
                    onChange={(e) =>
                      setTemplateParams((params) => params.map((p, pi) => (pi === i ? e.target.value : p)))
                    }
                    placeholder={`Value for {{${i + 1}}}`}
                  />
                ))}
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    onClick={() => void sendTemplate()}
                    disabled={sending || templateParams.some((p) => !p.trim())}
                  >
                    {sending ? "Sending…" : "Send template"}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setShowTemplatePicker(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
