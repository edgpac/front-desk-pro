import { createFileRoute } from "@tanstack/react-router";
import { Copy, ExternalLink } from "lucide-react";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { TENANT, embedSnippet, quoteLink } from "@/lib/mock-data";

export const Route = createFileRoute("/dashboard/widget")({
  component: WidgetPage,
});

function WidgetPage() {
  const snippet = embedSnippet(TENANT.slug);
  const link = quoteLink(TENANT.slug);

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

      <Panel title="Branding">
        <div className="flex items-center gap-4">
          <span
            className="h-10 w-10 rounded-sm border border-border-strong"
            style={{ backgroundColor: TENANT.brandColor }}
            aria-hidden
          />
          <div>
            <p className="text-sm font-medium text-foreground">{TENANT.brandColor}</p>
            <p className="text-xs text-muted-foreground">
              Used on your quote page and embedded widget buttons.
            </p>
          </div>
        </div>
      </Panel>
    </div>
  );
}
