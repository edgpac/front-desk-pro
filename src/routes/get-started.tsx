import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { toast } from "sonner";

import { Wordmark } from "@/components/brand/Wordmark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/use-auth";
import { getMyTenant, updateMyTenant, normalizeWhatsappNumber, isPlausiblePhoneNumber } from "@/lib/tenant-server";
import type { Tenant } from "@/lib/mock-data";

export const Route = createFileRoute("/get-started")({
  ssr: false,
  head: () => ({
    meta: [{ title: "Get your first quote ready — Job It Ready" }],
  }),
  component: GetStarted,
});

// The one screen between "just signed up" and an empty dashboard. Skipping
// straight to the dashboard leaves a new business with no idea that
// whatsapp_number/labor_rate/service_call_fee (all real, all wired end to
// end — see ROADMAP.md) need setting before the WhatsApp quoting flow does
// anything useful. Only ever reached from signup.tsx's post-signup redirect
// — logging in later always goes straight to /dashboard — so there's no
// "already seen this" state to track.
function GetStarted() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [laborRate, setLaborRate] = useState(125);
  const [serviceCallFee, setServiceCallFee] = useState(89);
  const [whatsappNumber, setWhatsappNumber] = useState("");

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      navigate({ to: "/login" });
      return;
    }
    let active = true;
    getMyTenant()
      .then((t) => {
        if (!active) return;
        setTenant(t);
        setLaborRate(t.laborRate);
        setServiceCallFee(t.serviceCallFee);
        setWhatsappNumber(t.whatsappNumber);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load your account.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user, navigate]);

  const normalizedWhatsapp = normalizeWhatsappNumber(whatsappNumber);
  const whatsappIsValid = !normalizedWhatsapp || isPlausiblePhoneNumber(normalizedWhatsapp);
  const ratesAreValid = Number.isFinite(laborRate) && laborRate >= 0 && Number.isFinite(serviceCallFee) && serviceCallFee >= 0;
  const canSave = ratesAreValid && whatsappIsValid && !saving;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!tenant || !canSave) return;
    setSaving(true);
    try {
      // updateMyTenant replaces the whole row, so patch onto everything the
      // trigger already set (see dashboard.settings.business.tsx — same
      // load-then-submit-the-whole-object shape) rather than clobbering
      // fields this screen never shows.
      await updateMyTenant({
        data: {
          name: tenant.name,
          trade: tenant.trade,
          phone: tenant.phone,
          email: tenant.email,
          address: tenant.address,
          area: tenant.area,
          hours: tenant.hours,
          currency: tenant.currency,
          taxRate: tenant.taxRate,
          calendarLink: tenant.calendarLink,
          paymentTerms: tenant.paymentTerms,
          warrantyTerms: tenant.warrantyTerms,
          laborRate,
          serviceCallFee,
          whatsappNumber,
        },
      });
      setDone(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save your setup.");
    } finally {
      setSaving(false);
    }
  }

  if (authLoading || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-5 py-12">
      <div className="w-full max-w-md">
        <Wordmark />

        {done ? (
          <div className="mt-8 rounded-md border border-border-strong bg-background p-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/15">
              <Check className="h-5 w-5 text-success" />
            </div>
            <h1 className="mt-4 text-2xl">You're ready.</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {normalizedWhatsapp
                ? "We'll reach out to get that WhatsApp number connected — self-serve setup isn't live yet, so this is a manual step on our end for now."
                : "Your pricing is set. You can request a WhatsApp number any time from Settings when you're ready."}
            </p>
            <Button className="mt-6 w-full" size="lg" onClick={() => navigate({ to: "/dashboard" })}>
              Go to dashboard
            </Button>
          </div>
        ) : (
          <div className="mt-8 rounded-md border border-border-strong bg-background p-6">
            <h1 className="text-2xl">Get your first quote ready</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Set your pricing and connect WhatsApp so a customer's photo turns into a real quote.
            </p>

            <form className="mt-6 space-y-4" onSubmit={handleSave}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="laborRate">Labor rate ($/hr)</Label>
                  <Input
                    id="laborRate"
                    type="number"
                    min={0}
                    step="0.01"
                    className="mt-1.5"
                    value={Number.isNaN(laborRate) ? "" : laborRate}
                    onChange={(e) => setLaborRate(e.target.valueAsNumber)}
                  />
                </div>
                <div>
                  <Label htmlFor="serviceCallFee">Service call fee ($)</Label>
                  <Input
                    id="serviceCallFee"
                    type="number"
                    min={0}
                    step="0.01"
                    className="mt-1.5"
                    value={Number.isNaN(serviceCallFee) ? "" : serviceCallFee}
                    onChange={(e) => setServiceCallFee(e.target.valueAsNumber)}
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="whatsappNumber">Business WhatsApp number</Label>
                <Input
                  id="whatsappNumber"
                  type="tel"
                  className="mt-1.5"
                  placeholder="+1 (512) 555-0110"
                  value={whatsappNumber}
                  onChange={(e) => setWhatsappNumber(e.target.value)}
                />
                {!whatsappIsValid ? (
                  <span className="mt-1.5 block text-xs text-destructive">
                    That doesn't look like a real phone number — check the digits, or leave it blank.
                  </span>
                ) : (
                  <span className="mt-1.5 block text-xs text-muted-foreground">
                    We're still building self-serve WhatsApp connection — save the number you want and
                    we'll reach out to connect it. Leave blank if you're not ready yet.
                  </span>
                )}
              </div>

              <Button type="submit" size="lg" className="w-full" disabled={!canSave}>
                {saving ? "Saving…" : "Save & continue"}
              </Button>
              <button
                type="button"
                className="block w-full text-center text-sm text-muted-foreground hover:text-foreground"
                onClick={() => navigate({ to: "/dashboard" })}
              >
                Skip for now
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
