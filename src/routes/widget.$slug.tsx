import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { QuoteFlow } from "@/components/quote/QuoteFlow";
import { getTenantForQuote, type QuoteTenant } from "@/lib/public-lead-server";

// The iframe target for the embeddable widget (public/widget.js) — a bare,
// header/footer-free wrapper around the exact same QuoteFlow + tenant
// resolution /quote/:slug already uses. Deliberately a separate route
// rather than a query-param branch on quote.$slug.tsx, so that page's
// existing behavior is untouched by anything here.
export const Route = createFileRoute("/widget/$slug")({
  head: () => ({
    meta: [
      { title: "Get an estimate" },
      // Only ever meant to be seen inside another site's iframe — keep it
      // out of search results as its own page.
      { name: "robots", content: "noindex" },
    ],
  }),
  component: WidgetEmbedPage,
});

function WidgetEmbedPage() {
  const { slug } = Route.useParams();
  const [tenant, setTenant] = useState<QuoteTenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let active = true;
    getTenantForQuote({ data: slug })
      .then((realTenant) => {
        if (active) setTenant(realTenant);
      })
      .catch(() => {
        if (active) setNotFound(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  if (loading) {
    return <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">Loading…</div>;
  }

  if (notFound || !tenant) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6 text-center text-sm text-muted-foreground">
        This estimate service isn't available right now — please contact the business directly.
      </div>
    );
  }

  return (
    <div className="h-screen overflow-y-auto bg-background p-3">
      <QuoteFlow
        businessName={tenant.name}
        laborRate={tenant.laborRate}
        serviceCallFee={tenant.serviceCallFee}
        bookingLink={tenant.calendarLink}
        priceSheet={tenant.priceSheet}
        tenantSlug={tenant.slug}
        channel="Widget"
        compact
      />
    </div>
  );
}
