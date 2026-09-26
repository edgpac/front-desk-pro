import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, ClipboardList, Clock, FileText, PhoneOff } from "lucide-react";

import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { EstimateReel } from "@/components/site/EstimateReel";
import { Button } from "@/components/ui/button";
const SOFTWARE_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Job It Ready",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  description:
    "AI-powered front desk for independent service businesses. Customers photograph a problem, Job It Ready prices it off the business's own price sheet using Claude AI, and books the job onto their calendar.",
  offers: [
    {
      "@type": "Offer",
      name: "Solo",
      price: "8",
      priceCurrency: "USD",
      description: "One person, one truck.",
    },
    {
      "@type": "Offer",
      name: "Crew",
      price: "19",
      priceCurrency: "USD",
      description: "Two to five techs.",
    },
  ],
};

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Job It Ready — the front desk for trades that don't have one" },
      {
        name: "description",
        content:
          "A customer sends a photo or describes the job. Job It Ready asks the right questions, prices it off your own rates, and helps turn the inquiry into a booked job. Built for plumbers, electricians, detailers, and any service business.",
      },
      { property: "og:title", content: "The front desk for trades that don't have one" },
      {
        property: "og:description",
        content: "Photo in. Priced estimate out. Job on the calendar. Job It Ready is the front desk that answers.",
      },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(SOFTWARE_SCHEMA),
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />

      {/* HERO — asymmetric split, photo does the talking */}
      <section className="border-b border-border-strong">
        <div className="mx-auto grid max-w-6xl grid-cols-1 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="border-border-strong px-5 py-14 lg:border-r lg:py-20 lg:pr-12">
            <p className="label-caps text-primary">
              For plumbers · electricians · detailers · any service business
            </p>
            <h1 className="mt-5 text-[2.6rem] leading-[1.03] text-foreground sm:text-6xl">
              The front desk for trades that don't have one.
            </h1>
            <p className="mt-4 text-lg font-semibold text-foreground">
              Photo in. Priced estimate out. Job on the calendar.
            </p>
            <p className="mt-4 max-w-lg text-[17px] leading-relaxed text-muted-foreground">
              A customer sends a photo or describes the job. Job It Ready asks the right questions, uses{" "}
              <span className="font-semibold text-foreground">your</span> pricing, builds the estimate, and
              helps turn the inquiry into a booked job.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg" variant="outline">
                <Link to="/demo">See a live demo</Link>
              </Button>
              <Button asChild size="lg">
                <Link to="/pricing">
                  Get started <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              No trial gimmicks — try the sample dashboard free, subscribe when you're ready. About 10
              minutes to set up.
            </p>

            <dl className="mt-12 grid grid-cols-3 gap-px overflow-hidden border border-border-strong bg-border-strong">
              {[
                { k: "Photo-first", v: "Start with the job, not a form" },
                { k: "Your pricing", v: "Estimates use your rates — not guessed numbers" },
                { k: "24/7 intake", v: "Customers don't wait for a callback" },
              ].map((s) => (
                <div key={s.k} className="bg-card px-4 py-4">
                  <dt className="font-display text-base font-extrabold text-foreground">{s.k}</dt>
                  <dd className="mt-1 text-[11px] leading-snug text-muted-foreground">{s.v}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="relative min-h-[380px]">
            <EstimateReel />
          </div>
        </div>
      </section>

      {/* THE COST OF A MISSED CALL — dark editorial numbered list */}
      <section className="bg-ink text-ink-foreground">
        <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <p className="label-caps text-primary">What it costs you now</p>
              <h2 className="mt-4 text-3xl leading-tight sm:text-[2.5rem]">
                The job doesn't go to the best tradesman. It goes to the one who answered.
              </h2>
              <p className="mt-4 max-w-md text-sm leading-relaxed text-ink-muted">
                You can't take a call with your hands in a wall. By the time you're back in the van,
                somebody else already gave a number.
              </p>
            </div>
            <ul className="divide-y divide-white/10 border-y border-white/10">
              {[
                {
                  icon: PhoneOff,
                  n: "01",
                  t: "Calls hit voicemail all afternoon",
                  d: "Most people don't leave one. They dial the next listing and you never know the job existed.",
                },
                {
                  icon: Clock,
                  n: "02",
                  t: "Quotes get written after dinner",
                  d: "Two hours of paperwork a night, and the ones you send late are the ones you lose.",
                },
                {
                  icon: FileText,
                  n: "03",
                  t: "Your pricing lives in your head",
                  d: "Nobody else in the crew can quote. Numbers drift job to job and margin quietly leaks.",
                },
                {
                  icon: ClipboardList,
                  n: "04",
                  t: "Other software just moves the form onto a screen",
                  d: "You still type every line item and look up your own prices yourself — trading a notepad for a screen doesn't make the estimate write itself.",
                },
              ].map((r) => (
                <li key={r.n} className="flex gap-5 py-6">
                  <span className="num font-display text-sm font-bold text-primary">{r.n}</span>
                  <div>
                    <h3 className="flex items-center gap-2 text-lg text-ink-foreground">
                      <r.icon className="h-4 w-4 text-primary" />
                      {r.t}
                    </h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{r.d}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS — alternating rows, real photos */}
      <section className="border-b border-border-strong">
        <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border-strong pb-6">
            <h2 className="text-3xl sm:text-4xl">How a lead turns into a booked job</h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              Same flow whether they came from your website, a Facebook post, or a magnet on the van.
            </p>
          </div>

          <ol className="grid gap-px overflow-hidden border border-border-strong bg-border-strong sm:grid-cols-5">
            {[
              { n: "01", t: "Customer reaches out", d: "Photo, message, or job description." },
              { n: "02", t: "Job It Ready qualifies it", d: "AI asks what it needs to know." },
              { n: "03", t: "Your pricing does the math", d: "Services, labor, materials, and fees." },
              { n: "04", t: "Customer gets the estimate", d: "Clear, professional, ready to approve." },
              { n: "05", t: "You get the job", d: "Lead, conversation, and booking." },
            ].map((step) => (
              <li key={step.n} className="bg-card px-5 py-6">
                <span className="num font-display text-sm font-bold text-primary">{step.n}</span>
                <h3 className="mt-2 text-base font-semibold text-foreground">{step.t}</h3>
                <p className="mt-1.5 text-sm leading-snug text-muted-foreground">{step.d}</p>
              </li>
            ))}
          </ol>

          <div className="pt-8">
            <Button asChild variant="outline">
              <Link to="/demo">Try the customer side yourself</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* WHAT YOU GET — dense two-column spec list, not card grid */}
      <section className="border-b border-border-strong bg-paper">
        <div className="mx-auto max-w-6xl px-5 py-16 lg:py-20">
          <p className="label-caps text-primary">What comes with it</p>
          <h2 className="mt-3 text-3xl sm:text-4xl">Everything your front desk should be doing.</h2>

          <div className="mt-10 grid gap-px bg-border-strong sm:grid-cols-2">
            {[
              {
                t: "Lead inbox",
                d: "Every request in one list: new, quoted, booked, won, lost. Open one and you see the photo, the diagnosis, and the math.",
              },
              {
                t: "Your pricing",
                d: "Photograph your price list or drop in a spreadsheet. Estimates are built from your own rates, never guessed — and you can change any number before it goes out.",
              },
              {
                t: "AI job intake",
                d: "Asks the questions you'd ask before pricing anything, and re-reads a bad photo instead of guessing from it.",
              },
              {
                t: "Branded estimates",
                d: "One click turns an approved estimate into a PDF with your logo, line items, terms and totals.",
              },
              {
                t: "Customer follow-up",
                d: "Customers ask about materials, timeline, DIY. It answers from the quote — and you can jump in yourself.",
              },
              {
                t: "Booking link",
                d: "Paste one line on your site, or drop the link in your Instagram bio. Same flow, straight to your calendar.",
              },
            ].map((f) => (
              <div key={f.t} className="bg-card p-6">
                <h3 className="text-lg">{f.t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PRICING STRIP */}
      <section className="border-b border-border-strong bg-paper">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 px-5 py-14">
          <div>
            <h2 className="text-3xl">Give your business a front desk.</h2>
            <p className="mt-2 text-lg font-semibold text-foreground">Flat monthly price. Cancel whenever.</p>
            <p className="mt-2 max-w-lg text-sm text-muted-foreground">
              $19.99/mo solo, $39.99/mo for a crew. One extra booked service call covers it.
            </p>
            <p className="mt-2 max-w-lg text-sm text-muted-foreground">
              Every day you wait is a day someone else in your market might already be answering
              faster.
            </p>
          </div>
          <div className="flex gap-3">
            <Button asChild size="lg">
              <Link to="/signup">Get started</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/pricing">Compare plans</Link>
            </Button>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
