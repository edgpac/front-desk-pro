import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/use-auth";
import { getMyTenant, updateMyTenant, normalizeWhatsappNumber, isPlausiblePhoneNumber } from "@/lib/tenant-server";
import { TENANT, type Tenant } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/settings/business")({
  component: BusinessSettings,
});

const CURRENCIES: Tenant["currency"][] = ["USD", "MXN", "CAD"];

const REQUIRED_FIELDS: (keyof Tenant)[] = [
  "name",
  "trade",
  "phone",
  "email",
  "address",
  "area",
  "hours",
  "calendarLink",
  "paymentTerms",
  "warrantyTerms",
];

function BusinessSettings() {
  const { user, loading: authLoading } = useAuth();
  const [form, setForm] = useState<Tenant>({ ...TENANT });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setForm({ ...TENANT });
      setLoading(false);
      return;
    }
    let active = true;
    getMyTenant()
      .then((tenant) => {
        if (active) setForm(tenant);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load business settings.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  function set<K extends keyof Tenant>(key: K, value: Tenant[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const missing = REQUIRED_FIELDS.filter((key) => !String(form[key] ?? "").trim());
  const taxIsValid = form.taxRate !== null && form.taxRate !== undefined && !Number.isNaN(form.taxRate);
  const ratesAreValid =
    Number.isFinite(form.laborRate) && form.laborRate >= 0 && Number.isFinite(form.serviceCallFee) && form.serviceCallFee >= 0;
  const normalizedWhatsapp = normalizeWhatsappNumber(form.whatsappNumber);
  const whatsappIsValid = !normalizedWhatsapp || isPlausiblePhoneNumber(normalizedWhatsapp);
  const whatsappConnected = Boolean(normalizedWhatsapp) && whatsappIsValid;
  const canSave = missing.length === 0 && taxIsValid && ratesAreValid && whatsappIsValid && !saving;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (missing.length > 0 || !taxIsValid || !ratesAreValid || !whatsappIsValid) return;
    if (!user) {
      toast.success("Saved (sample data — sign up to save your real business info)");
      return;
    }
    setSaving(true);
    try {
      await updateMyTenant({
        data: {
          name: form.name,
          trade: form.trade,
          phone: form.phone,
          email: form.email,
          address: form.address,
          area: form.area,
          hours: form.hours,
          currency: form.currency,
          taxRate: form.taxRate,
          calendarLink: form.calendarLink,
          paymentTerms: form.paymentTerms,
          warrantyTerms: form.warrantyTerms,
          laborRate: form.laborRate,
          serviceCallFee: form.serviceCallFee,
          whatsappNumber: form.whatsappNumber,
        },
      });
      toast.success("Saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save business settings.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 p-6 lg:p-10">
        <PageHeader eyebrow="Settings" title="Business info" description="Loading…" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader
        eyebrow="Settings"
        title="Business info"
        description={
          user
            ? "Everything here appears on your proposals, invoices, and receipts — all fields are required before you can save."
            : "You're viewing sample data — sign up to save your own business info here."
        }
      />

      <Panel>
        <form className="grid gap-5 sm:grid-cols-2" onSubmit={handleSave}>
          <Field label="Business name" required>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} required />
          </Field>
          <Field label="Trade" required>
            <Input value={form.trade} onChange={(e) => set("trade", e.target.value)} required />
          </Field>

          <Field label="Phone" required>
            <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} required />
          </Field>
          <Field label="Email" required>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              required
            />
          </Field>

          <Field label="Business address" required className="sm:col-span-2">
            <Input value={form.address} onChange={(e) => set("address", e.target.value)} required />
          </Field>

          <Field label="Service area" required>
            <Input value={form.area} onChange={(e) => set("area", e.target.value)} required />
          </Field>
          <Field label="Business hours" required>
            <Input
              value={form.hours}
              onChange={(e) => set("hours", e.target.value)}
              placeholder="Mon–Sat 8AM–6PM"
              required
            />
          </Field>

          <Field label="Currency" required>
            <select
              value={form.currency}
              onChange={(e) => set("currency", e.target.value as Tenant["currency"])}
              className="mt-1.5 h-10 w-full rounded-sm border border-border-strong bg-background px-3 text-sm"
              required
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sales tax rate (%)" required>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={Number.isNaN(form.taxRate) ? "" : form.taxRate}
              onChange={(e) => set("taxRate", e.target.valueAsNumber)}
              placeholder="0 if you don't charge tax"
              required
            />
          </Field>

          <Field label="Calendar link" required className="sm:col-span-2">
            <Input
              value={form.calendarLink}
              onChange={(e) => set("calendarLink", e.target.value)}
              placeholder="https://cal.com/your-business/service-call"
              required
            />
            <span className="mt-1.5 block text-xs text-muted-foreground">
              Your existing Cal.com or Calendly link — bookings open here pre-filled with the job details.
            </span>
          </Field>

          <Field label="Payment terms" required className="sm:col-span-2">
            <Textarea
              rows={2}
              value={form.paymentTerms}
              onChange={(e) => set("paymentTerms", e.target.value)}
              placeholder="e.g. 50% deposit at start, 50% due on completion."
              required
            />
          </Field>
          <Field label="Warranty terms" required className="sm:col-span-2">
            <Textarea
              rows={2}
              value={form.warrantyTerms}
              onChange={(e) => set("warrantyTerms", e.target.value)}
              placeholder="e.g. 30-day warranty on all workmanship."
              required
            />
          </Field>

          <Field label="Labor rate ($/hr)">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={Number.isNaN(form.laborRate) ? "" : form.laborRate}
              onChange={(e) => set("laborRate", e.target.valueAsNumber)}
            />
            <span className="mt-1.5 block text-xs text-muted-foreground">
              What the AI quotes labor at when it prices a job.
            </span>
          </Field>
          <Field label="Service call fee ($)">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={Number.isNaN(form.serviceCallFee) ? "" : form.serviceCallFee}
              onChange={(e) => set("serviceCallFee", e.target.valueAsNumber)}
            />
            <span className="mt-1.5 block text-xs text-muted-foreground">
              Added to every quote as the base call-out charge.
            </span>
          </Field>

          <Field label="WhatsApp number" className="sm:col-span-2">
            <div className="flex items-center gap-2">
              <Input
                type="tel"
                value={form.whatsappNumber}
                onChange={(e) => set("whatsappNumber", e.target.value)}
                placeholder="(512) 555-0110"
                className="flex-1"
              />
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                  whatsappConnected
                    ? "bg-green-100 text-green-800"
                    : !whatsappIsValid
                      ? "bg-destructive/10 text-destructive"
                      : "bg-amber-100 text-amber-800"
                }`}
              >
                {whatsappConnected ? "Connected" : !whatsappIsValid ? "Invalid" : "Not connected"}
              </span>
            </div>
            {!whatsappIsValid ? (
              <span className="mt-1.5 block text-xs text-destructive">
                That doesn't look like a real phone number — check the digits.
              </span>
            ) : (
              <span className="mt-1.5 block text-xs text-muted-foreground">
                The number customers text for a quote. Requires WhatsApp set up on your account —
                leave blank until then.
              </span>
            )}
          </Field>

          <div className="sm:col-span-2">
            <Button type="submit" disabled={!canSave}>
              {saving ? "Saving…" : "Save"}
            </Button>
            {missing.length > 0 || !taxIsValid || !ratesAreValid || !whatsappIsValid ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {missing.length > 0
                  ? `${missing.length} field${missing.length === 1 ? "" : "s"} still need${missing.length === 1 ? "s" : ""} to be filled in.`
                  : !taxIsValid
                    ? "Enter a valid tax rate (0 is fine) to continue."
                    : !ratesAreValid
                      ? "Enter a valid labor rate and service call fee (0 or more) to continue."
                      : "Fix the WhatsApp number to continue."}
              </p>
            ) : null}
          </div>
        </form>
      </Panel>
    </div>
  );
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block text-sm ${className ?? ""}`}>
      <span className="label-caps text-muted-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
