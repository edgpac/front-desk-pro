# FrontDesk — build status and game plan

Legend: ✅ real and working · 🟡 built, but mocked/disconnected from a real backend · ⬜ not built yet

Last updated: September 2026, after the dashboard + documents build-out.

## Page by page

### Public marketing

| Route | Status | Notes |
|---|---|---|
| `/` | ✅ | Static marketing page. No backend needed. |
| `/pricing` | ✅ | Solo $19 / Crew $39 / Shop Custom. "Start free trial" just navigates to `/signup` — no Stripe checkout yet. |
| `/demo` | ✅ | The one fully real, end-to-end flow: photo in, real Claude vision + pricing call out (`getQuoteEstimate`), multi-round clarification, follow-up Q&A. Needs `ANTHROPIC_API_KEY` set to actually return results. |
| `/login` | 🟡 | Real form UI, but the submit handler doesn't check anything — it just navigates to `/dashboard` regardless of what's typed. No authentication exists. |
| `/signup` | 🟡 | Same story — the form doesn't create an account. It navigates to `/onboarding/business-info`, which currently 404s (see below). |

### Onboarding

| Route | Status | Notes |
|---|---|---|
| `/onboarding` | 🟡 | The 5-step wizard shell (progress stepper: Business → Prices → Branding → Calendar → Done) is built and works. |
| `/onboarding/` | ⬜ | Redirects to `/onboarding/business-info`, which doesn't exist as a file yet. **This redirect is currently broken** — clicking "sign up" today leads to a 404. |
| `/onboarding/business-info`, `/price-sheet`, `/branding`, `/calendar`, `/done` | ⬜ | None of these five step pages have been built. Only the shell around them exists. |

### Dashboard (currently: one hardcoded demo tenant, "Hale & Sons Plumbing")

| Route | Status | Notes |
|---|---|---|
| `/dashboard` | 🟡 | Real UI (stats, recent activity, widget copy buttons), reading from mock data (`LEADS`, `TENANT`). **Not login-gated** — this URL is fully public right now, no session check at all. |
| `/dashboard/leads` | 🟡 | Real filtering/search, against mock `LEADS`. |
| `/dashboard/leads/:id` | 🟡 | Fully editable line items (description/qty/unit/rate, add/remove), status changer, message thread — all real interactions, but local component state only. Nothing is saved anywhere; refresh and it's gone. |
| `/dashboard/leads/:id/proposal`, `/invoice`, `/receipt` | ✅ UI · 🟡 data | The documents themselves are real — correct math, tax handling, currency, PNG export (html2canvas-pro) and print-to-PDF both verified working. But they render from the same static mock lead, not from whatever you edited on the detail page a moment ago (see "Known disconnects" below). |
| `/dashboard/price-sheet` | 🟡 | Editable UI, but **writes to a different, disconnected data set** than the one the AI actually prices against — see "Known disconnects." |
| `/dashboard/widget` | 🟡 | Copy-to-clipboard for embed code and shareable link work. The embed code points at `https://cdn.frontdesk.tools/widget.js`, which **doesn't exist** — there's no real embeddable widget script deployed anywhere yet. |
| `/dashboard/analytics` | 🟡 | Real charts (recharts), rendering mock funnel/weekday data. No real analytics pipeline. |
| `/dashboard/settings/business` | 🟡 | Fully built — every field a document needs, all required, Save is properly gated. Save doesn't persist anywhere yet; it's a toast. |
| `/dashboard/settings/billing` | 🟡 | Mock plan/invoice display. "Change plan," "Update payment method," and "Download" all honestly show "not wired up yet" — no Stripe integration exists. |

### Backend

| Piece | Status | Notes |
|---|---|---|
| `src/lib/estimate-server.ts` (`getQuoteEstimate`, `getFollowUpAnswer`) | ✅ | The one genuinely real backend. Real Claude API calls, tenant-agnostic (takes price sheet/labor rate/business name as input instead of hardcoding one business). |
| Rate limiting | 🟡 | A single global counter (20 requests/minute across every visitor) — a blunt anti-abuse measure, not a real per-tenant quota or trial enforcement. |
| Auth / sessions | ⬜ | Doesn't exist. No user accounts, no password hashing, no session cookies, nothing. |
| Database | ⬜ | Doesn't exist. Every piece of "data" in the app (`mock-data.ts`) is a hardcoded in-memory array. |
| Billing (Stripe) | ⬜ | Doesn't exist. |
| Email/SMS notifications | ⬜ | Doesn't exist — "new lead" alerts aren't sent anywhere. |
| Legal pages (Privacy Policy, Terms) | ⬜ | Don't exist. Needed before real signups collect real customer data, and required for Play Store submission later. |

