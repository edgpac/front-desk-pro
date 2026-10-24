import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Download, Plus, RotateCcw, Settings, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/use-auth";
import { getMyTenant, updateMyGreetingSettings, MAX_CUSTOM_GREETING_LENGTH } from "@/lib/tenant-server";
import { isSupportedImageFile, UNSUPPORTED_IMAGE_MESSAGE } from "@/lib/image-client";
import {
  listMyPriceSheet,
  saveMyPriceSheet,
  extractPriceSheetFromImage,
  extractPriceSheetFromUrl,
  type ExtractedPriceSheetItem,
} from "@/lib/price-sheet-server";
import {
  formatPrice,
  PRICE_SHEET,
  type PriceSheetRow,
  type PricingType,
  type MaterialsPolicy,
} from "@/lib/mock-data";
import { downloadPriceSheetBackup, parsePriceSheetBackup } from "@/lib/price-sheet-backup";

export const Route = createFileRoute("/dashboard/price-sheet")({
  component: PriceSheetPage,
});

const PRICING_TYPES: PricingType[] = ["flat", "hourly", "range"];

const MATERIALS_POLICIES: { value: MaterialsPolicy; label: string }[] = [
  { value: "included", label: "Materials included in price" },
  { value: "customer_pays_receipt", label: "Customer pays receipt cost" },
  { value: "confirmed_after_inspection", label: "Priced after inspection" },
];

function fileToBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Could not read that file."));
        return;
      }
      const base64 = result.split(",")[1] ?? "";
      resolve({ base64, mediaType: file.type || "image/jpeg" });
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

// Display-only preview of the recommended greeting, for this UI only — the
// actual outbound text is always resolved server-side by
// resolveFirstContactGreeting in whatsapp-conversation-server.ts, which this
// deliberately does NOT import (a server-only module; importing it here
// would break TanStack Start's client/server import boundary, same reason
// price-sheet-server.ts duplicates its own small signature-only check
// rather than importing estimate-server.ts's). Keep these two templates in
// sync by hand if the recommended wording ever changes.
const RECOMMENDED_GREETING_PREVIEW: Record<"en" | "es", string> = {
  en: "Hi! 👋 Thanks for reaching out to {business_name}. How can I help you today?",
  es: "¡Hola! 👋 Gracias por contactar a {business_name}. ¿En qué podemos ayudarte?",
};

function greetingPreview(language: "en" | "es", businessName: string): string {
  const name = businessName.trim() || (language === "es" ? "nuestro equipo" : "our team");
  return RECOMMENDED_GREETING_PREVIEW[language].replaceAll("{business_name}", name);
}

function newRow(): PriceSheetRow {
  return {
    id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    task: "New service",
    category: "General",
    keywords: [],
    pricingType: "flat",
    priceMin: 0,
    priceMax: 0,
    hours: 0,
    bundleable: false,
    materialsPolicy: "included",
    diagnosisFee: null,
    aiNotes: null,
  };
}

