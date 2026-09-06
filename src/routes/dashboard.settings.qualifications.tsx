import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/use-auth";
import {
  listMyCapabilities,
  addCapability,
  removeCapability,
  type Capability,
  type CapabilityType,
} from "@/lib/capabilities-server";

export const Route = createFileRoute("/dashboard/settings/qualifications")({
  component: QualificationsPage,
});

// Sample/logged-out preview only — deliberately not shared with
// mock-data.ts or any real tenant's data path. A signed-in business only
// ever sees its own rows from the real tenant_capabilities table.
const SAMPLE_CAPABILITIES: Capability[] = [
  { id: "sample-1", type: "certification", label: "Licensed master plumber", notes: null, active: true },
  { id: "sample-2", type: "specialty", label: "Tankless water heater installs", notes: null, active: true },
  { id: "sample-3", type: "equipment", label: "Drain camera", notes: null, active: true },
  { id: "sample-4", type: "exclusion", label: "Gas line installation", notes: null, active: true },
];

const CERTIFICATION_SUGGESTIONS = [
  "Licensed electrician",
  "Licensed plumber",
  "EPA refrigerant certification",
  "Gas line certified",
  "General contractor license",
];

function normalize(label: string) {
  return label.trim().toLowerCase();
}

function QualificationsPage() {
  const { user, loading: authLoading } = useAuth();
  const [capabilities, setCapabilities] = useState<Capability[]>(SAMPLE_CAPABILITIES);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setCapabilities(SAMPLE_CAPABILITIES);
      setLoading(false);
      return;
    }
    let active = true;
    listMyCapabilities()
      .then((real) => {
        if (active) setCapabilities(real);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load your qualifications.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  async function handleAdd(type: CapabilityType, label: string) {
    if (!label.trim()) return;
    if (!user) {
      toast.info("Sign up to save your own qualifications.");
      return;
    }
    setPending(true);
    try {
      const { id } = await addCapability({ data: { type, label } });
      setCapabilities((c) => [...c, { id, type, label: label.trim(), notes: null, active: true }]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setPending(false);
    }
  }

  async function handleRemove(id: string) {
    if (!user) {
      setCapabilities((c) => c.filter((cap) => cap.id !== id));
      return;
    }
    const previous = capabilities;
    setCapabilities((c) => c.filter((cap) => cap.id !== id));
    try {
      await removeCapability({ data: id });
    } catch (err) {
      setCapabilities(previous);
      toast.error(err instanceof Error ? err.message : "Could not remove that.");
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 p-6 lg:p-10">
        <PageHeader eyebrow="Business Settings" title="Loading…" />
      </div>
    );
  }

  const byType = (type: CapabilityType) => capabilities.filter((c) => c.type === type);

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <Link
        to="/dashboard/price-sheet"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to price sheet
      </Link>

      <PageHeader
        eyebrow="Business Settings"
        title="What can your business do?"
        description={
          user
            ? "This tells FrontDesk what to price with confidence, and what to check with you about first."
            : "You're viewing sample qualifications — sign up to set your own."
        }
      />

      <CapabilitySection
        title="Certifications & Qualifications"
        type="certification"
        items={byType("certification")}
        suggestions={CERTIFICATION_SUGGESTIONS}
        placeholder="e.g. Licensed HVAC technician"
        pending={pending}
        onAdd={handleAdd}
        onRemove={handleRemove}
      />
      <CapabilitySection
        title="Specialties"
        type="specialty"
        items={byType("specialty")}
        placeholder="e.g. Tankless water heater installs"
        pending={pending}
        onAdd={handleAdd}
        onRemove={handleRemove}
      />
      <CapabilitySection
        title="Equipment"
        type="equipment"
        items={byType("equipment")}
        placeholder="e.g. Drain camera"
        pending={pending}
        onAdd={handleAdd}
        onRemove={handleRemove}
      />
      <CapabilitySection
        title="What does your business NOT handle?"
        description="Work you won't take even if you're technically able to — FrontDesk won't quote these."
        type="exclusion"
        items={byType("exclusion")}
        placeholder="e.g. Roofs over 2 stories"
        pending={pending}
        onAdd={handleAdd}
        onRemove={handleRemove}
      />
    </div>
  );
}

function CapabilitySection({
  title,
  description,
  type,
  items,
  suggestions,
  placeholder,
  pending,
  onAdd,
  onRemove,
}: {
  title: string;
  description?: string;
  type: CapabilityType;
  items: Capability[];
  suggestions?: string[];
  placeholder: string;
  pending: boolean;
  onAdd: (type: CapabilityType, label: string) => void;
  onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const existingLabels = new Set(items.map((i) => normalize(i.label)));
  const availableSuggestions = (suggestions ?? []).filter((s) => !existingLabels.has(normalize(s)));

  function submit() {
    if (!draft.trim()) return;
    onAdd(type, draft.trim());
    setDraft("");
  }

  return (
    <Panel title={title}>
      {description && <p className="mb-3 text-xs text-muted-foreground">{description}</p>}

      {items.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-1.5 rounded-full border border-border-strong bg-muted px-3 py-1 text-sm text-foreground"
            >
              {item.label}
              <button
                onClick={() => onRemove(item.id)}
                aria-label={`Remove ${item.label}`}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {availableSuggestions.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {availableSuggestions.map((s) => (
            <button
              key={s}
              onClick={() => onAdd(type, s)}
              disabled={pending}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-strong px-3 py-1 text-xs font-medium text-muted-foreground hover:border-primary hover:text-primary"
            >
              <Plus className="h-3 w-3" /> {s}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          disabled={pending}
        />
        <Button type="button" variant="outline" onClick={submit} disabled={pending || !draft.trim()}>
          Add
        </Button>
      </div>
    </Panel>
  );
}
