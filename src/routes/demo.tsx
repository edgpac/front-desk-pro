import { createFileRoute, Link } from "@tanstack/react-router";

import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { QuoteFlow } from "@/components/quote/QuoteFlow";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/demo")({
  head: () => ({
    meta: [
      { title: "Live demo — see a photo turn into a priced estimate" },
      {
        name: "description",
        content:
          "Run the customer side of FrontDesk yourself: send a job photo, answer two questions, get a priced estimate. No signup.",
      },
      { property: "og:title", content: "FrontDesk live demo — photo in, price out" },
      {
        property: "og:description",
        content: "Try the customer flow with a sample job photo. No signup, no card.",
      },
    ],
  }),
  component: Demo,
});

function Demo() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <section className="border-b border-border-strong bg-paper">
        <div className="mx-auto max-w-6xl px-5 py-12">
          <p className="label-caps text-primary">Live demo · no signup</p>
          <h1 className="mt-3 max-w-2xl text-4xl sm:text-5xl">
            This is exactly what your customer sees.
          </h1>
          <p className="mt-4 max-w-xl text-[15px] text-muted-foreground">
            Pick a sample job photo, answer the two follow-ups, and read the estimate. Prices here come off
            a sample plumbing sheet — yours would use your own numbers.
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-12 lg:grid-cols-[1fr_0.8fr]">
          <QuoteFlow businessName="Hale & Sons Plumbing (demo)" />

          <aside className="space-y-6">
            <div className="border border-border-strong bg-card p-5">
              <h2 className="text-lg">What just happened on your side</h2>
              <ol className="mt-3 space-y-3 text-sm text-muted-foreground">
                <li>
                  <span className="num font-display font-bold text-primary">01</span> The request lands in
                  your lead inbox with the photo, the answers, and a draft price.
                </li>
                <li>
                  <span className="num font-display font-bold text-primary">02</span> You approve it, change
                  a number, or ask for a re-read on a bad photo.
                </li>
                <li>
                  <span className="num font-display font-bold text-primary">03</span> One click turns it into
                  a branded proposal PDF or PNG.
                </li>
              </ol>
              <Button asChild className="mt-5 w-full">
                <Link to="/signup">Sign up to get this for your business</Link>
              </Button>
            </div>

            <div className="border border-border-strong bg-ink p-5 text-ink-foreground">
              <p className="label-caps text-primary">Owner view</p>
              <p className="mt-2 text-sm text-ink-muted">
                Want to see the inbox, price sheet and proposal generator before you sign up? Walk through
                the dashboard with sample data.
              </p>
              <Button asChild className="mt-4 w-full">
                <Link to="/dashboard">Open the sample dashboard</Link>
              </Button>
            </div>
          </aside>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