## Known disconnects (worth fixing even before new features)

These aren't missing features so much as two things that look connected but aren't:

1. **Two separate price sheets.** `/dashboard/price-sheet` edits `PRICE_SHEET` (shape: service/category/pricing/price — a display list). The actual AI pricing call uses `SAMPLE_PRICE_SHEET` in `estimate-server.ts` (shape: task/keywords/priceMin/priceMax/hours — what the prompt is built from). Editing one does nothing to the other today.
2. **Editing a lead doesn't reach its documents.** The line-item edits on `/dashboard/leads/:id` are local state; the proposal/invoice/receipt routes independently re-fetch the same static lead. Once there's a real data layer this becomes one shared record instead of two reads of a hardcoded array.
3. **A real `/demo` estimate never becomes a lead.** Running the AI flow returns a result to the browser and it vanishes — it doesn't get saved anywhere `/dashboard/leads` would show it.

## The game plan, in dependency order

Everything below the first item is blocked on it, so it's the actual unlock:

1. **Auth + a real database.** Recommend Supabase — it's already the tool in both `caboshandyman.com` and `cabos-handyman-management`, so it's zero new platform to learn. This single piece turns `mock-data.ts` into real tables (tenants, leads, price sheet items) and makes `/login`, `/signup`, and gating `/dashboard/*` behind a session all possible at once.
2. **Build the five missing onboarding pages**, writing to the new tenant table from step 1. Fixes the broken `/onboarding/` redirect as a side effect.
3. **Unify the two price sheets** into one real, tenant-owned table that both the dashboard page and `estimate-server.ts` read from.
4. **Persist a real estimate as a lead.** When `/demo` (or a future public per-tenant quote page) produces a result, save it instead of letting it evaporate.
5. **Build the public per-tenant quote page** (`/quote/:slug`) — right now `/demo` is the only customer-facing flow, and it's hardcoded to one business, not addressable per real tenant yet.
6. **Build the actual embeddable widget script** that `/dashboard/widget`'s embed code currently just references but doesn't back.
7. **Stripe billing** — real trial tracking, plan changes, invoice history.
8. **Email/SMS notifications** for new leads.
9. **Privacy Policy and Terms of Service** — needed before any of this touches a real customer's data, and non-negotiable for Play Store submission.

## What the Play Store app needs

Recap of the earlier decision: this is the **owner's pocket app** — lead inbox, approve/edit an estimate, generate documents, push notifications the moment a lead lands. It is *not* a wrapper around the customer-facing quote flow, which should stay a zero-install web link.

Building it now, before the items above, would mean building a mobile app against data that isn't real yet — so it's correctly sequenced *after* step 1 (auth + database) at minimum, and ideally after step 4 (real leads existing at all). Once that foundation exists, here's what's specifically needed:

- **A real API surface.** A native app (Flutter/React Native) can't call `createServerFn` the way this web app's browser client does — it needs plain JSON HTTP endpoints for login, lead list/detail, and document generation. Some API work is required regardless of which mobile path gets picked.
- **Push notification infrastructure** — APNs for iOS, FCM for Android — tied to a "new lead created" event, which itself depends on step 4 above existing.
- **A path decision**, revisited once there's something real to wrap:
  - *Trusted Web Activity (fastest)* — wraps the real dashboard as an installable Android app. Limited push/offline support.
  - *Flutter (more capable)* — full native push and offline support. There's already an idle Flutter + Supabase scaffold in `resume_builder_pro` from an earlier project that could be the starting shell instead of starting from zero.
- **Play Store logistics** — a Google Play developer account, app icons/screenshots for the listing, and the Privacy Policy from the plan above (Play Store submission requires one).
