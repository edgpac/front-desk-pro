import { useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import html2canvas from "html2canvas-pro";
import { ArrowLeft, Download, Printer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { money, TENANT, type Lead } from "@/lib/mock-data";

export type DocumentKind = "proposal" | "invoice" | "receipt";

const PAYMENT_METHODS = ["Cash", "Card", "Check", "Bank transfer"] as const;

const LABEL: Record<DocumentKind, string> = {
  proposal: "Proposal",
  invoice: "Invoice",
  receipt: "Receipt",
};

const PREFIX: Record<DocumentKind, string> = {
  proposal: "P-",
  invoice: "INV-",
  receipt: "R-",
};

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export function BusinessDocument({ kind, lead }: { kind: DocumentKind; lead: Lead }) {
  const [paymentMethod, setPaymentMethod] = useState<(typeof PAYMENT_METHODS)[number]>("Cash");
  const [downloading, setDownloading] = useState(false);
  const documentRef = useRef<HTMLDivElement>(null);

  const subtotal = lead.lineItems.reduce((sum, i) => sum + i.qty * i.rate, 0);
  const tax = kind === "proposal" ? 0 : (subtotal * TENANT.taxRate) / 100;
  const total = subtotal + tax;

  const now = new Date();
  const docNumber = `${PREFIX[kind]}${lead.id.replace("L-", "")}`;
  const fileSlug = `${kind}-${docNumber}-${lead.customer.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  async function downloadPng() {
    if (!documentRef.current) return;
    setDownloading(true);
    try {
      const canvas = await html2canvas(documentRef.current, {
        scale: 3,
        backgroundColor: "#ffffff",
        useCORS: true,
      });
      const link = document.createElement("a");
      link.download = `${fileSlug}.png`;
      link.href = canvas.toDataURL("image/png", 1.0);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error("PNG export failed:", err);
      toast.error("Couldn't generate the PNG — try Print / Save as PDF instead.");
    } finally {
      setDownloading(false);
    }
  }

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
          <div className="flex items-center gap-3">
            {kind === "receipt" && (
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)}
                className="h-10 rounded-sm border border-border-strong bg-background px-3 text-sm"
                aria-label="Payment method"
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    Paid by {m}
                  </option>
                ))}
              </select>
            )}
            <Button variant="outline" onClick={() => void downloadPng()} disabled={downloading}>
              <Download className="mr-2 h-4 w-4" /> {downloading ? "Rendering…" : "Download PNG"}
            </Button>
            <Button onClick={() => window.print()}>
              <Printer className="mr-2 h-4 w-4" /> Print / Save as PDF
            </Button>
          </div>
        </div>

        <div
          ref={documentRef}
          className="border border-border-strong bg-card p-8 print:border-0 print:p-0 sm:p-12"
        >
          <div className="flex items-start justify-between border-b-2 border-ink pb-5">
            <div>
              <p className="font-display text-lg font-extrabold text-foreground">{TENANT.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">{TENANT.trade} services</p>
              <p className="text-sm text-muted-foreground">{TENANT.phone}</p>
              <p className="text-sm text-muted-foreground">{TENANT.email}</p>
              <p className="text-sm text-muted-foreground">{TENANT.address}</p>
            </div>
            <div className="text-right">
              <p className="font-display text-base font-bold text-foreground">#{docNumber}</p>
              <p className="mt-1 text-sm text-muted-foreground">Date: {formatDate(now)}</p>
              {kind === "proposal" && <p className="text-sm text-muted-foreground">Valid for 30 days</p>}
              {kind === "invoice" && (
                <p className="text-sm text-muted-foreground">Due: {formatDate(addDays(now, 15))}</p>
              )}
              {kind === "receipt" && <p className="text-sm text-muted-foreground">Payment received</p>}
            </div>
          </div>

          <h1 className="my-8 text-center font-display text-4xl italic text-foreground">
            {LABEL[kind]}
          </h1>

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
                  <td className="py-3 text-right text-muted-foreground">
                    {money(item.rate, TENANT.currency)}
                  </td>
                  <td className="num py-3 text-right font-semibold text-foreground">
                    {money(item.qty * item.rate, TENANT.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-4 flex justify-end">
            <div className="w-64 space-y-1">
              {tax > 0 && (
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="num">{money(subtotal, TENANT.currency)}</span>
                </div>
              )}
              {tax > 0 && (
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Sales tax ({TENANT.taxRate}%)</span>
                  <span className="num">{money(tax, TENANT.currency)}</span>
                </div>
              )}
              <div className="flex justify-between border-t-2 border-ink pt-3 text-base font-bold text-foreground">
                <span>
                  {kind === "proposal" && "Total estimate"}
                  {kind === "invoice" && "Amount due"}
                  {kind === "receipt" && "Total"}
                </span>
                <span className="num">{money(total, TENANT.currency)}</span>
              </div>
              {kind === "receipt" && (
                <div className="flex justify-between border-t border-border pt-1 text-sm font-semibold text-foreground">
                  <span>Paid ({paymentMethod})</span>
                  <span className="num">{money(total, TENANT.currency)}</span>
                </div>
              )}
            </div>
          </div>

          <div className="mt-8 space-y-4 border-t border-border pt-6 text-sm text-muted-foreground">
            {kind !== "receipt" && (
              <Section title="Diagnosis">
                <p>{lead.diagnosis}</p>
              </Section>
            )}
            {kind !== "receipt" && (
              <Section title="Payment & warranty">
                <p>
                  {TENANT.paymentTerms} {TENANT.warrantyTerms}
                </p>
              </Section>
            )}
            {kind === "receipt" && (
              <Section title="Warranty">
                <p>{TENANT.warrantyTerms}</p>
              </Section>
            )}
            <Section title="Contact">
              <p>
                {TENANT.phone} · {TENANT.email} · {TENANT.hours}
              </p>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="font-semibold text-foreground">{title}</h3>
      <div className="mt-1">{children}</div>
    </div>
  );
}