function PriceSheetPage() {
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<PriceSheetRow[]>(PRICE_SHEET);
  const [currency, setCurrency] = useState("USD");
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [importingUrl, setImportingUrl] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  // Row ids whose "note for the AI" field has been expanded this session —
  // purely a UI collapse state, not persisted; a row with an existing note
  // is always shown expanded regardless of this set (see the render below).
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const restoreFileRef = useRef<HTMLInputElement>(null);

  // AI Greeting — deliberately its own state and its own save action,
  // separate from rows/dirty/saveAll above: this isn't a price-sheet item,
  // it's a tenant-level setting (see updateMyGreetingSettings), so saving
  // it must never touch, resend, or risk clobbering the price sheet or
  // vice versa.
  const [businessName, setBusinessName] = useState("");
  const [greetingMode, setGreetingMode] = useState<"recommended" | "custom">("recommended");
  const [customGreetingEn, setCustomGreetingEn] = useState("");
  const [customGreetingEs, setCustomGreetingEs] = useState("");
  const [greetingDirty, setGreetingDirty] = useState(false);
  const [greetingSaving, setGreetingSaving] = useState(false);

  function applyExtractedItems(extracted: ExtractedPriceSheetItem[], source: string) {
    if (extracted.length === 0) {
      toast.error(`Couldn't find any prices ${source} — try a clearer source.`);
      return;
    }
    setRows((r) => [
      ...r,
      ...extracted.map((item) => ({
        ...item,
        id: `extracted-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      })),
    ]);
    setDirty(true);
    toast.success(
      `Added ${extracted.length} service${extracted.length === 1 ? "" : "s"} ${source} — review below, then Save changes.`,
    );
  }

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setRows(PRICE_SHEET);
      setLoading(false);
      return;
    }
    let active = true;
    listMyPriceSheet()
      .then((items) => {
        if (active) setRows(items);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load price sheet.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    getMyTenant()
      .then((tenant) => {
        if (!active) return;
        setCurrency(tenant.currency);
        setBusinessName(tenant.name);
        setGreetingMode(tenant.greetingMode);
        setCustomGreetingEn(tenant.customGreetingEn ?? "");
        setCustomGreetingEs(tenant.customGreetingEs ?? "");
      })
      .catch(() => {
        // Non-fatal — the page still works with the USD default and the
        // recommended greeting if this fails for some reason; the price
        // sheet load above is what gates the loading state. A failed load
        // here falls back to the safe "recommended" default rather than
        // ever showing blank/broken greeting fields.
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  function removeRow(id: string) {
    setRows((r) => r.filter((row) => row.id !== id));
    setDirty(true);
  }

  function addRow() {
    setRows((r) => [...r, newRow()]);
    setDirty(true);
  }

  function updateRow(id: string, patch: Partial<PriceSheetRow>) {
    setRows((r) => r.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setDirty(true);
  }

  async function saveAll() {
    if (!user) {
      toast.success("Saved (sample data — sign up to save your real price sheet)");
      setDirty(false);
      return;
    }
    setSaving(true);
    try {
      await saveMyPriceSheet({
        data: {
          items: rows.map((row) => ({
            task: row.task,
            category: row.category,
            keywords: row.keywords,
            pricingType: row.pricingType,
            priceMin: row.priceMin,
            priceMax: row.priceMax,
            hours: row.hours,
            bundleable: row.bundleable,
            materialsPolicy: row.materialsPolicy,
            diagnosisFee: row.diagnosisFee,
            aiNotes: row.aiNotes,
          })),
        },
      });
      const fresh = await listMyPriceSheet();
      setRows(fresh);
      setDirty(false);
      toast.success("Price sheet saved — the AI will price off these numbers from now on.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save price sheet.");
    } finally {
      setSaving(false);
    }
  }

  async function saveGreeting() {
    if (!user) {
      toast.success("Saved (sample data — sign up to save your real greeting)");
      setGreetingDirty(false);
      return;
    }
    setGreetingSaving(true);
    try {
      await updateMyGreetingSettings({
        data: { greetingMode, customGreetingEn, customGreetingEs },
      });
      // Left as the user typed it locally — not reset to whatever the
      // server echoed back, same reasoning as every other save here:
      // the trim/null-if-empty normalization happens server-side, but
      // re-fetching and overwriting local state isn't needed just to
      // confirm a successful save, and failing to re-fetch can never
      // silently discard what's on screen.
      setGreetingDirty(false);
      toast.success("Greeting saved — the WhatsApp assistant will use it on new conversations.");
    } catch (err) {
      // Dirty state and the typed text are both left exactly as they
      // were — a failed save must never look like a successful one, and
      // must never silently discard what the owner typed.
      toast.error(err instanceof Error ? err.message : "Could not save greeting settings.");
    } finally {
      setGreetingSaving(false);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!user) {
      toast.info("Sign up to upload your own price sheet.");
      return;
    }
    if (!(await isSupportedImageFile(file))) {
      toast.error(UNSUPPORTED_IMAGE_MESSAGE);
      return;
    }
    setExtracting(true);
    try {
      const { base64, mediaType } = await fileToBase64(file);
      const extracted = await extractPriceSheetFromImage({ data: { imageBase64: base64, imageMediaType: mediaType } });
      applyExtractedItems(extracted, "from the photo");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read that photo.");
    } finally {
      setExtracting(false);
    }
  }

  async function handleRestoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!user) {
      toast.info("Sign up to restore your own price sheet.");
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      toast.error("Could not read that file.");
      return;
    }
    const result = parsePriceSheetBackup(text);
    if (!result.ok) {
      toast.error(result.reason);
      return;
    }
    const { items } = result;
    if (items.length === 0) {
      toast.error("That backup file has no services in it.");
      return;
    }
    // Explicit confirmation before discarding whatever's currently in the
    // editor (including any unsaved edits) — restoring REPLACES the table,
    // unlike the AI-import buttons above, which only ever append. Nothing
    // is written to the database by this step either way; the existing
    // "Save changes" button below is still the only thing that persists it,
    // so this is a deliberate two-step confirmation, not a one-click undo.
    const confirmed = window.confirm(
      `Restore ${items.length} service${items.length === 1 ? "" : "s"} from this backup? This replaces everything currently shown below${dirty ? " — including your unsaved changes" : ""}. Nothing is saved until you click "Save changes" afterward.`,
    );
    if (!confirmed) return;
    setRows(
      items.map((item) => ({
        ...item,
        id: `restored-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      })),
    );
    setDirty(true);
    toast.success(`Restored ${items.length} service${items.length === 1 ? "" : "s"} — review below, then Save changes.`);
  }

  async function handleImportFromUrl() {
    const url = urlValue.trim();
    if (!url) return;
    if (!user) {
      toast.info("Sign up to import your own price sheet.");
      return;
    }
    setImportingUrl(true);
    try {
      const extracted = await extractPriceSheetFromUrl({ data: { url } });
      applyExtractedItems(extracted, "from that page");
      setUrlValue("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't import from that page.");
    } finally {
      setImportingUrl(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 p-6 lg:p-10">
        <PageHeader eyebrow="Price sheet" title="What Job It Ready quotes off of" description="Loading…" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader
        eyebrow="Price sheet"
        title="What Job It Ready quotes off of"
        description={
          user
            ? "These are the exact numbers the AI prices jobs from — no separate copy to keep in sync. Paired with your Business Settings (what you're certified for, equipped for, and won't take on), Job It Ready can quote confidently when a job matches, and knows to check with you first when it doesn't."
            : "You're viewing a sample price sheet — sign up to build your own."
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/dashboard/settings/qualifications">
                <Settings className="mr-2 h-4 w-4" /> Business Settings
              </Link>
            </Button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={extracting}>
              <Upload className="mr-2 h-4 w-4" /> {extracting ? "Reading photo…" : "Upload a price sheet photo"}
            </Button>
          </>
        }
      />

      <div className="border border-warn/50 bg-warn/10 px-4 py-3 text-sm text-foreground">
        <strong className="font-semibold">If you leave out a service, you're leaving money on the table.</strong>{" "}
        Your price sheet is the middleman between your customers and your business — the AI only ever quotes what's
        listed here. Anything missing gets passed to you as a manual request instead of an instant price, so the
        more complete this is, the fewer leads you have to price by hand.
      </div>

      {user && (
        <Panel title="Backup">
          <p className="text-xs text-muted-foreground">
            Download an exact copy of your price sheet — every field, including bundling, materials policy,
            diagnosis fees, and AI notes (the photo and web-page import options above only ever recover the
            basic task/price/hours, never those). Keep the file somewhere safe; restoring loads it back into
            the table below for you to review, same as the AI-import options — nothing is saved until you
            click "Save changes".
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadPriceSheetBackup(rows)}>
              <Download className="mr-2 h-4 w-4" /> Download backup
            </Button>
            <input
              ref={restoreFileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => void handleRestoreFile(e)}
            />
            <Button variant="outline" size="sm" onClick={() => restoreFileRef.current?.click()}>
              <RotateCcw className="mr-2 h-4 w-4" /> Restore from backup
            </Button>
          </div>
        </Panel>
      )}

      <Panel title="Import from a web page">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="url"
            placeholder="https://yourbusiness.com/pricing"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            className="max-w-md"
            disabled={importingUrl}
          />
          <Button variant="outline" onClick={() => void handleImportFromUrl()} disabled={importingUrl || !urlValue.trim()}>
            {importingUrl ? "Reading page…" : "Import"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Works well for Wix, Squarespace, WordPress, and plain HTML sites. Won't find anything on a page
          that needs JavaScript to show its content (some custom-built sites) — use the photo upload above
          for those instead.
        </p>
      </Panel>

      <Panel
        title="AI Greeting"
        aside={
          <Button size="sm" onClick={() => void saveGreeting()} disabled={!greetingDirty || greetingSaving}>
            {greetingSaving ? "Saving…" : "Save greeting"}
          </Button>
        }
      >
        <p className="text-xs text-muted-foreground">
          This is what the WhatsApp assistant says first, on a new conversation — never repeated on
          follow-up messages in the same conversation.
        </p>
        <RadioGroup
          className="mt-3 gap-3"
          value={greetingMode}
          onValueChange={(value) => {
            setGreetingMode(value as "recommended" | "custom");
            setGreetingDirty(true);
          }}
        >
          <div className="flex items-start gap-2">
            <RadioGroupItem value="recommended" id="greeting-recommended" className="mt-0.5" />
            <div>
              <Label htmlFor="greeting-recommended" className="font-medium">
                Use recommended greeting
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {greetingPreview("en", businessName)}
                <br />
                {greetingPreview("es", businessName)}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem value="custom" id="greeting-custom" className="mt-0.5" />
            <Label htmlFor="greeting-custom" className="font-medium">
              Use custom greeting
            </Label>
          </div>
        </RadioGroup>

        {greetingMode === "custom" && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="greeting-en" className="text-xs font-medium text-muted-foreground">
                English{" "}
                <span className="font-normal">
                  ({customGreetingEn.length}/{MAX_CUSTOM_GREETING_LENGTH})
                </span>
              </Label>
              <Textarea
                id="greeting-en"
                className="mt-1"
                rows={3}
                placeholder={greetingPreview("en", businessName)}
                value={customGreetingEn}
                onChange={(e) => {
                  setCustomGreetingEn(e.target.value);
                  setGreetingDirty(true);
                }}
              />
              {customGreetingEn.length > MAX_CUSTOM_GREETING_LENGTH && (
                <p className="mt-1 text-xs text-destructive">Too long — trim before saving.</p>
              )}
            </div>
            <div>
              <Label htmlFor="greeting-es" className="text-xs font-medium text-muted-foreground">
                Spanish{" "}
                <span className="font-normal">
                  ({customGreetingEs.length}/{MAX_CUSTOM_GREETING_LENGTH})
                </span>
              </Label>
              <Textarea
                id="greeting-es"
                className="mt-1"
                rows={3}
                placeholder={greetingPreview("es", businessName)}
                value={customGreetingEs}
                onChange={(e) => {
                  setCustomGreetingEs(e.target.value);
                  setGreetingDirty(true);
                }}
              />
              {customGreetingEs.length > MAX_CUSTOM_GREETING_LENGTH && (
                <p className="mt-1 text-xs text-destructive">Too long — trim before saving.</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Leave a language blank to use the recommended greeting for that language instead. Use{" "}
              <code className="rounded-sm bg-muted px-1 py-0.5">{"{business_name}"}</code> anywhere you want
              your business name inserted automatically.
            </p>
          </div>
        )}
      </Panel>

      <Panel>
        <ul className="-m-4 divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  value={row.task}
                  onChange={(e) => updateRow(row.id, { task: e.target.value })}
                  className="min-w-[220px] flex-1"
                  aria-label="Service"
                />
                <Input
                  value={row.category}
                  onChange={(e) => updateRow(row.id, { category: e.target.value })}
                  className="w-36"
                  aria-label="Category"
                />
                <select
                  value={row.pricingType}
                  onChange={(e) => {
                    const pricingType = e.target.value as PricingType;
                    // Leaving "range": clear the stale priceMax back to
                    // priceMin rather than leaving it sitting unused in the
                    // data — formatPrice() already ignores it once the type
                    // isn't "range", but keeping the underlying row clean
                    // avoids it resurfacing if the type gets flipped back.
                    updateRow(row.id, pricingType === "range" ? { pricingType } : { pricingType, priceMax: row.priceMin });
                  }}
                  className="h-10 rounded-sm border border-border-strong bg-background px-2 text-sm"
                  aria-label="Pricing type"
                >
                  {PRICING_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t === "flat" ? "Flat" : t === "hourly" ? "Hourly" : "Range"}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    type="number"
                    value={row.priceMin}
                    onChange={(e) => updateRow(row.id, { priceMin: e.target.valueAsNumber || 0 })}
                    className="w-24 text-right"
                    aria-label="Minimum price"
                  />
                </div>
                {row.pricingType === "range" && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm text-muted-foreground">–$</span>
                    <Input
                      type="number"
                      value={row.priceMax}
                      onChange={(e) => updateRow(row.id, { priceMax: e.target.valueAsNumber || 0 })}
                      className="w-24 text-right"
                      aria-label="Maximum price"
                    />
                  </div>
                )}
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    step="0.5"
                    min="0"
                    value={row.hours}
                    onChange={(e) => updateRow(row.id, { hours: e.target.valueAsNumber || 0 })}
                    className="w-20 text-right"
                    aria-label="Typical hours"
                  />
                  <span className="text-sm text-muted-foreground">hrs</span>
                </div>
                <span className="ml-auto num text-sm font-semibold text-foreground">{formatPrice(row, currency)}</span>
                <button
                  onClick={() => removeRow(row.id)}
                  className="rounded-sm p-2.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Remove ${row.task}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <Input
                value={row.keywords.join(", ")}
                onChange={(e) =>
                  updateRow(row.id, {
                    keywords: e.target.value
                      .split(",")
                      .map((k) => k.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="Keywords the AI matches against a customer's description (comma-separated)"
                className="text-xs"
                aria-label={`Keywords for ${row.task}`}
              />
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={row.bundleable}
                    onChange={(e) => updateRow(row.id, { bundleable: e.target.checked })}
                    className="h-3.5 w-3.5"
                  />
                  Bundle multiple of these into one visit charge
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Materials/parts:
                  <select
                    value={row.materialsPolicy}
                    onChange={(e) =>
                      updateRow(row.id, { materialsPolicy: e.target.value as MaterialsPolicy })
                    }
                    className="h-8 rounded-sm border border-border-strong bg-background px-2 text-xs"
                    aria-label={`Materials policy for ${row.task}`}
                  >
                    {MATERIALS_POLICIES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={row.diagnosisFee != null}
                    onChange={(e) =>
                      updateRow(row.id, {
                        diagnosisFee: e.target.checked ? { pricingType: "flat", amount: 0 } : null,
                      })
                    }
                    className="h-3.5 w-3.5"
                  />
                  Charge a separate diagnosis fee for this service (instead of the general service call fee)
                </label>
                {row.diagnosisFee && (
                  <>
                    <select
                      value={row.diagnosisFee.pricingType}
                      onChange={(e) =>
                        updateRow(row.id, {
                          diagnosisFee: { ...row.diagnosisFee!, pricingType: e.target.value as "flat" | "hourly" },
                        })
                      }
                      className="h-8 rounded-sm border border-border-strong bg-background px-2 text-xs"
                      aria-label={`Diagnosis fee pricing type for ${row.task}`}
                    >
                      <option value="flat">Flat</option>
                      <option value="hourly">Hourly</option>
                    </select>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">$</span>
                      <Input
                        type="number"
                        value={row.diagnosisFee.amount}
                        onChange={(e) =>
                          updateRow(row.id, {
                            diagnosisFee: { ...row.diagnosisFee!, amount: e.target.valueAsNumber || 0 },
                          })
                        }
                        className="h-8 w-20 text-right text-xs"
                        aria-label={`Diagnosis fee amount for ${row.task}`}
                      />
                      {row.diagnosisFee.pricingType === "hourly" && (
                        <span className="text-xs text-muted-foreground">/hr</span>
                      )}
                    </div>
                  </>
                )}
              </div>
              {row.aiNotes !== null || expandedNotes.has(row.id) ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={row.aiNotes ?? ""}
                    onChange={(e) => updateRow(row.id, { aiNotes: e.target.value || null })}
                    placeholder="e.g. Always needs an in-person look before quoting — don't estimate from a photo alone"
                    className="text-xs"
                    aria-label={`Note for the AI about ${row.task}`}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      updateRow(row.id, { aiNotes: null });
                      setExpandedNotes((s) => {
                        const next = new Set(s);
                        next.delete(row.id);
                        return next;
                      });
                    }}
                    className="shrink-0 text-xs text-muted-foreground hover:text-destructive"
                  >
                    Remove note
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setExpandedNotes((s) => new Set(s).add(row.id))}
                  className="w-fit text-xs text-muted-foreground hover:text-foreground"
                >
                  + Add note for the AI
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center justify-between border-t border-border-strong pt-3">
          <Button variant="outline" size="sm" onClick={addRow}>
            <Plus className="mr-2 h-4 w-4" /> Add service
          </Button>
          <Button size="sm" onClick={saveAll} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
