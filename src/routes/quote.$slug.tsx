import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { QuoteFlow } from "@/components/quote/QuoteFlow";
import { getTenantForQuote, type QuoteTenant } from "@/lib/public-lead-server";

export const Route = createFileRoute("/quote/$slug")({
  head: () => ({
    meta: [
      { title: "Get an estimate" },
      { name: "description", content: "Send a photo and a couple of sentences, get a priced estimate." },
    ],
  }),
  component: QuotePage,
});

function QuotePage() {
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

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <section className="border-b border-border-strong bg-paper">
        <div className="mx-auto max-w-3xl px-5 py-12">
          <p className="label-caps text-primary">Get an estimate</p>
          <h1 className="mt-3 text-4xl sm:text-5xl">
            {loading ? "Loading…" : notFound ? "We couldn't find this business" : tenant?.name}
          </h1>
          {!loading && !notFound && (
            <p className="mt-4 max-w-xl text-[15px] text-muted-foreground">
              Send a photo and a couple of sentences, get a priced estimate.
            </p>
          )}
          {notFound && (
            <p className="mt-4 max-w-xl text-[15px] text-muted-foreground">
              Double-check the link — this business's quote page isn't set up at that address.
            </p>
          )}
        </div>
      </section>

      {!loading && !notFound && tenant && (
        <section>
          <div className="mx-auto max-w-3xl px-5 py-12">
            <QuoteFlow
              businessName={tenant.name}
              laborRate={tenant.laborRate}
              serviceCallFee={tenant.serviceCallFee}
              bookingLink={tenant.calendarLink}
              priceSheet={tenant.priceSheet}
              tenantSlug={tenant.slug}
            />
          </div>
        </section>
      )}

      <SiteFooter />
    </div>
  );
}
