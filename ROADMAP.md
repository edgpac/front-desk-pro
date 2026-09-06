# Job It Ready (formerly FrontDesk) — build status and game plan

Legend: ✅ real and working · 🟡 built, but mocked/disconnected from a real backend · ⬜ not built yet

Last updated: September 6, 2026 — the codebase text rename from FrontDesk to
Job It Ready landed (see "Brand" below); before that, a wide dashboard-auth
bug sweep, real Stripe billing, real price-sheet photo/URL extraction, the
Business Capabilities system, and the Field Notes migration all landed
since the last update below — see the new rows throughout for what changed
and why. The rest of this file still narrates history using the name that
was actually in use at the time ("FrontDesk") — that's deliberate, see the
Brand section.

## Brand: renamed to Job It Ready (codebase text)

**`jobitready.com` was purchased on 2026-09-06.** The product renamed from
**FrontDesk** to **Job It Ready** — "Get job ready before you get to the
job," with the same three-layer pitch this build has been converging on
anyway: a customer sends the job, Job It Ready understands it, checks it
against what the business does and charges, prices it when it safely can,
and gets the job ready before the owner ever sees it.

Brand validation ran before the rename started:

- [x] Trademark search — no exact "Job It Ready" federal registration
      found via public search (USPTO's own search tool doesn't return
      results to automated queries, so a live TESS search or attorney
      consult is still worth doing before a paid marketing push). **One
      real risk flagged and knowingly accepted**: "Job Ready, LLC"
      (`myjobready.com`) runs a business-management SaaS for trades/
      service businesses out of Charlotte, NC — same vertical, a
      one-word-away name.
- [x] Company-name collision search — the "Job Ready, LLC" match above;
      otherwise only unrelated workforce-training orgs ("Job Ready
      Services, LLC," NC's state `ncjobready.nc.gov` program).
- [x] App-store name search — no "Job It Ready" listing on Google Play or
      the Apple App Store.
- [x] Social handle availability — no exact `jobitready` account found on
      Instagram, X, TikTok, or Facebook (not independently confirmed
      available on every platform — a manual check is still worth doing
      before claiming the handles).
- [ ] Brand architecture: logo, color palette, favicon, in-app name, page
      titles — still open; the in-app name/page titles are done as part of
      the codebase rename below, the rest (logo, palette, favicon) isn't.

**What's actually renamed now**: every "FrontDesk" string in marketing
copy, the dashboard, legal pages, `README.md`, and this file's title —
codebase text only. **Deliberately still untouched**: the live domain
(`front-desk-pro-ten.vercel.app` → `jobitready.com` in Vercel's domain
settings, `SITE_URL`, the sitemap, `robots.txt`, `llms.txt`), and anything
that embeds the literal `frontdesk.tools` domain (`mock-data.ts`'s widget
snippet and `quoteLink()`, and the `legal@`/`privacy@frontdesk.tools`
mailto addresses in the legal pages) — those move together once the domain
switch is separately approved. Also untouched: `package.json`'s
`"name": "front-desk-pro"` and the repo/folder name — internal identifiers,
not customer-facing. **The underlying product concept, architecture, and
everything in this file below stays exactly as planned** — this was a
rename, not a re-scope.

## Page by page

### Public marketing

| Route | Status | Notes |
|---|---|---|
| `/` | ✅ | Static marketing page. No backend needed. |
| `/pricing` | ✅ | Solo $8 / Crew $19. **No third "Shop/Custom" tier, by decision** — offering a custom tier before there's real customer data to shape it correctly would mean guessing at a bespoke offering ("a big soup web with custom"); revisit once the customer base is understood. **No free trial, by decision** — the always-open sample dashboard + `/demo` are the "try before you buy" step, so CTAs say "Get started" rather than promising a trial. A generic "Get started" (header, footer, homepage hero — anywhere a price hasn't been shown yet) routes to `/pricing` first; a "Get started" that's already showing a specific price (a pricing-page tier button, or the homepage pricing strip) goes straight to `/signup`. Actual subscribing still happens from `/dashboard/settings/billing` after signup. A later audit caught leftover trial copy on `/signup` itself ("Start your 14 days," "14 days free") that an earlier "trial" keyword search had missed — fixed, since that page's copy didn't contain the word "trial" at all. |
| `/demo` | ✅ | The one fully real, end-to-end flow: photo in, real Claude vision + pricing call out (`getQuoteEstimate`), multi-round clarification, follow-up Q&A. Needs `ANTHROPIC_API_KEY` set to actually return results. |
| `/login` | ✅ | Real Supabase auth (`signInWithPassword`). Needs a Supabase project's URL/key in `.env` to actually authenticate — see README. |
| `/signup` | ✅ | Real Supabase auth (`signUp`, with name/phone stored as user metadata until a real tenant table exists). Navigates to `/dashboard` (or `/login` if email confirmation is on) — not to `/onboarding/business-info`, since that still doesn't exist. |

