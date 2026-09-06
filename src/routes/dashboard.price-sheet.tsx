import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Settings, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/use-auth";
import {
  listMyPriceSheet,
  saveMyPriceSheet,
  extractPriceSheetFromImage,
  extractPriceSheetFromUrl,
  type ExtractedPriceSheetItem,
} from "@/lib/price-sheet-server";
import { formatPrice, PRICE_SHEET, type PriceSheetRow, type PricingType } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/price-sheet")({
  component: PriceSheetPage,
});

const PRICING_TYPES: PricingType[] = ["flat", "hourly", "range"];

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
  };
}

function PriceSheetPage() {
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<PriceSheetRow[]>(PRICE_SHEET);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [importingUrl, setImportingUrl] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!user) {
      toast.info("Sign up to upload your own price sheet.");
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
        <PageHeader eyebrow="Price sheet" title="What FrontDesk quotes off of" description="Loading…" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader
        eyebrow="Price sheet"
        title="What FrontDesk quotes off of"
        description={
          user
            ? "These are the exact numbers the AI prices jobs from — no separate copy to keep in sync. Paired with your Business Settings (what you're certified for, equipped for, and won't take on), FrontDesk can quote confidently when a job matches, and knows to check with you first when it doesn't."
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
                  onChange={(e) => updateRow(row.id, { pricingType: e.target.value as PricingType })}
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
                <span className="ml-auto num text-sm font-semibold text-foreground">{formatPrice(row)}</span>
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
