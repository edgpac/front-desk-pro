# FrontDesk

The front desk for trades that don't have one. A customer photographs a
problem, FrontDesk prices it off the business's own price sheet, and books
the job onto their calendar — no receptionist, no waiting for a callback.

## Product

A web platform for independent trades businesses (plumbers, electricians,
HVAC, appliance repair) to run an AI-powered quote intake: customers send a
photo and a couple of sentences, get an instant priced estimate, and book
directly. The business gets a lead inbox, a branded proposal generator, and
an embeddable widget + shareable link for their own site and socials.

**Target user:** a solo or small-crew tradesperson, checking this on a phone
between jobs — not a power user of software.

## Stack

- React 19 + TanStack Start (file-based routing, SSR) + Vite
- Tailwind CSS 4
- Radix UI primitives
- Claude (Anthropic) for photo diagnosis and pricing — see
  `src/lib/estimate-server.ts`
- Supabase for auth — see `src/integrations/supabase/`

## Local development

Requires [Bun](https://bun.sh).

```sh
bun install
cp .env.example .env   # fill in the values below
bun run dev
```

You need two things in `.env`:

1. **`ANTHROPIC_API_KEY`** — from [console.anthropic.com](https://console.anthropic.com/settings/keys).
   The `/demo` route exercises the real estimate flow against a sample price
   sheet without this returns an honest error instead of a real diagnosis.
2. **A Supabase project** — create a **new** one at
   [supabase.com/dashboard](https://supabase.com/dashboard) (don't reuse a
   project from another app — FrontDesk's users should be their own, not
   shared with anything else). Settings → API on that project gives you the
   URL, anon/publishable key, and service role key. No custom tables are
   needed yet — Supabase's built-in `auth.users` covers signup/login as-is.
   Without this, `/login` and `/signup` will throw on submit.
3. **Stripe** — API keys from [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys)
   (use the test keys while developing). For the webhook secret, either
   create a webhook endpoint at dashboard.stripe.com/webhooks pointed at
   `<your-deployed-url>/api/stripe/webhook` once deployed, or run
   `stripe listen --forward-to localhost:8080/api/stripe/webhook` locally,
   which prints a temporary signing secret. Without this, the "Switch to
   Solo/Crew" buttons on the billing page fail with a clear error instead of
   starting checkout.

Checkout itself never asks for an email — it's pulled server-side from the
already-authenticated Supabase session (see `src/lib/stripe-server.ts`), so
there's no separate email field to keep in sync with the account someone
actually logged in with.

## Design direction

Built to read as a real business tool for tradespeople, not a startup demo:
a grounded charcoal/navy palette with one confident accent color, real
job-site photography instead of stock or illustration, plainspoken copy, and
deliberately none of the purple-gradient/glassmorphism/sparkle-icon look
that's become the default "AI-generated" aesthetic.

## SEO / AI discoverability

Same tech as caboshandyman.com, for the same reason: `public/llms.txt` (an
AI-crawler-readable summary of the product), `public/sitemap.xml` (generated
via `npm run generate-sitemap`, listing only real marketing pages — not
`/dashboard/*` or `/api/*`), a `Sitemap:` line in `robots.txt`, and
`SoftwareApplication` JSON-LD structured data on the homepage. All of this
currently points at `frontdesk.tools` as a placeholder domain, matching the
one already used in `src/lib/mock-data.ts`'s widget/quote-link helpers —
swap it for the real domain once one is registered.

## Scope

Out of scope for v1: SMS/Instagram DM intake, two-way calendar sync (a
pasted Cal.com/Calendly link is enough for now), a support ticket inbox,
multi-language, and a `/dashboard/settings/team` multi-user flow — real
value, but not needed to prove the core loop works.
