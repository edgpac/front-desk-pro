import { createFileRoute } from "@tanstack/react-router";

import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — FrontDesk" },
      {
        name: "description",
        content: "How FrontDesk collects, uses, and protects data for businesses and their customers.",
      },
    ],
  }),
  component: PrivacyPolicy,
});

function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <section className="mx-auto max-w-3xl px-5 py-14">
        <p className="label-caps text-primary">Legal</p>
        <h1 className="mt-3 text-4xl">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated September 6, 2026.</p>

        <div className="prose mt-8 max-w-none space-y-6 text-[15px] leading-relaxed text-foreground">
          <p>
            FrontDesk ("FrontDesk," "we," "us") provides software that helps service businesses turn a
            customer's photo and description into a priced estimate. This policy explains what we collect,
            why, and how it's handled — both for the businesses who sign up for FrontDesk ("business
            accounts") and the customers who send in a photo or message ("end customers").
          </p>

          <h2 className="text-xl font-semibold">What we collect</h2>
          <p><strong>From a business account:</strong> name, email, phone, business details (trade, service
            area, hours, pricing), and account credentials, collected when you sign up and use the
            dashboard.</p>
          <p><strong>From an end customer:</strong> name, phone number, address (if given), photos of the
            problem, and a description of the issue — submitted through a business's embedded widget,
            shareable quote link, or WhatsApp. We collect this on behalf of the business the customer is
            contacting, not on our own behalf.</p>

          <h2 className="text-xl font-semibold">How we use it</h2>
          <ul className="list-disc space-y-2 pl-6">
            <li>To generate an AI-assisted diagnosis and price estimate from a submitted photo and
              description.</li>
            <li>To deliver messages between a business and its customers (email and WhatsApp).</li>
            <li>To run the dashboard: leads, price sheets, proposals, invoices, and analytics for a business
              account.</li>
            <li>To process subscription payments.</li>
            <li>To operate, secure, and improve the service — including detecting abuse and fixing bugs.</li>
          </ul>

          <h2 className="text-xl font-semibold">Who we share it with</h2>
          <p>We don't sell data. We share it only with the services that make FrontDesk work:</p>
          <ul className="list-disc space-y-2 pl-6">
            <li><strong>Anthropic</strong> — a submitted photo and description are sent to Anthropic's Claude
              API to generate the diagnosis and price estimate.</li>
            <li><strong>Twilio</strong> — WhatsApp messages (including photos) are sent and received through
              Twilio's platform.</li>
            <li><strong>Stripe</strong> — subscription payments are processed by Stripe. FrontDesk never
              receives or stores full card numbers.</li>
            <li><strong>Supabase</strong> — our database and authentication provider, where account and lead
              data is stored.</li>
          </ul>
          <p>Each of these providers processes data under their own privacy terms as our service providers,
            not as independent owners of it.</p>

          <h2 className="text-xl font-semibold">How long we keep it</h2>
          <p>Business account and lead data is kept for as long as the account is active. Photos sent over
            WhatsApp are subject to Twilio's own media retention window. If you'd like your data deleted,
            contact us using the details below and we'll remove it, except where we're required to keep
            records (e.g. billing history) for legal or accounting reasons.</p>

          <h2 className="text-xl font-semibold">Your choices</h2>
          <p>Business accounts can review and update their own information from the dashboard at any time.
            End customers who want their data removed from a business's FrontDesk account should contact
            that business directly, or reach out to us and we'll help route the request.</p>

          <h2 className="text-xl font-semibold">Children's privacy</h2>
          <p>FrontDesk isn't directed at children, and we don't knowingly collect data from anyone under 16.</p>

          <h2 className="text-xl font-semibold">Changes to this policy</h2>
          <p>If this policy changes in a material way, we'll update the date at the top of this page.</p>

          <h2 className="text-xl font-semibold">Contact</h2>
          <p>Questions about this policy or a data request: <a className="text-primary underline-offset-4 hover:underline" href="mailto:privacy@frontdesk.tools">privacy@frontdesk.tools</a></p>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
