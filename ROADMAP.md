# FrontDesk — build status and game plan

Legend: ✅ real and working · 🟡 built, but mocked/disconnected from a real backend · ⬜ not built yet

Last updated: September 2026, after wiring the real Supabase database in place of `mock-data.ts`.

## Page by page

### Public marketing

| Route | Status | Notes |
|---|---|---|
| `/` | ✅ | Static marketing page. No backend needed. |
| `/pricing` | ✅ | Solo $19 / Crew $39 / Shop Custom. **No free trial, by decision** — the always-open sample dashboard + `/demo` are the "try before you buy" step, so CTAs say "Get started" (→ `/signup`) rather than promising a trial. Actual subscribing still happens from `/dashboard/settings/billing` after signup, not on this page directly. |
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

| Route | Status | Notes |
|---|---|---|
| `/dashboard` | 🟡 | Real UI (stats, recent activity, widget copy buttons). Still reads mock data unconditionally — the overview stats/charts weren't part of this pass, only leads/price-sheet/settings were. |
| `/dashboard/leads` | ✅ real · 🟡 sample | Signed-in users see their own `leads` table rows via `listMyLeads()`; signed-out visitors see the mock inbox, clearly labeled. |
| `/dashboard/leads/:id` | ✅ real · 🟡 sample | Line items, status, **and now customer name/phone/address** are all editable, real, tenant-scoped rows (`saveLeadLineItems`, `updateLeadStatus`, `updateLeadContact`) for signed-in users — added since a WhatsApp/widget-captured name isn't always the actual customer (e.g. a rental's property manager texting on a tenant's behalf), and there was previously no way to correct it. **AI diagnosis ↔ message thread are now linked**: the reply box (a real `Textarea` now, not a single-line input — needed once messages could run multi-line) auto-drafts a customer-facing message from the diagnosis + live line-item total (Spanish or English, matching the language the customer wrote in — reuses `estimate-server.ts`'s `detectLanguage`). When nothing's been edited, a "Matches AI pricing — nothing edited" badge shows and the drafted message is the entire remaining step: press send. Edit a line item and the badge drops and the draft re-computes the new total immediately — still just one click to send. **Share-document hook**: "Share proposal/invoice/receipt" buttons above the composer append a reference line (doc number + total) to the draft — a UI-only hook for now, since sending still only saves to `lead_messages`, not to a real customer (see "WhatsApp as a real intake channel" below); it'll do something end-to-end once an outbound channel exists. |
| `/dashboard/leads/:id/proposal`, `/invoice`, `/receipt` | ✅ | Now read the same real lead + real tenant (`useLeadDocument`) instead of a static mock — editing a lead's line items and then generating a document reflects that edit. Tax rate, currency, and business info come from the signed-in tenant, not a hardcoded one. Fixes "known disconnect #2" below for real users. |
| `/dashboard/price-sheet` | ✅ real · 🟡 sample | **One unified shape** (`price_sheet_items`: task/category/keywords/pricing type/min/max/hours) used by both the dashboard table and, going forward, the AI's pricing input — fixes "known disconnect #1" below. Signed-in users edit freely and hit "Save changes" (full replace); signed-out visitors edit the same shape against sample rows. |
| `/dashboard/widget` | 🟡 | Copy-to-clipboard for embed code and shareable link work. The embed code points at `https://cdn.frontdesk.tools/widget.js`, which **doesn't exist** — there's no real embeddable widget script deployed anywhere yet. |
| `/dashboard/analytics` | 🟡 | Real charts (recharts), rendering mock funnel/weekday data. No real analytics pipeline. |
| `/dashboard/settings/business` | ✅ real · 🟡 sample | Signed-in users load and save their real `tenants` row (`getMyTenant`/`updateMyTenant`); signed-out visitors see the same form pre-filled with sample data and a toast instead of a real save. |
| `/dashboard/settings/billing` | ✅ checkout · 🟡 rest | "Switch to Solo/Crew" starts a real Stripe subscription Checkout session, email pulled server-side from the authenticated Supabase user — nothing to type twice. "Update payment method" and invoice "Download" still honestly show "not wired up yet." |

### Backend

