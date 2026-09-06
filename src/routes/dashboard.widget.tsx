import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, Download, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import QRCode from "qrcode";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { useAuth } from "@/lib/use-auth";
import { getMyTenant } from "@/lib/tenant-server";
import { TENANT, type Tenant, embedSnippet, quoteLink } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/widget")({
  component: WidgetPage,
});

function WidgetPage() {
  const { user, loading: authLoading } = useAuth();
  const [tenant, setTenant] = useState<Tenant>(TENANT);
  const [loading, setLoading] = useState(true);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

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
        if (active) setTenant(realTenant);
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

      <Panel
        title="Embed on your site"
        aside={
          <Button size="sm" variant="outline" onClick={() => copyText(snippet, "Embed code copied")}>
            <Copy className="mr-2 h-3.5 w-3.5" /> Copy
          </Button>
        }
      >
        <p className="text-sm text-muted-foreground">
          Paste this once on your site — Wix, GoDaddy, WordPress, or a plain HTML page all work the same
          way.
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
          Drop this in your Instagram bio, a text reply, or anywhere else a link works better than code.
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
          Print it on a van decal, a job-site sign, or a business card — scanning it opens your shareable
          quote link directly.
        </p>
        <div className="mt-3 flex justify-center rounded-sm border border-border-strong bg-muted p-4">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="QR code linking to your quote page" width={200} height={200} />
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
