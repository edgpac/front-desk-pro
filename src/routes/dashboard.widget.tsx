import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, Download, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import QRCode from "qrcode";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { copyText } from "@/lib/clipboard";
import { useAuth } from "@/lib/use-auth";
import { getMyTenant, updateMyTenantSlug } from "@/lib/tenant-server";
import { TENANT, type Tenant, embedSnippet, quoteLink, menuLink } from "@/lib/mock-data";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export const Route = createFileRoute("/dashboard/widget")({
  component: WidgetPage,
});

function WidgetPage() {
  const { user, loading: authLoading } = useAuth();
  const [tenant, setTenant] = useState<Tenant>(TENANT);
  const [loading, setLoading] = useState(true);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [slugDraft, setSlugDraft] = useState(TENANT.slug);
  const [confirmingSlug, setConfirmingSlug] = useState(false);
  const [savingSlug, setSavingSlug] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setTenant(TENANT);
      setLoading(false);
      return;
    }
    let active = true;
    getMyTenant()
      .then((realTenant) => {
        if (active) {
          setTenant(realTenant);
          setSlugDraft(realTenant.slug);
        }
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not load your business.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  async function handleConfirmSlugChange() {
    setSavingSlug(true);
    try {
      const result = await updateMyTenantSlug({ data: { slug: slugDraft } });
      setTenant((t) => ({ ...t, slug: result.slug }));
      setSlugDraft(result.slug);
      setConfirmingSlug(false);
      toast.success("Your URL has been updated.");
    } catch (err) {
      toast.error(errorMessage(err, "Could not update your URL."));
    } finally {
      setSavingSlug(false);
    }
  }

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(quoteLink(tenant.slug), { width: 320, margin: 1 })
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setQrDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [tenant.slug]);

  if (loading) {
    return (
      <div className="space-y-6 p-6 lg:p-10">
        <PageHeader eyebrow="Widget & link" title="Loading…" />
      </div>
    );
  }

  const snippet = embedSnippet(tenant.slug);
  const link = quoteLink(tenant.slug);

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader eyebrow="Widget & link" title="Two ways in, same flow both ways" />

      <Panel title="Your URL">
        <p className="text-sm text-muted-foreground">
          This is the part of every link below that&apos;s actually yours — your embedded widget,
          shareable link, QR code, and any link JIR Chat sends a customer all use it. Make it your
          business name instead of whatever it was set to when you signed up.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center rounded-sm border border-border-strong bg-muted px-3 py-2">
            <span className="shrink-0 text-sm text-muted-foreground">jobitready.com/menu/</span>
            <Input
              value={slugDraft}
              onChange={(e) => setSlugDraft(e.target.value)}
              className="h-auto border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
              disabled={!user}
            />
          </div>
          <Button
            type="button"
            onClick={() => setConfirmingSlug(true)}
            disabled={!user || !slugDraft.trim() || slugDraft === tenant.slug}
          >
            Save
          </Button>
        </div>
        {user && slugDraft !== tenant.slug && (
          <p className="mt-2 text-xs text-muted-foreground">
            Preview:{" "}
            <code className="text-foreground">{menuLink(slugDraft.trim().toLowerCase())}</code>
          </p>
        )}
      </Panel>

      <AlertDialog open={confirmingSlug} onOpenChange={(open) => !open && setConfirmingSlug(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update your URL?</AlertDialogTitle>
            <AlertDialogDescription>
              Your embedded widget, shareable quote link, QR code, and current menu link all change
              to use <strong className="text-foreground">{slugDraft.trim().toLowerCase()}</strong>{" "}
              immediately. Anywhere the OLD link was already shared — a bio link, a printed QR code,
              a message JIR Chat already sent a customer — will stop working. Re-copy and re-share
              the updated versions below after saving.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingSlug}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleConfirmSlugChange();
              }}
              disabled={savingSlug}
            >
              {savingSlug && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Update URL
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Panel
        title="Embed on your site"
        aside={
          <Button
            size="sm"
            variant="outline"
            onClick={() => copyText(snippet, "Embed code copied")}
          >
            <Copy className="mr-2 h-3.5 w-3.5" /> Copy
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">
          Paste this once on your site — Wix, GoDaddy, WordPress, or a plain HTML page all work the
          same way.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-sm bg-ink px-4 py-3 text-xs text-ink-foreground">
          <code>{snippet}</code>
        </pre>
      </Panel>

      <Panel
        title="Shareable link"
        aside={
          <Button size="sm" variant="outline" onClick={() => copyText(link, "Link copied")}>
            <Copy className="mr-2 h-3.5 w-3.5" /> Copy
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">
          Drop this in your Instagram bio, a text reply, or anywhere else a link works better than
          code.
        </p>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-sm border border-border-strong bg-muted px-4 py-3">
          <code className="truncate text-sm text-foreground">{link}</code>
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary hover:underline"
          >
            Open <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </Panel>

      <Panel
        title="QR code"
        aside={
          qrDataUrl ? (
            <Button size="sm" variant="outline" asChild>
              <a href={qrDataUrl} download={`frontdesk-quote-qr-${tenant.slug}.png`}>
                <Download className="mr-2 h-3.5 w-3.5" /> Download PNG
              </a>
            </Button>
          ) : null
        }
      >
        <p className="text-sm text-muted-foreground">
          Print it on a van decal, a job-site sign, or a business card — scanning it opens your
          shareable quote link directly.
        </p>
        <div className="mt-3 flex justify-center rounded-sm border border-border-strong bg-muted p-4">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="QR code linking to your quote page"
              width={200}
              height={200}
            />
          ) : (
            <div className="flex h-[200px] w-[200px] items-center justify-center text-xs text-muted-foreground">
              Generating…
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Branding">
        <div className="flex items-center gap-4">
          <span
            className="h-10 w-10 rounded-sm border border-border-strong"
            style={{ backgroundColor: tenant.brandColor }}
            aria-hidden
          />
          <div>
            <p className="text-sm font-medium text-foreground">{tenant.brandColor}</p>
            <p className="text-xs text-muted-foreground">
              Used on your quote page and embedded widget buttons.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
