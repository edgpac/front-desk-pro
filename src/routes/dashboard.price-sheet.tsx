import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PRICE_SHEET, type PriceRow } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/price-sheet")({
  component: PriceSheetPage,
});

function PriceSheetPage() {
  const [rows, setRows] = useState<PriceRow[]>(PRICE_SHEET);
  const fileRef = useRef<HTMLInputElement>(null);

  function removeRow(id: string) {
    setRows((r) => r.filter((row) => row.id !== id));
  }

  function addRow() {
    setRows((r) => [
      ...r,
      { id: `p-${Date.now()}`, service: "New service", category: "General", pricing: "Flat", price: "$0" },
    ]);
  }

  function updateRow(id: string, patch: Partial<PriceRow>) {
    setRows((r) => r.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    toast.info("Photo received — automatic extraction into rows isn't wired up yet, add them below for now.");
    e.target.value = "";
  }

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader
        eyebrow="Price sheet"
        title="What FrontDesk quotes off of"
        description="These are the numbers the AI uses to price a job. Edit anything, or add a row for a service it doesn't know about yet."
        actions={
          <>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} />
            <Button variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload className="mr-2 h-4 w-4" /> Upload a price sheet photo
            </Button>
          </>
        }
      />

      <Panel>
        <ul className="-m-4 divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Input
                value={row.service}
                onChange={(e) => updateRow(row.id, { service: e.target.value })}
                className="min-w-[220px] flex-1"
                aria-label="Service"
              />
              <Input
                value={row.category}
                onChange={(e) => updateRow(row.id, { category: e.target.value })}
                className="w-36"
                aria-label="Category"
              />
              <Input
                value={row.price}
                onChange={(e) => updateRow(row.id, { price: e.target.value })}
                className="w-32"
                aria-label="Price"
              />
              <button
                onClick={() => removeRow(row.id)}
                className="ml-auto rounded-sm p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label={`Remove ${row.service}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3 border-t border-border-strong pt-3">
          <Button variant="outline" size="sm" onClick={addRow}>
            <Plus className="mr-2 h-4 w-4" /> Add service
          </Button>
        </div>
      </Panel>
    </div>
  );
}