### Onboarding

| Route | Status | Notes |
|---|---|---|
| `/onboarding` | 🟡 | The 5-step wizard shell (progress stepper: Business → Prices → Branding → Calendar → Done) is built and works. |
| `/onboarding/` | ⬜ | Redirects to `/onboarding/business-info`, which doesn't exist as a file yet. **This redirect is currently broken** — clicking "sign up" today leads to a 404. |
| `/onboarding/business-info`, `/price-sheet`, `/branding`, `/calendar`, `/done` | ⬜ | None of these five step pages have been built. Only the shell around them exists. |

### Dashboard

Every route below now reads real, per-tenant data from Supabase **when signed
in** — and falls back to the same mock data as before when not, so the
open, no-login sample dashboard (`DashboardGate`) keeps working exactly as
it did.

A significant, previously-undiscovered bug pattern was found and fixed this
pass: `/dashboard`, `/dashboard/widget`, `/dashboard/analytics`, and
`DashboardShell`'s sidebar itself were **hardcoded to sample data with no
auth check at all** — a real signed-in business saw the sample "Hale &
Sons Plumbing" data instead of their own. Found incrementally via
production screenshots, then swept comprehensively. All four now follow
the same pattern as `/dashboard/leads` below: fetch real data via
`useAuth()` when signed in, fall back to the unchanged sample data when
not.

