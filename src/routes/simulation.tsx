import { createFileRoute } from "@tanstack/react-router";

import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SimulationFlow } from "@/components/quote/SimulationFlow";

// Deliberately not linked from anywhere in the site nav/footer — this is a
// scripted walkthrough for internal use (demos, screenshots, testing the
// intake→clarify→result UI), not a customer-facing page. No robots
// directive needed since Google won't find an unlinked URL, but it's also
// not something to promote.
export const Route = createFileRoute("/simulation")({
  head: () => ({
    meta: [
      { title: "Simulation — Job It Ready" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: Simulation,
});

function Simulation() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <section className="border-b border-border-strong bg-paper">
        <div className="mx-auto max-w-6xl px-5 py-12">
          <p className="label-caps text-primary">Simulation · no live data</p>
          <h1 className="mt-3 max-w-2xl text-4xl sm:text-5xl">A scripted walkthrough of the customer flow.</h1>
          <p className="mt-4 max-w-xl text-[15px] text-muted-foreground">
            Every question and price on this page is fixed ahead of time — no photo is analyzed, no AI is
            called, and nothing is saved anywhere. Useful for a quick walkthrough or a screenshot without
            touching a real business's data or making a real API call.
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-2xl px-5 py-12">
          <SimulationFlow />
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
