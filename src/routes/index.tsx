import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, ClipboardList, Clock, FileText, PhoneOff } from "lucide-react";

import { SiteHeader } from "@/components/site/SiteHeader";
import { SiteFooter } from "@/components/site/SiteFooter";
import { Button } from "@/components/ui/button";
import heroPhoto from "@/assets/plumber-under-sink.jpg";
import panelPhoto from "@/assets/electrician-panel.jpg";
import vanPhoto from "@/assets/work-van.jpg";
import leakPhoto from "@/assets/leak-detail.jpg";

const SOFTWARE_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "FrontDesk",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web",
  description:
    "AI-powered front desk for independent service businesses. Customers photograph a problem, FrontDesk prices it off the business's own price sheet using Claude AI, and books the job onto their calendar.",
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
      { title: "FrontDesk — quote every job before your competition calls back" },
      {
        name: "description",
        content:
          "Customers send a photo, FrontDesk sends a priced estimate off your own price sheet, and books the job on your calendar. Built for plumbers, electricians, detailers, and any service business that quotes from a photo.",
      },
      { property: "og:title", content: "Quote every job before your competition calls back" },
      {
        property: "og:description",
        content:
          "Photo in, priced estimate out, job booked. FrontDesk answers quote requests while you're under a sink.",
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
            <p className="label-caps text-primary">For plumbers · electricians · detailers · any trade</p>
            <h1 className="mt-5 text-[2.6rem] leading-[1.03] text-foreground sm:text-6xl">
              Quote the job before
              <br />
              the next guy calls back.
            </h1>
            <p className="mt-6 max-w-lg text-[17px] leading-relaxed text-muted-foreground">
              A customer takes a photo of the problem. FrontDesk reads it, prices it off{" "}
              <span className="font-semibold text-foreground">your</span> price sheet, and books it on your
              calendar — while you're still under somebody's sink.
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
                { k: "4 min", v: "median time to a priced estimate" },
                { k: "3 of 4", v: "customers hire whoever answers first" },
                { k: "0", v: "quotes typed out at 9pm" },
              ].map((s) => (
                <div key={s.k} className="bg-card px-4 py-4">
                  <dt className="num font-display text-2xl font-extrabold text-foreground">{s.k}</dt>
                  <dd className="mt-1 text-[11px] leading-snug text-muted-foreground">{s.v}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="relative min-h-[380px] bg-ink">
            <img
              src={heroPhoto}
              alt="Plumber replacing a trap under a kitchen sink on a service call"
              width={1600}
              height={1104}
              className="h-full w-full object-cover opacity-95"
            />
            <div className="absolute inset-x-4 bottom-4 border border-border-strong bg-card shadow-lift sm:inset-x-6 sm:bottom-6 sm:max-w-sm">
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <p className="label-caps text-primary">Estimate sent 4:12 min after photo</p>
              </div>
              <div className="px-4 py-3 text-sm">
                <p className="font-semibold text-foreground">Water heater drain valve leak</p>
                <ul className="mt-2 space-y-1 text-muted-foreground">
                  <li className="flex justify-between">
                    <span>Drain valve replacement</span> <span className="num text-foreground">$165</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Tank flush</span> <span className="num text-foreground">$95</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Labor · 1.5 hr @ $125</span> <span className="num text-foreground">$188</span>
                  </li>
                </ul>
                <div className="mt-3 flex items-center justify-between border-t border-border-strong pt-2.5">
                  <span className="label-caps">Total</span>
                  <span className="num font-display text-xl font-extrabold text-foreground">$448</span>
                </div>
              </div>
            </div>
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

          {[
            {
              n: "01",
              t: "They send a photo and two sentences",
              d: "Your branded quote page opens on their phone. Camera, gallery, or just type it out. No account, no forms with twelve fields.",
              img: leakPhoto,
              alt: "Customer photo of a leaking water heater fitting",
              w: 1200,
              h: 900,
            },
            {
              n: "02",
              t: "It asks the questions you'd ask",
              d: "Age of the unit, is it dripping or pouring, is there access. When the photo is unclear it follows up instead of guessing — that's how the price ends up close.",
              img: panelPhoto,
              alt: "Electrician working inside a residential breaker panel",
              w: 1200,
              h: 1500,
            },
            {
              n: "03",
              t: "Priced off your sheet, booked on your calendar",
              d: "Flat rates, hourly labor, ranges — whatever you actually charge. Estimate lands in their thread and in your inbox, with a booking link attached.",
              img: vanPhoto,
              alt: "A service van wrapped with the FrontDesk logo, tagline, and a send-photo, get-quote, book-the-job icon strip",
              w: 1400,
              h: 1050,
            },
          ].map((step, i) => (
            <div
              key={step.n}
              className={`grid items-center gap-8 border-b border-border py-10 lg:grid-cols-2 lg:gap-14 ${
                i % 2 === 1 ? "lg:[&>figure]:order-first" : ""
              }`}
            >
              <div>
                <span className="num font-display text-sm font-bold text-primary">{step.n}</span>
                <h3 className="mt-2 text-2xl sm:text-[1.75rem]">{step.t}</h3>
                <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted-foreground">{step.d}</p>
              </div>
              <figure className="border border-border-strong bg-muted">
                <img
                  src={step.img}
                  alt={step.alt}
                  loading="lazy"
                  width={step.w}
                  height={step.h}
                  className="aspect-[4/3] w-full object-cover"
                />
              </figure>
            </div>
          ))}

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
          <h2 className="mt-3 max-w-2xl text-3xl sm:text-4xl">
            A lead inbox, your price sheet, and proposals that look like a real company sent them.
          </h2>

          <div className="mt-10 grid gap-px bg-border-strong sm:grid-cols-2">
            {[
              {
                t: "Lead inbox",
                d: "Every request in one list: new, quoted, booked, won, lost. Open one and you see the photo, the diagnosis, and the math.",
              },
              {
                t: "Your price sheet, extracted",
                d: "Photograph the paper list on your dash or drop in a spreadsheet. It becomes an editable table you control.",
              },
              {
                t: "Override anything",
                d: "Don't like a number? Change it before it goes out. Re-run the read on a bad photo. You approve every estimate.",
              },
              {
                t: "Branded proposals",
                d: "One click turns an approved estimate into a PDF with your logo, line items, terms and totals.",
              },
              {
                t: "Widget + shareable link",
                d: "Paste one line on your site, or drop the link in your Instagram bio. Same flow both ways.",
              },
              {
                t: "Follow-up thread",
                d: "Customers ask about materials, timeline, DIY. It answers from your quote — and you can jump in yourself.",
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

      {/* WHAT THIS LOOKS LIKE IN PRACTICE */}
      <section className="border-b border-border-strong">
        <div className="mx-auto max-w-6xl px-5 pt-12">
          <p className="label-caps text-primary">What this looks like in practice</p>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            These are the scenarios FrontDesk is built to handle, not customer quotes.
          </p>
        </div>
        <div className="mx-auto grid max-w-6xl gap-px bg-border-strong px-0 pt-8 sm:grid-cols-2">
          {[
            {
              q: "No more quoting at night. A customer's photo and answers are waiting in the morning, priced and ready to approve — two hours back, every day.",
            },
            {
              q: "A customer sends a photo of a scorched outlet at 6am. She has a priced estimate by 6:20 and the job's on the calendar before the first coffee.",
            },
          ].map((t) => (
            <figure key={t.q} className="bg-card px-6 py-12 sm:px-10">
              <blockquote className="font-display text-xl leading-snug text-foreground sm:text-2xl">
                “{t.q}”
              </blockquote>
            </figure>
          ))}
        </div>
      </section>

      {/* PRICING STRIP */}
      <section className="border-b border-border-strong bg-paper">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 px-5 py-14">
          <div>
            <h2 className="text-3xl">Flat monthly price. Cancel whenever.</h2>
            <p className="mt-2 max-w-lg text-sm text-muted-foreground">
              $8/mo solo, $19/mo for a crew. One extra booked service call covers it.
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