| Piece | Status | Notes |
|---|---|---|
| `src/lib/estimate-server.ts` (`getQuoteEstimate`, `getFollowUpAnswer`) | ✅ | The one genuinely real backend. Real Claude API calls, tenant-agnostic (takes price sheet/labor rate/business name as input instead of hardcoding one business). Detects Spanish (ported from Cabos Handyman's `detectSpanish()`) or Hebrew (its own Unicode block — more reliable than the Spanish word-pattern heuristic, no overlap with Latin script) and responds in kind — diagnosis, questions, and follow-up answers all come back in whichever language the customer wrote in. Hebrew is customer-facing detection only — the marketing site and dashboard aren't translated/RTL, which would be a much bigger, separately-justified undertaking. |
| WhatsApp as a real intake channel | ⬜ | Still not built — Meta's Business API needs its own verification process. What exists now is a sample lead (`L-2845`, Marisol Vega) in the dashboard showing what a WhatsApp-sourced, Spanish-language conversation would look like once it is, so prospects can see the payoff before it's real. |
| Rate limiting | 🟡 | A single global counter (20 requests/minute across every visitor) — a blunt anti-abuse measure, not a real per-tenant quota. (No trial enforcement needed — there is no trial.) |
| Auth / sessions | ✅ | Real Supabase Auth — `src/integrations/supabase/` (client, server-side `requireSupabaseAuth` middleware for gating server functions, client-side `attachSupabaseAuth` that auto-attaches the session token to every server-function call). Ported from a working pattern in the `buildraid` repo, wired to FrontDesk's **own**, separate Supabase project — not shared with any other app. |
| Database | ✅ core tables · 🟡 not everything reads from it yet | `supabase/migrations/0001_init.sql` defines `tenants`, `price_sheet_items`, `leads`, `lead_line_items`, `lead_messages` — all RLS-scoped to the signed-in user's own tenant, with a trigger that auto-creates a tenant row on signup (no onboarding wizard needed just to get *a* tenant to read/write). `src/lib/tenant-server.ts`, `price-sheet-server.ts`, `leads-server.ts` are the auth-gated server functions the dashboard pages above call. Not yet wired to the database: the `/dashboard` overview stats, `/dashboard/analytics`, and the AI's live pricing input (`estimate-server.ts` still uses `SAMPLE_PRICE_SHEET`, since `/demo` isn't tenant-scoped yet — see game plan item 5). |
| Billing (Stripe) | ✅ | Real Checkout session creation (`src/lib/stripe-server.ts`, auth-gated) and a real webhook (`src/routes/api.stripe.webhook.tsx`) that verifies Stripe's signature and records the plan on the user via Supabase's admin API. Subscription status lives in Supabase `user_metadata` for now — a real `subscriptions` table is worth it once the rest of the data model exists, but wasn't needed to make this real. |
| Email/SMS notifications | ⬜ | Doesn't exist — "new lead" alerts aren't sent anywhere. |
| Legal pages (Privacy Policy, Terms) | ⬜ | Don't exist. Needed before real signups collect real customer data, and required for Play Store submission later. |

## Known disconnects

1. ~~**Two separate price sheets.**~~ ✅ Fixed for real users — `price_sheet_items` is now the one shape both the dashboard table and the AI-facing type (`PriceSheetItem` in `estimate-server.ts`) share structurally. What's *not* done: `estimate-server.ts` itself still calls `SAMPLE_PRICE_SHEET` rather than a tenant's real `price_sheet_items` rows, because the AI flow (`/demo`) isn't tenant-scoped yet — that's game plan item 5 below, the public per-tenant quote page.
2. ~~**Editing a lead doesn't reach its documents.**~~ ✅ Fixed for real users — line-item edits on `/dashboard/leads/:id` persist to `lead_line_items`, and the proposal/invoice/receipt routes read the same row via `useLeadDocument`, so a document always reflects the latest saved edit.
3. **A real `/demo` estimate never becomes a lead.** Running the AI flow returns a result to the browser and it vanishes — it doesn't get saved anywhere `/dashboard/leads` would show it. Still open — same root cause as #1: `/demo` has no tenant to attach a lead to yet.

## The game plan, in dependency order

Everything below the first item is blocked on it, so it's the actual unlock:

1. ~~**Auth.**~~ ✅ Done — real Supabase Auth, `/login`/`/signup` work, `/dashboard/*` is gated.
2. ~~**Database: tenants, leads, price sheet.**~~ ✅ Done — `supabase/migrations/0001_init.sql` plus the server-function layer (`tenant-server.ts`, `price-sheet-server.ts`, `leads-server.ts`), wired into settings/business, price-sheet, and the leads list/detail/documents pages.
3. **Build the five missing onboarding pages.** A tenant row now exists automatically from the moment someone signs up (see the `handle_new_user` trigger), so this is now purely about the wizard UI writing to an already-real `tenants` row — no longer blocked on the database. Fixes the broken `/onboarding/` redirect as a side effect.
4. **Wire `estimate-server.ts` to a tenant's real `price_sheet_items`** instead of `SAMPLE_PRICE_SHEET`, and **persist a real estimate as a lead** — both blocked on the same thing: `/demo` isn't tenant-scoped yet (see item 5).
5. **Build the public per-tenant quote page** (`/quote/:slug`) — right now `/demo` is the only customer-facing flow, and it's hardcoded to one business, not addressable per real tenant yet.
6. **Build the actual embeddable widget script** that `/dashboard/widget`'s embed code currently just references but doesn't back.
7. ~~**Stripe billing.**~~ ✅ Checkout + webhook are real, and trial-day tracking is a non-issue by decision — there's no trial. Still ahead: invoice history pulled from Stripe instead of mock rows.
8. **Email/SMS notifications** for new leads.
9. **Privacy Policy and Terms of Service** — needed before any of this touches a real customer's data, and non-negotiable for Play Store submission.

## What the Play Store app needs

Recap of the earlier decision: this is the **owner's pocket app** — lead inbox, approve/edit an estimate, generate documents, push notifications the moment a lead lands. It is *not* a wrapper around the customer-facing quote flow, which should stay a zero-install web link.

Building it now, before the items above, would mean building a mobile app against data that isn't real yet — so it's correctly sequenced *after* steps 1–2 (auth + database) at minimum, and ideally after step 4 (real leads existing at all). Once that foundation exists, here's what's specifically needed:

- **A real API surface.** A native app (Flutter/React Native) can't call `createServerFn` the way this web app's browser client does — it needs plain JSON HTTP endpoints for login, lead list/detail, and document generation. Some API work is required regardless of which mobile path gets picked.
- **Push notification infrastructure** — APNs for iOS, FCM for Android — tied to a "new lead created" event, which itself depends on step 4 above existing.
- **A path decision**, revisited once there's something real to wrap:
  - *Trusted Web Activity (fastest)* — wraps the real dashboard as an installable Android app. Limited push/offline support.
  - *Flutter (more capable)* — full native push and offline support. There's already an idle Flutter + Supabase scaffold in `resume_builder_pro` from an earlier project that could be the starting shell instead of starting from zero.
- **Play Store logistics** — a Google Play developer account, app icons/screenshots for the listing, and the Privacy Policy from the plan above (Play Store submission requires one).