| Route | Status | Notes |
|---|---|---|
| `/dashboard` | ✅ real · 🟡 sample | Fixed from the bug above — now fetches `getMyTenant()` + `listMyLeads()` for signed-in users instead of unconditional mock data. Also fixed the "today" request count, which relied on string-matching mock data's crafted "Today, 8:10 AM" strings and would never have matched a real date; real users now see `${leads.length} lead(s) total, ${newCount} still new`. |
| `/dashboard/leads` | ✅ real · 🟡 sample | Signed-in users see their own `leads` table rows via `listMyLeads()`; signed-out visitors see the mock inbox, clearly labeled. |
| `/dashboard/leads/:id` | ✅ real · 🟡 sample | Line items, status, customer name/phone/address, **and now the diagnosis text itself** are all editable, real, tenant-scoped rows (`saveLeadLineItems`, `updateLeadStatus`, `updateLeadContact`, `updateLeadDiagnosis`) for signed-in users. The diagnosis is editable because it's the single source both the message-thread draft and the proposal/invoice's "Diagnosis" section already read from live — correcting it there (with a "Diagnosis edited by you" indicator, same pattern as line items) fixes both at once instead of needing a fix in each place separately. **AI diagnosis ↔ message thread are now linked**: the reply box (a real `Textarea` now, not a single-line input — needed once messages could run multi-line) auto-drafts a customer-facing message from the diagnosis + live line-item total (Spanish or English, matching the language the customer wrote in — reuses `estimate-server.ts`'s `detectLanguage`). When nothing's been edited, a "Matches AI pricing — nothing edited" badge shows and the drafted message is the entire remaining step: press send. Edit a line item and the badge drops and the draft re-computes the new total immediately — still just one click to send. **Share-document hook**: "Share proposal/invoice/receipt" buttons above the composer append a reference line (doc number + total) to the draft — sending here still only saves to `lead_messages`, doesn't push out to WhatsApp yet. A real WhatsApp send-from-dashboard path now exists in code (`sendWhatsAppMessage` in `twilio-server.ts`, used by the inbound webhook below) but this reply box isn't wired to call it yet — untested without real Twilio credentials either way. |
| `/dashboard/leads/:id/proposal`, `/invoice`, `/receipt` | ✅ | Now read the same real lead + real tenant (`useLeadDocument`) instead of a static mock — editing a lead's line items and then generating a document reflects that edit. Tax rate, currency, and business info come from the signed-in tenant, not a hardcoded one. Fixes "known disconnect #2" below for real users. |
| `/dashboard/price-sheet` | ✅ real · 🟡 sample | **One unified shape** (`price_sheet_items`: task/category/keywords/pricing type/min/max/hours) used by both the dashboard table and, going forward, the AI's pricing input — fixes "known disconnect #1" below. Signed-in users edit freely and hit "Save changes" (full replace); signed-out visitors edit the same shape against sample rows. **Real AI-vision price-sheet extraction added**: "Upload a price sheet photo" and a "Import from a web page" panel both call real Claude vision (`extractPriceSheetFromImage`/`extractPriceSheetFromUrl` in `price-sheet-server.ts`) instead of the old non-functional stub — extracted rows are appended for review before saving. The URL importer has an `isSafePublicUrl` SSRF guard and, honestly, can't read client-rendered SPAs (own site's copy says so); a screenshot through the photo importer sidesteps that since it captures post-JS-rendered content. Links out to the new Business Settings page (below) via a header button, with copy explaining why filling in both together matters. |
| `/dashboard/widget` | ✅ real · 🟡 embed script | Fixed from the auth bug above — real `tenant.slug`/`brandColor` for signed-in users. Copy-to-clipboard for embed code and shareable link work. **QR code added**: client-side generation (`qrcode` package, no third-party service) of the shareable quote link, with a "Download PNG" button. The embed code itself still points at `https://cdn.frontdesk.tools/widget.js`, which **doesn't exist** — no real embeddable widget script is deployed anywhere yet (unchanged, see item 11). |
| `/dashboard/analytics` | ✅ real · 🟡 sample | Fixed from the auth bug above — `computeRealAnalytics(leads)` now derives a real funnel (Requests/Quoted/Booked/Won over a real 28-day window), real day-of-week bucketing, real average job value, and real busiest day from actual lead data for signed-in users. Required adding `createdAt` to the `Lead` type and populating it in `listMyLeads()`, since the pre-formatted `requested` display string couldn't be used for date math. Signed-out sample view is byte-for-byte the original hand-authored mock computation. |
| `/dashboard/settings/business` | ✅ real · 🟡 sample | Signed-in users load and save their real `tenants` row (`getMyTenant`/`updateMyTenant`); signed-out visitors see the same form pre-filled with sample data and a toast instead of a real save. |
| `/dashboard/settings/billing` | ✅ real | Fully wired to real Stripe data now, not just checkout — `getMyBillingInfo`/`createBillingPortalSession` (`stripe-server.ts`) read real plan/subscription status from `auth.users.user_metadata` and call the live Stripe API for payment methods + invoices. "Update payment method" opens a real Stripe Billing Portal session instead of a stub toast; invoice "View" links go to real `hosted_invoice_url`s. |
| `/dashboard/settings/qualifications` (**Business Settings**) | ✅ real · 🟡 sample | **New this pass.** What a business can/can't/won't do — Certifications & Qualifications, Specialties, Equipment (all with suggested common chips + free-text add), and Exclusions (free-text only, no suggestions — inherently business-specific). Backed by the new `tenant_capabilities` table (see Database below). This is the hard-boundary signal, separate from the price sheet's softer "relatedness" signal — see the Phase 1.5 section below for why. Links to the new Field Notes page. Nothing reads this table for pricing decisions yet — that's the still-pending decision-engine phase. |

### Backend

| Piece | Status | Notes |
|---|---|---|
| `src/lib/estimate-server.ts` (`getQuoteEstimate`, `getFollowUpAnswer`) | ✅ | The one genuinely real backend. Real Claude API calls, tenant-agnostic (takes price sheet/labor rate/business name as input instead of hardcoding one business). Detects Spanish (ported from Cabos Handyman's `detectSpanish()`) or Hebrew (its own Unicode block — more reliable than the Spanish word-pattern heuristic, no overlap with Latin script) and responds in kind — diagnosis, questions, and follow-up answers all come back in whichever language the customer wrote in. Hebrew is customer-facing detection only — the marketing site and dashboard aren't translated/RTL, which would be a much bigger, separately-justified undertaking. |
| WhatsApp as a real intake channel | ✅ code · 🟡 untested without real credentials | `src/routes/api.whatsapp.webhook.tsx` — a real raw-HTTP webhook (Twilio, not a direct Meta Tech Provider application — faster on-ramp, same idea validated by looking at real DevHubConnect n8n templates, though their actual code wasn't used: both had fake regex "AI" instead of a real model call, an unimplemented storage stub, and a single-tenant schema with no `tenant_id` anywhere). Verifies Twilio's HMAC-SHA1 signature (confirmed correct via a real generated-signature test, not just "looks right"), looks up the tenant by the receiving number (`tenants.whatsapp_number`, new column), and reuses everything already real: `getQuoteEstimate` for actual Claude diagnosis/pricing (not keyword matching), `createLead` for persistence, `sendLeadNotificationEmail`/`sendFollowUpNotificationEmail` for owner notifications. Handles the Cabos Handyman real-world finding directly: a brand-new conversation with no photo gets a first-touch reply asking for one, before any AI call is attempted. A repeat message from the same phone within 48 hours continues the existing lead (`lead_messages`) instead of duplicating it — the one genuinely reusable idea from the templates, reinvented against the real tenant-scoped schema instead of a flat `customers` table. Needs a Twilio account + a WhatsApp-enabled number to actually exercise end to end; the signature algorithm itself is proven correct, everything past that is untestable without real Twilio+Supabase+Anthropic credentials together. Each tenant can now set their own `whatsapp_number`, `labor_rate`, and `service_call_fee` from Business settings (`dashboard.settings.business.tsx` → `tenant-server.ts`'s `getMyTenant`/`updateMyTenant`, same authenticated pattern as every other business field — no raw/unguarded write path). The WhatsApp number is normalized server-side to the bare E.164 form the webhook's lookup expects (strips a "whatsapp:" prefix, assumes a US/Canada country code on a bare 10-digit number) before saving, so what the business types and what the webhook looks up actually match. A `/get-started` screen now runs right after signup (redirect in `signup.tsx`) surfacing labor rate/service call fee/WhatsApp number before the empty dashboard, with "Skip for now"; Settings has the same fields plus a Requested/Invalid/Not set status pill. Both are explicit that this is a manual request, not live self-serve, until the real integration below exists — copy says "we'll reach out to connect it," not "connected." **Real self-serve architecture is Twilio's WhatsApp Tech Provider Program + Meta Embedded Signup (v4 — v2/v3 retire 2026-10-15), confirmed against Twilio's current docs, not a dead end requiring manual concierge forever**: the customer authorizes their own WABA/number inside FrontDesk via a Meta-hosted popup, never sees a Twilio SID; FrontDesk then creates a per-customer Twilio subaccount and registers the sender via Twilio's Senders API. Requires Meta Business Verification for FrontDesk itself plus Twilio Tech Provider approval (Twilio's own docs: ~3-4 weeks) before any customer can use it — that approval process is a pure-calendar-time external dependency, worth starting regardless of when the engineering gets built. Real design implications for later: a `whatsapp_connections` table (not columns on `tenants`) holding `phone_number`/`waba_id`/`twilio_subaccount_sid`/`twilio_subaccount_auth_token` (server-only, same handling as `SUPABASE_SERVICE_ROLE_KEY`)/`whatsapp_sender_sid`/`status`, since sends and inbound-signature verification both become per-tenant-subaccount instead of the single global `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`; sender activation has no push webhook (Twilio confirms status webhooks cover messages, not sender state), so activation needs polling. The current `tenants.whatsapp_number` field and the webhook's lookup-by-number logic aren't throwaway — once real per-tenant numbers exist through this flow, the same lookup keeps working; only where the number comes from changes. |
| Rate limiting | 🟡 | A single global counter (20 requests/minute across every visitor) — a blunt anti-abuse measure, not a real per-tenant quota. (No trial enforcement needed — there is no trial.) |
| Auth / sessions | ✅ | Real Supabase Auth — `src/integrations/supabase/` (client, server-side `requireSupabaseAuth` middleware for gating server functions, client-side `attachSupabaseAuth` that auto-attaches the session token to every server-function call). Ported from a working pattern in the `buildraid` repo, wired to FrontDesk's **own**, separate Supabase project — not shared with any other app. |
| Database | ✅ core tables · 🟡 not everything reads from it yet | `supabase/migrations/0001_init.sql` defines `tenants`, `price_sheet_items`, `leads`, `lead_line_items`, `lead_messages` — all RLS-scoped to the signed-in user's own tenant, with a trigger that auto-creates a tenant row on signup (no onboarding wizard needed just to get *a* tenant to read/write). `0002_whatsapp.sql`/`0003_whatsapp_connections.sql` add WhatsApp routing (see the WhatsApp row above). `0004_business_capabilities.sql` (`tenant_capabilities` — applied and verified) and `0005_field_notes.sql` (`field_notes` — applied and verified, application layer not built yet) are new this pass — see Phase 1.5 below. `src/lib/tenant-server.ts`, `price-sheet-server.ts`, `leads-server.ts`, `capabilities-server.ts` are the auth-gated server functions the dashboard pages above call. Not yet wired to the database: the AI's live pricing input (`estimate-server.ts` still uses `SAMPLE_PRICE_SHEET`, since `/demo` isn't tenant-scoped yet — see Phase 1, step 9 below). |
| Billing (Stripe) | ✅ | Real Checkout session creation, a real Billing Portal session, and real payment-method/invoice reads (`src/lib/stripe-server.ts`, auth-gated) plus a real webhook (`src/routes/api.stripe.webhook.tsx`) that verifies Stripe's signature and records the plan on the user via Supabase's admin API. Subscription status lives in Supabase `user_metadata` for now — a real `subscriptions` table is worth it once the rest of the data model exists, but wasn't needed to make this real. |
| Email notifications | ✅ mechanism · 🟡 not triggered by anything real yet | `src/lib/notify-server.ts`'s `sendLeadNotificationEmail` — ported directly from Cabos Handyman's own working `api/send-booking-email.js` (same nodemailer + Gmail App Password approach, same HTML-escaping of user-supplied text before interpolation). Fires the moment a lead is created, not gated behind an actual confirmed booking — same real pattern Cabos already uses in production. Needs `NOTIFICATION_FROM_EMAIL` + `EMAIL_APP_PASSWORD` set (a Gmail account + an App Password, not a real password — no Meta-style business verification needed, this is the easy piece). SMS still doesn't exist. |
| Legal pages (Privacy Policy, Terms) | ✅ | `/privacy` and `/terms` now exist as real pages; footer's old "Austin, Texas" line replaced with links to both. |
| Customer-facing "remote estimate" disclaimer | ✅ | Every place a customer actually receives a price — the proposal document (`BusinessDocument.tsx`), the WhatsApp webhook's two outbound quote messages, and the dashboard's auto-drafted suggested reply (English + Spanish, `reply-composer.ts`) — now states the price is estimated from photos/description and may change after an on-site inspection. Deliberately not added to invoices/receipts (confirmed work, not an estimate) or internal-only displays. |

## Known disconnects

1. ~~**Two separate price sheets.**~~ ✅ Fixed for real users — `price_sheet_items` is now the one shape both the dashboard table and the AI-facing type (`PriceSheetItem` in `estimate-server.ts`) share structurally. What's *not* done: `estimate-server.ts` itself still calls `SAMPLE_PRICE_SHEET` rather than a tenant's real `price_sheet_items` rows, because the AI flow (`/demo`) isn't tenant-scoped yet — that's Phase 1, step 9 below, the public per-tenant quote page.
2. ~~**Editing a lead doesn't reach its documents.**~~ ✅ Fixed for real users — line-item edits on `/dashboard/leads/:id` persist to `lead_line_items`, and the proposal/invoice/receipt routes read the same row via `useLeadDocument`, so a document always reflects the latest saved edit.
3. **`/demo` still doesn't persist a lead.** Running the AI flow on the *sample* demo returns a result to the browser and it vanishes. What's now real: `src/lib/public-lead-server.ts`'s `createLead` — a public, unauthenticated server function (service-role client, since an anonymous customer has no Supabase session to satisfy the tenant-owner RLS policies) that saves a real lead + line items against a tenant found by slug, and fires the notification email below. It just has no caller yet — `/demo` isn't tenant-scoped, and the public per-tenant quote page (item 10) doesn't exist. Test it today via "Send yourself a test lead" on `/dashboard/leads`.

## The game plan, in dependency order

Everything below the first item is blocked on it, so it's the actual unlock. This
list is the single source of truth for "what's next" — when a step is done, mark
it `~~done~~` ✅ here rather than tracking progress anywhere else.

### Phase 0 — Go live (nothing below matters until this exists)

Corrected September 2026: the first audit pass wrongly said "never deployed" —
it only checked for a local Vercel CLI link (`.vercel/project.json`), which
stays empty even for a real deployment made through Vercel's GitHub
integration (import repo → auto-deploy on every push, no local CLI involved).
**The site is actually already live** at
`https://front-desk-pro-ten.vercel.app` and serving real 200s on `/`,
`/pricing`, `/dashboard`. Verified against the live URL directly: signup/login
throw "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY" — so the
deploy itself is done, but **none of the real environment variables are set
on Vercel yet**. That's the actual remaining Phase 0 work.

1. ~~**Deploy to Vercel.**~~ ✅ Done — already live via Vercel's GitHub integration, auto-deploying on push to `main`.
2. **Create the real Supabase project** and run `supabase/migrations/0001_init.sql` against it (in progress).
3. **Set every real environment variable on Vercel** (Project Settings → Environment Variables): `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (from the Supabase project above), `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (from a real Stripe webhook endpoint pointed at the live URL, not `stripe listen`), and `SITE_URL` set to the real deployed URL.
4. **Get a real domain and point it at the deployment** — `frontdesk.tools` doesn't currently resolve to anything; confirm whether it's actually owned yet, then add it in Vercel's domain settings and update `SITE_URL`, the sitemap, `llms.txt`, and the JSON-LD schema's placeholder URLs to match.
5. **Smoke-test the live URL end to end**: sign up, log in, run `/demo`, start a Stripe checkout in test mode, confirm the webhook fires against the real deployed webhook URL (not `stripe listen` to localhost anymore).

### Phase 1 — Close the self-serve loop

Right now a stranger can sign up and explore the dashboard, but there's no way
for *their* customers to actually submit a photo against *their* price sheet —
the core product loop isn't closed for a real, unassisted business yet. This
phase closes it.

6. ~~**Auth.**~~ ✅ Done — real Supabase Auth, `/login`/`/signup` work, `/dashboard/*` is gated.
7. ~~**Database: tenants, leads, price sheet.**~~ ✅ Done — `supabase/migrations/0001_init.sql` plus the server-function layer (`tenant-server.ts`, `price-sheet-server.ts`, `leads-server.ts`), wired into settings/business, price-sheet, and the leads list/detail/documents pages.
8. **Build the five missing onboarding pages.** A tenant row now exists automatically from the moment someone signs up (see the `handle_new_user` trigger), so this is purely about the wizard UI writing to an already-real `tenants` row. Fixes the broken `/onboarding/` redirect as a side effect (confirmed still broken — `/onboarding/business-info` has no route file, so it 404s today).
9. **Wire `estimate-server.ts` to a tenant's real `price_sheet_items`** instead of `SAMPLE_PRICE_SHEET`, and **persist a real estimate as a lead** — both blocked on the same thing: nothing is tenant-scoped yet (see step 10).
10. **Build the public per-tenant quote page** (`/quote/:slug`) — right now `/demo` is the only customer-facing flow, and it's hardcoded to one sample business, not addressable per real tenant.
11. **Build the actual embeddable widget script** that `/dashboard/widget`'s embed code currently just references (`https://cdn.frontdesk.tools/widget.js`) but doesn't back.
12. ~~**Stripe billing.**~~ ✅ Checkout + webhook are real, and trial-day tracking is a non-issue by decision — there's no trial. Still ahead: invoice history pulled from Stripe instead of mock rows.

### Phase 1.5 — Scope-aware AI pricing (in progress)

Prompted by a real WhatsApp conversation showing a job (a refrigerator
compressor issue) the AI could describe but the business shouldn't
auto-quote. The product needed a way to distinguish "what we charge" from
"what we do/don't do" from "what we've learned" — three separate,
increasingly soft signals feeding one pricing decision. Full architecture
lives in `/Users/edgartamarind/.claude/plans/zazzy-booping-kite.md`.

- **Business Capabilities** ✅ done — `tenant_capabilities` table
  (certifications/specialties/equipment/exclusions), `capabilities-server.ts`,
  and the `/dashboard/settings/qualifications` page above. This is the hard
  boundary: a certification you don't have, or an exclusion you've stated,
  should stop an automatic quote.
- **Field Notes** 🟡 in progress — `field_notes` table (`0005_field_notes.sql`,
  applied and verified) stores an unlimited, business-specific knowledge log:
  the owner's original note body *and* an AI-generated summary/keywords as
  separate columns, so the summary can never overwrite the owner's own
  wording. Strictly contextual by design — writing a note can never itself
  create a capability, exclusion, or price. **Not yet built**:
  `field-notes-server.ts` (list/create-with-synchronous-AI-summary/delete)
  and the `/dashboard/settings/field-notes.tsx` page (monthly-prompt panel +
  entry list), plus a link to it from the Qualifications page.
- **The decision engine** ⬜ not started — `estimate-server.ts` needs a
  6-step reasoning sequence (understand the problem → identify the actual
  work required, reasoned rather than keyword-triggered → check against
  capabilities/exclusions → check price-sheet relatedness → check
  information sufficiency → only then price) and a `needsReview` result
  shape for when it can't safely quote.
- **The flag/review loop** ⬜ not started — `flagged` leads (with a
  `flag_type`: missing capability, outside service scope, hazardous/
  specialized, or conflicting information), owner-facing resolution
  (dismiss, or add the capability), and the load-bearing rule that **adding
  a capability never auto-quotes the lead that triggered it** — the owner
  always prices or explicitly re-triggers the AI.

Each of the four sub-items above is being built and approved separately,
in that order — this file will move each to ✅ as it lands.

### Phase 2 — Trust & compliance

13. ~~**Email notifications for new leads.**~~ ✅ Mechanism done (`notify-server.ts` + `public-lead-server.ts`'s `createLead`, ported from Cabos Handyman's real, already-working pattern) — needs a Gmail App Password to actually send, and a real caller once the public quote page (item 10) exists. SMS still not built.
14. ~~**Privacy Policy and Terms of Service.**~~ ✅ Done — `/privacy` and `/terms` are real pages, linked from the footer.
15. **Finish broadening "trades" wording** — the hero eyebrow and enumerated trade lists were broadened past the original 4 trades, but the word "trades" itself is still load-bearing in the browser tab title, the pricing page title, and the footer tagline. Still an open question, not yet decided either way.

### Phase 3 — Play Store app

Recap of the earlier decision: this is the **owner's pocket app** — lead inbox, approve/edit an estimate, generate documents, push notifications the moment a lead lands. It is *not* a wrapper around the customer-facing quote flow, which stays a zero-install web link (confirmed via researching how getjunkq.com does this — they don't actually use WhatsApp as a backend either, "WhatsApp-style chatbot" describes their UI styling only, not their real intake mechanism).

16. **A real API surface.** A native app (Flutter/React Native) can't call `createServerFn` the way this web app's browser client does — it needs plain JSON HTTP endpoints for login, lead list/detail, and document generation.
17. **Push notification infrastructure** — APNs for iOS, FCM for Android — tied to a "new lead created" event (built in step 9/step 13).
18. **A path decision**: *Trusted Web Activity* (fastest, wraps the real dashboard as an installable Android app, limited push/offline support) vs. *Flutter* (more capable, full native push/offline — there's an idle Flutter + Supabase scaffold in `resume_builder_pro` from an earlier project that could be the starting shell).
19. **Play Store logistics** — a Google Play developer account, app icons/screenshots for the listing, and the Privacy Policy from Phase 2.