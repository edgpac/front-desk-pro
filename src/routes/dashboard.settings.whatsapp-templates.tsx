import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/use-auth";
import {
  listMyWhatsAppTemplates,
  createWhatsAppTemplate,
  deleteWhatsAppTemplate,
  countTemplateVariables,
  type WhatsAppTemplate,
  type TemplateCategory,
} from "@/lib/whatsapp-templates-server";

export const Route = createFileRoute("/dashboard/settings/whatsapp-templates")({
  component: WhatsAppTemplatesPage,
});

// Matches what estimate-server.ts's detectLanguage actually distinguishes
// today — not Meta's full ~150-locale list, since the templates a business
// needs here are the same two languages the AI already replies in.
const LANGUAGES: { code: string; label: string }[] = [
  { code: "en_US", label: "English" },
  { code: "es_MX", label: "Spanish" },
];

const CATEGORIES: { value: TemplateCategory; label: string }[] = [
  { value: "UTILITY", label: "Utility (order/quote/account updates — the right fit for re-engaging a stuck lead)" },
  { value: "MARKETING", label: "Marketing (promotions, offers)" },
  { value: "AUTHENTICATION", label: "Authentication (one-time codes)" },
];

const STATUS_STYLE: Record<WhatsAppTemplate["status"], string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-green-100 text-green-800",
  rejected: "bg-destructive/10 text-destructive",
  paused: "bg-muted text-muted-foreground",
};

const EMPTY_FORM = { name: "", category: "UTILITY" as TemplateCategory, language: "en_US", headerText: "", bodyText: "", footerText: "" };

function WhatsAppTemplatesPage() {
  const { user, loading: authLoading } = useAuth();
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setTemplates([]);
      setLoading(false);
      return;
    }
    let active = true;
    listMyWhatsAppTemplates()
      .then((real) => {
        if (active) setTemplates(real);
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load your templates.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!user) {
      toast.info("Sign up and connect WhatsApp via Meta to create real templates.");
      return;
    }
    if (!form.name.trim() || !form.bodyText.trim()) return;
    setSaving(true);
    try {
      const result = await createWhatsAppTemplate({
        data: {
          name: form.name.trim(),
          category: form.category,
          language: form.language,
          bodyText: form.bodyText.trim(),
          ...(form.headerText.trim() ? { headerText: form.headerText.trim() } : {}),
          ...(form.footerText.trim() ? { footerText: form.footerText.trim() } : {}),
        },
      });
      if (result.status === "created") {
        setTemplates((t) => [result.template, ...t]);
        setForm(EMPTY_FORM);
        toast.success("Template submitted to Meta for approval");
      } else {
        toast.error(result.message);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create template.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!user) {
      setTemplates((t) => t.filter((tpl) => tpl.id !== id));
      return;
    }
    const previous = templates;
    setTemplates((t) => t.filter((tpl) => tpl.id !== id));
    try {
      await deleteWhatsAppTemplate({ data: id });
    } catch (err) {
      setTemplates(previous);
      toast.error(err instanceof Error ? err.message : "Could not delete template.");
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 p-6 lg:p-10">
        <PageHeader eyebrow="Settings" title="Loading…" />
      </div>
    );
  }

  const variableCount = countTemplateVariables(form.bodyText);

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <Link
        to="/dashboard/settings/business"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to business settings
      </Link>

      <PageHeader
        eyebrow="Settings"
        title="WhatsApp message templates"
        description="WhatsApp requires a pre-approved template to reach a customer more than 24 hours after their last message. Create one here, wait for Meta's approval, then use it from a lead's reply box once a conversation has gone quiet."
      />

      {!user && (
        <Panel>
          <p className="text-sm text-muted-foreground">
            You're viewing this page signed out — sign up and connect WhatsApp via Meta (Business Settings) to create
            real templates.
          </p>
        </Panel>
      )}

      <Panel title="Your templates">
        {templates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No templates yet.</p>
        ) : (
          <ul className="space-y-3">
            {templates.map((tpl) => (
              <li key={tpl.id} className="rounded-sm border border-border-strong p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{tpl.name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[tpl.status]}`}>
                        {tpl.status}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {tpl.category} · {LANGUAGES.find((l) => l.code === tpl.language)?.label ?? tpl.language}
                      </span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{tpl.bodyText}</p>
                    {tpl.status === "rejected" && tpl.rejectionReason && (
                      <p className="mt-1 text-xs text-destructive">Rejected: {tpl.rejectionReason}</p>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(tpl.id)}
                    aria-label={`Delete ${tpl.name}`}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Create a template">
        <form className="grid gap-4" onSubmit={handleCreate}>
          <label className="block text-sm">
            <span className="label-caps text-muted-foreground">Name</span>
            <Input
              className="mt-1.5"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="quote_followup"
              required
            />
            <span className="mt-1.5 block text-xs text-muted-foreground">
              Lowercase letters, numbers, and underscores only — Meta's own naming rule.
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="label-caps text-muted-foreground">Category</span>
              <select
                className="mt-1.5 h-10 w-full rounded-sm border border-border-strong bg-background px-3 text-sm"
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as TemplateCategory }))}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="label-caps text-muted-foreground">Language</span>
              <select
                className="mt-1.5 h-10 w-full rounded-sm border border-border-strong bg-background px-3 text-sm"
                value={form.language}
                onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block text-sm">
            <span className="label-caps text-muted-foreground">Header (optional)</span>
            <Input
              className="mt-1.5"
              value={form.headerText}
              onChange={(e) => setForm((f) => ({ ...f, headerText: e.target.value }))}
              placeholder="Following up on your quote"
            />
          </label>

          <label className="block text-sm">
            <span className="label-caps text-muted-foreground">Body</span>
            <Textarea
              className="mt-1.5"
              rows={3}
              value={form.bodyText}
              onChange={(e) => setForm((f) => ({ ...f, bodyText: e.target.value }))}
              placeholder="Hi {{1}}, just checking in on your quote — still interested?"
              required
            />
            <span className="mt-1.5 block text-xs text-muted-foreground">
              Use {"{{1}}"}, {"{{2}}"}, etc. for values you'll fill in when you send it
              {variableCount > 0 ? ` — this body currently has ${variableCount} variable${variableCount === 1 ? "" : "s"}.` : "."}
            </span>
          </label>

          <label className="block text-sm">
            <span className="label-caps text-muted-foreground">Footer (optional)</span>
            <Input
              className="mt-1.5"
              value={form.footerText}
              onChange={(e) => setForm((f) => ({ ...f, footerText: e.target.value }))}
              placeholder="Job It Ready"
            />
          </label>

          <div>
            <Button type="submit" disabled={saving || !form.name.trim() || !form.bodyText.trim()}>
              {saving ? "Submitting…" : "Submit to Meta for approval"}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Meta typically reviews a new template within a few minutes to a few hours. Its status here updates
              automatically once Meta decides.
            </p>
          </div>
        </form>
      </Panel>
    </div>
  );
}
