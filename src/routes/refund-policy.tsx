import { createFileRoute } from "@tanstack/react-router";

import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";

export const Route = createFileRoute("/refund-policy")({
  head: () => ({
    meta: [
      { title: "Refund & Cancellation Policy — Job It Ready" },
      {
        name: "description",
        content:
          "How billing, cancellation, and refunds work for Job It Ready's Solo and Crew plans.",
      },
    ],
  }),
  component: RefundPolicy,
});

function RefundPolicy() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <section className="mx-auto max-w-3xl px-5 py-14">
        <p className="label-caps text-primary">Legal</p>
        <h1 className="mt-3 text-4xl">Refund & Cancellation Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">Draft — last updated November 4, 2026.</p>

        <div className="prose mt-8 max-w-none space-y-6 text-[15px] leading-relaxed text-foreground">
          <p>
            This policy covers Job It Ready's paid Solo and Crew subscriptions, billed monthly
            through Stripe. It works alongside our Terms of Service — if anything here conflicts
            with the Terms, this policy governs for billing and cancellation specifically.
          </p>

          <h2 className="text-xl font-semibold">No free trial</h2>
          <p>
            Job It Ready doesn't currently offer a free trial period. You're charged for your first
            billing period as soon as you subscribe. You can try the sample dashboard and the live
            demo before subscribing, at no cost and with no account required.
          </p>

          <h2 className="text-xl font-semibold">Recurring billing</h2>
          <p>
            Paid plans renew automatically every month at the rate shown on our pricing page, until
            you cancel. By subscribing, you authorize us to charge your payment method on file each
            billing period.
          </p>

          <h2 className="text-xl font-semibold">Canceling</h2>
          <p>
            Cancel anytime from your dashboard's billing page — no minimum term, no cancellation
            fee, no phone call. Canceling stops all future billing.
          </p>

          <h2 className="text-xl font-semibold">Refunds</h2>
          <p>
            We don't provide refunds for a billing period you've already paid for, including if you
            cancel partway through one. If you believe you were charged in error — a duplicate
            charge, a charge after you canceled, or a similar billing mistake — contact us and we'll
            look into it.
          </p>

          <h2 className="text-xl font-semibold">Questions or a billing problem</h2>
          <p>
            Contact{" "}
            <a
              className="text-primary underline-offset-4 hover:underline"
              href="mailto:jobitready@gmail.com"
            >
              jobitready@gmail.com
            </a>{" "}
            and we'll help sort it out.
          </p>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
