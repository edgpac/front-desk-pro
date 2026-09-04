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

## Local development

Requires [Bun](https://bun.sh).

```sh
bun install
cp .env.example .env   # add your own ANTHROPIC_API_KEY
bun run dev
```

The `/demo` route exercises the real estimate flow against a sample price
sheet — no signup needed, but it does need a valid `ANTHROPIC_API_KEY` in
`.env` to return a real diagnosis instead of an error state.

## Design direction

Built to read as a real business tool for tradespeople, not a startup demo:
a grounded charcoal/navy palette with one confident accent color, real
job-site photography instead of stock or illustration, plainspoken copy, and
deliberately none of the purple-gradient/glassmorphism/sparkle-icon look
that's become the default "AI-generated" aesthetic.

## Scope

Out of scope for v1: SMS/Instagram DM intake, two-way calendar sync (a
pasted Cal.com/Calendly link is enough for now), a support ticket inbox,
multi-language, and a `/dashboard/settings/team` multi-user flow — real
value, but not needed to prove the core loop works.
