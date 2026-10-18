import { createFileRoute } from "@tanstack/react-router";

import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";

export const Route = createFileRoute("/community-standards")({
  head: () => ({
    meta: [
      { title: "Community Standards — Job It Ready" },
      {
        name: "description",
        content: "What's expected when messaging through Job It Ready, including over WhatsApp.",
      },
    ],
  }),
  component: CommunityStandards,
});

function CommunityStandards() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      <section className="mx-auto max-w-3xl px-5 py-14">
        <p className="label-caps text-primary">Legal</p>
        <h1 className="mt-3 text-4xl">Community Standards</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated October 18, 2026.</p>

        <div className="prose mt-8 max-w-none space-y-6 text-[15px] leading-relaxed text-foreground">
          <p>
            Job It Ready isn't a public social platform — there's no feed, no profile, no public posts. What
            it does carry is private, one-to-one communication between a service business and its customer:
            a photo, a description of a job, a price, a back-and-forth over WhatsApp or a quote link. These
            standards cover what's and isn't acceptable in that channel, for both businesses using Job It Ready
            and the customers messaging through it.
          </p>

          <h2 className="text-xl font-semibold">Who this applies to</h2>
          <p>
            Business accounts, and anyone a business account messages through Job It Ready (customers reaching
            out via WhatsApp, an embedded widget, or a shareable quote link).
          </p>

          <h2 className="text-xl font-semibold">Not allowed</h2>
          <ul className="list-disc space-y-2 pl-6">
            <li>Harassment, threats, hate speech, or abusive language directed at anyone in a conversation.</li>
            <li>Illegal content or activity of any kind, including content exploiting or endangering minors —
              this is reported to the relevant authorities and results in immediate account termination.</li>
            <li>Sending unsolicited bulk messages, spam, or using Job It Ready's WhatsApp integration for
              marketing blasts rather than genuine customer service and quoting.</li>
            <li>Impersonating another person or business, or misrepresenting who you are in a conversation.</li>
            <li>Sharing someone else's private information without their consent.</li>
            <li>Uploading content you don't have the right to share, or that infringes someone else's
              intellectual property.</li>
            <li>Attempting to interfere with, abuse, or probe Job It Ready's systems, or use the Service to
              distribute malware or conduct fraud.</li>
          </ul>

          <h2 className="text-xl font-semibold">WhatsApp specifically</h2>
          <p>
            Messaging sent or received through Job It Ready's WhatsApp integration is also governed by
            WhatsApp's own Business Messaging Policy and Meta's platform terms, in addition to these
            standards. Where the two overlap, the stricter rule applies.
          </p>

          <h2 className="text-xl font-semibold">What happens if these are violated</h2>
          <p>
            Depending on severity, we may remove content, warn an account, suspend WhatsApp messaging access,
            or terminate an account entirely. Illegal content is reported to the appropriate authorities.
            See our <a className="text-primary underline-offset-4 hover:underline" href="/terms">Terms of Service</a> for
            how account suspension and termination work more generally.
          </p>

          <h2 className="text-xl font-semibold">Reporting a problem</h2>
          <p>
            If you've received something through Job It Ready that violates these standards — from a business
            or from a customer — contact us and we'll review it:{" "}
            <a className="text-primary underline-offset-4 hover:underline" href="mailto:legal@frontdesk.tools">
              legal@frontdesk.tools
            </a>
          </p>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
