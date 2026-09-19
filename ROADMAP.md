# Job It Ready (formerly FrontDesk) — build status and game plan

Legend: ✅ real and working · 🟡 built, but mocked/disconnected from a real backend · ⬜ not built yet

Last updated: September 19, 2026 — the Meta WhatsApp integration's core
pipeline went fully live (app Published, a real number connected and
proven end-to-end across multiple job types), plus connection-failure
alerting, the AI no longer going silent on repeat customers, and the AI
no longer inventing prices for anything off the price sheet — see the
bottom of the Meta WhatsApp Embedded Signup row under Backend, and the
flagged-leads section under Phase 1.5. Remaining gate: Advanced Access
for genuine third-party self-serve onboarding (also documented there).
Before that (September 6, 2026): the codebase text rename from FrontDesk to
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
codebase text only. **Domain switch, 2026-09-08**: `jobitready.com` /
`www.jobitready.com` are now live in Vercel's domain settings (apex
redirects to `www`, which serves Production) — `generate-sitemap.js`,
`robots.txt`'s `Sitemap:` line, `llms.txt`, and `mock-data.ts`'s widget
snippet/`quoteLink()` all now point at `www.jobitready.com` instead of the
old `frontdesk.tools` placeholder. **`SITE_URL` fixed** — confirmed set in
Vercel's production environment variables as of this 2026-09-14 audit (was
missing when first flagged 2026-09-08/09; `stripe-server.ts`'s Checkout
redirect URLs are no longer falling back to `localhost:8080` in
production). **Still open**: the `legal@`/`privacy@frontdesk.tools` mailto
addresses in the legal pages haven't moved to `@jobitready.com` pending
confirmation that mailboxes actually exist there. Also untouched: `package.json`'s
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
| `/dashboard/widget` | ✅ real · 🟡 embed script | Fixed from the auth bug above — real `tenant.slug`/`brandColor` for signed-in users. Copy-to-clipboard for embed code and shareable link work. **QR code added**: client-side generation (`qrcode` package, no third-party service) of the shareable quote link, with a "Download PNG" button. The embed code itself still points at `https://cdn.jobitready.com/widget.js`, which **doesn't exist** — no real embeddable widget script is deployed anywhere yet (unchanged, see item 11). |
| `/dashboard/analytics` | ✅ real · 🟡 sample | Fixed from the auth bug above — `computeRealAnalytics(leads)` now derives a real funnel (Requests/Quoted/Booked/Won over a real 28-day window), real day-of-week bucketing, real average job value, and real busiest day from actual lead data for signed-in users. Required adding `createdAt` to the `Lead` type and populating it in `listMyLeads()`, since the pre-formatted `requested` display string couldn't be used for date math. Signed-out sample view is byte-for-byte the original hand-authored mock computation. |
| `/dashboard/settings/business` | ✅ real · 🟡 sample | Signed-in users load and save their real `tenants` row (`getMyTenant`/`updateMyTenant`); signed-out visitors see the same form pre-filled with sample data and a toast instead of a real save. |
| `/dashboard/settings/billing` | ✅ real | Fully wired to real Stripe data now, not just checkout — `getMyBillingInfo`/`createBillingPortalSession` (`stripe-server.ts`) read real plan/subscription status from `auth.users.user_metadata` and call the live Stripe API for payment methods + invoices. "Update payment method" opens a real Stripe Billing Portal session instead of a stub toast; invoice "View" links go to real `hosted_invoice_url`s. |
| `/dashboard/settings/qualifications` (**Business Settings**) | ✅ real · 🟡 sample | **New this pass.** What a business can/can't/won't do — Certifications & Qualifications, Specialties, Equipment (all with suggested common chips + free-text add), and Exclusions (free-text only, no suggestions — inherently business-specific). Backed by the new `tenant_capabilities` table (see Database below). This is the hard-boundary signal, separate from the price sheet's softer "relatedness" signal — see the Phase 1.5 section below for why. Links to the new Field Notes page. Nothing reads this table for pricing decisions yet — that's the still-pending decision-engine phase. |

### Backend

| Piece | Status | Notes |
|---|---|---|
| `src/lib/estimate-server.ts` (`getQuoteEstimate`, `getFollowUpAnswer`) | ✅ | The one genuinely real backend. Real Claude API calls, tenant-agnostic (takes price sheet/labor rate/business name as input instead of hardcoding one business). Detects Spanish (ported from Cabos Handyman's `detectSpanish()`) or Hebrew (its own Unicode block — more reliable than the Spanish word-pattern heuristic, no overlap with Latin script) and responds in kind — diagnosis, questions, and follow-up answers all come back in whichever language the customer wrote in. Hebrew is customer-facing detection only — the marketing site and dashboard aren't translated/RTL, which would be a much bigger, separately-justified undertaking. |
| WhatsApp as a real intake channel | ✅ code · 🟡 untested without real credentials | `src/routes/api.whatsapp.webhook.tsx` — a real raw-HTTP webhook (Twilio, not a direct Meta Tech Provider application — faster on-ramp, same idea validated by looking at real DevHubConnect n8n templates, though their actual code wasn't used: both had fake regex "AI" instead of a real model call, an unimplemented storage stub, and a single-tenant schema with no `tenant_id` anywhere). Verifies Twilio's HMAC-SHA1 signature (confirmed correct via a real generated-signature test, not just "looks right"), looks up the tenant by the receiving number (`tenants.whatsapp_number`, new column), and reuses everything already real: `getQuoteEstimate` for actual Claude diagnosis/pricing (not keyword matching), `createLead` for persistence, `sendLeadNotificationEmail`/`sendFollowUpNotificationEmail` for owner notifications. Handles the Cabos Handyman real-world finding directly: a brand-new conversation with no photo gets a first-touch reply asking for one, before any AI call is attempted. A repeat message from the same phone within 48 hours continues the existing lead (`lead_messages`) instead of duplicating it — the one genuinely reusable idea from the templates, reinvented against the real tenant-scoped schema instead of a flat `customers` table. Needs a Twilio account + a WhatsApp-enabled number to actually exercise end to end; the signature algorithm itself is proven correct, everything past that is untestable without real Twilio+Supabase+Anthropic credentials together. Each tenant can now set their own `whatsapp_number`, `labor_rate`, and `service_call_fee` from Business settings (`dashboard.settings.business.tsx` → `tenant-server.ts`'s `getMyTenant`/`updateMyTenant`, same authenticated pattern as every other business field — no raw/unguarded write path). The WhatsApp number is normalized server-side to the bare E.164 form the webhook's lookup expects (strips a "whatsapp:" prefix, assumes a US/Canada country code on a bare 10-digit number) before saving, so what the business types and what the webhook looks up actually match. A `/get-started` screen now runs right after signup (redirect in `signup.tsx`) surfacing labor rate/service call fee/WhatsApp number before the empty dashboard, with "Skip for now"; Settings has the same fields plus a Requested/Invalid/Not set status pill. Both are explicit that this is a manual request, not live self-serve, until the real integration below exists — copy says "we'll reach out to connect it," not "connected." **Real self-serve architecture is Twilio's WhatsApp Tech Provider Program + Meta Embedded Signup (v4 — v2/v3 retire 2026-10-15), confirmed against Twilio's current docs, not a dead end requiring manual concierge forever**: the customer authorizes their own WABA/number inside FrontDesk via a Meta-hosted popup, never sees a Twilio SID; FrontDesk then creates a per-customer Twilio subaccount and registers the sender via Twilio's Senders API. Requires Meta Business Verification for FrontDesk itself plus Twilio Tech Provider approval (Twilio's own docs: ~3-4 weeks) before any customer can use it — that approval process is a pure-calendar-time external dependency, worth starting regardless of when the engineering gets built. Real design implications for later: a `whatsapp_connections` table (not columns on `tenants`) holding `phone_number`/`waba_id`/`twilio_subaccount_sid`/`twilio_subaccount_auth_token` (server-only, same handling as `SUPABASE_SERVICE_ROLE_KEY`)/`whatsapp_sender_sid`/`status`, since sends and inbound-signature verification both become per-tenant-subaccount instead of the single global `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`; sender activation has no push webhook (Twilio confirms status webhooks cover messages, not sender state), so activation needs polling. The current `tenants.whatsapp_number` field and the webhook's lookup-by-number logic aren't throwaway — once real per-tenant numbers exist through this flow, the same lookup keeps working; only where the number comes from changes. |
| Meta WhatsApp Embedded Signup (`ConnectWhatsAppMeta.tsx`, `meta-whatsapp-server.ts`) | 🟡 core pipeline ✅ live and proven; self-serve for a genuine stranger still blocked on Advanced Access | **Superseded below (2026-09-15 to -19): the app got Published and a real number is live and working end-to-end — this row's original "blocked" framing was about the popup never reaching the WABA screens, which is no longer the state of things.** Left in place for history; read down to the bottom entries for where this actually stands. |
| | | **Where this actually stands as of 2026-09-08, for picking back up cold:** |
| | | **Confirmed fixed, don't revisit:** Meta's `/oauth/access_token` exchange requires the exact, SDK-internal `redirect_uri` the popup used to open — a dynamic `xd_arbiter` URL never exposed through `FB.login()`'s callback. Fixed by capturing it via a `window.open()` intercept in `ConnectWhatsAppMeta.tsx` and threading it through to the server exchange. Confirmed via live A/B testing — token exchange no longer fails with `error_subcode=36008`. |
| | | **Implemented and deployed, not yet exercised (blocked below, not broken):** `resolveWabaId`'s old approach (Meta's `debug_token`/`granular_scopes`) never returned a WABA-scoped grant and was replaced entirely — `ConnectWhatsAppMeta.tsx` now listens for Meta's `WA_EMBEDDED_SIGNUP` `postMessage` event (fired from inside the popup once the WABA/phone-number flow actually completes) and sends the captured `waba_id`/`phone_number_id` to the server alongside the OAuth code. `meta-whatsapp-server.ts`'s `validatePhoneNumberAccess` never trusts those client-supplied ids on their own — it queries Meta directly for the phone number using the just-exchanged token and cross-checks the WABA id Meta returns against what the client reported. This code is correct and ready; it simply has never been exercised for real, because — |
| | | **The actual blocker, root-caused this session:** the popup never once reached the real WABA/phone-number screens for *any* attempt, regardless of `sessionInfoVersion`, account role, or configuration correctness — it kept resolving to a bare "Continue as Casita Armonìa" consent shortcut instead. Ruled out along the way: the Embedded Signup Configuration itself (`1794429681690457` — confirmed correctly set up: Login variation "WhatsApp Embedded Signup", System-user access token, WhatsApp accounts asset type, both `whatsapp_business_management`/`whatsapp_business_messaging` permissions present); the test account's role (Casita Armonìa is Administrator); revoking access under Facebook's "Apps and Websites" settings; `auth_type: "reauthenticate"` on `FB.login()` (only forces a password re-entry, doesn't reset granted permissions — tried, reverted same session). **The real cause**: the app was never enrolled as a Meta **Tech Provider** — confirmed directly in Meta's own dashboard (My Apps → Use cases → Connect on WhatsApp → Customize → Become a Partner → Become Tech Provider), which showed "0 of 2 steps complete," and whose own copy states hosting an embedded signup flow is specifically a Tech Provider capability. |
| | | **In progress, external, pure calendar-time wait**: Independent Tech Provider onboarding was started 2026-09-08. Step 1, Business Verification (business type Sole Proprietorship, business name = owner's legal name, alternative/trade name "Job It Ready", website `https://www.jobitready.com`), is submitted and shows **"In review"** — this is the actual current blocking state, nothing to do but wait for Meta's decision (typically a few business days, sometimes longer). Step 2's two sub-tasks, "Review your app settings" and "Record video documentation," are **not clickable right now** — confirmed evidence that Meta gates App Review's sub-steps behind Business Verification actually being *approved*, not just submitted. |
| | | **Exactly what to do when this comes back, in order:** (1) Check Business Verification status at the same dashboard path above. (2) Once approved, "Review your app settings" should become clickable — work through it (privacy policy URL, app icon, category; none of this depends on the WhatsApp integration itself). (3) Retry the real "Connect WhatsApp via Meta" flow on `/dashboard/settings/business` (or the Meta-hosted link Meta's own UI generates on that same Tech Provider page) — Tech Provider approval should be what finally lets the popup reach the actual WABA/phone-number screens; if it does, the client→server handoff described above should just work with zero further code changes. (4) Use that successful connection to record "Record video documentation" (video evidence of sending a message and managing a template). (5) "Submit documentation for App Review" already oddly shows "In review" on its own — recheck it once the above is done rather than assuming it needs a separate action. |
| | | **Stage 2C built, 2026-09-14**: the signup/connection side (`ConnectWhatsAppMeta.tsx`) existed all along, but nothing could actually *receive* a message from a connected number — only Twilio's inbound path could. `src/routes/api.whatsapp.meta-webhook.tsx` closes that: GET handshake, POST signature verification (`X-Hub-Signature-256` over the raw body via the new `verifyMetaWebhookSignature`), routes by `phone_number_id` to the owning tenant's `status = 'online'` connection (`resolveActiveMetaConnection`, `.single()` so a uniqueness violation fails loudly), and calls the exact same `handleInboundWhatsAppMessage` Twilio already uses, via a Meta-backed `ChannelAdapter` (`sendWhatsAppMessageMeta`, `fetchMetaMediaAsBase64`). **Also found via this pass's schema audit**: `meta_system_user_token`/`display_phone_number` were already being written by `completeMetaWhatsAppSignup` but were never added in any tracked migration — a real latent bug that would've broken the very first successful signup at the database-insert step. Fixed in `0006_meta_whatsapp_columns.sql` (also adds the active-uniqueness index on `meta_phone_number_id` the webhook's routing query depends on). **Steps 1 (migration) and 2 (env var) below are done**: `0006` has been applied via the Supabase SQL Editor, and `META_WEBHOOK_VERIFY_TOKEN` is set on Vercel Production and Preview. **Still needed**: (3) once a real connection exists (post-Tech-Provider-approval), register this route's URL (`https://www.jobitready.com/api/whatsapp/meta-webhook`) + that same verify token in the Meta app dashboard's Webhooks configuration. |
| | | **Hardened 2026-09-14 after a side-by-side audit against Tel-Agent** (an open-source omnichannel AI agent project — its own WhatsApp channel is the same official Meta Cloud API Job It Ready uses, confirmed by reading its actual transport code, not just its README). Five gaps found and closed: (1) **`getMyWhatsAppConnection`** — an auth-gated, non-secret status read (status/display number/error reason/connected_at) so the Settings page reflects the real persisted connection on reload instead of only the in-progress FB.login() flow's local state. (2) **`disconnectMetaWhatsApp`** — auth-gated, tenant derived server-side, calls Meta's unsubscribe, nulls `meta_system_user_token` immediately (a disconnected token has no further legitimate use), sets `status = 'disconnected'`. (3) **`markConnectionFailed`** — any Meta send failure (caught in the webhook route's adapter, not inside `sendWhatsAppMessageMeta` itself, which has no business knowing about `whatsapp_connections` rows) now sets `status = 'failed'` + `error_reason`, surfaced by (1) instead of failing silently forever in server logs. (4) **Uniform webhook rejections** — every refusal reason (bad signature, unknown/inactive number, missing config) now returns the identical 403, so the endpoint can't be used to probe which reason applied; the real reason is still logged server-side. (5) **Duplicate-delivery dedup** — `whatsapp_processed_messages` (`0007_whatsapp_processed_messages.sql`, service-role only, insert-and-catch-conflict on Meta's wamid) stops a redelivered webhook from re-running the AI/send pipeline. `ConnectWhatsAppMeta.tsx` now fetches connection status on mount and renders a Disconnect button for both the `online` and `failed` states. **Confirmed a real, shared limitation, not something Tel-Agent already solved**: neither codebase handles Meta's 24-hour customer-service window / template-message requirement yet — a free-form send outside that window will simply be rejected by Meta. **`0007_whatsapp_processed_messages.sql` has been applied.** |
| | | **Two more fixes, same day, following directly from the above**: (1) **The 24h-window misdiagnosis is fixed** — `sendWhatsAppMessageMeta` now throws a distinct `MetaOutsideWindowError` when Meta's error code is specifically `131047` (the documented "outside the customer-service window" code), and the webhook route's adapter no longer calls `markConnectionFailed` for that specific error — a window rejection no longer shows the owner a misleading "reconnect your WhatsApp" prompt for something a reconnect can't fix. (2) **The dashboard's "reply to a lead" box is wired to a real send.** New `src/lib/lead-reply-server.ts`'s `sendLeadReply` resolves which of the two independent channels a tenant actually has active (Twilio's shared concierge number, or their own Meta connection via the new `resolveActiveMetaConnectionForTenant`) and sends through whichever one it is — deliberately the one place allowed to know about both, since its whole job is choosing between them, unlike `whatsapp-conversation-server.ts` which must never know either exists. The old `addLeadMessage` (removed — superseded) always saved to `lead_messages` regardless of whether anything actually reached the customer; `sendLeadReply` only saves once a real send succeeds for WhatsApp leads, so the thread can no longer claim a delivery that didn't happen. Non-WhatsApp leads (Widget/Quote link/Shared link — no outbound channel exists for those) keep the old save-only behavior unchanged. **Known, not yet fixed**: this same window-detection was only added to the Meta path — Twilio's `sendWhatsAppMessage` still throws a generic error for its equivalent case (Twilio error code 63016), so a Twilio-connected tenant's dashboard reply outside the window would surface a raw Twilio error message rather than the same clear explanation Meta gets. |
| | | **App Published (2026-09-15 to -18) — this is what actually unblocked real delivery.** Business Verification came back Approved; Access Verification (Tech Provider confirmation) cleared; the last submission blocker was a missing 1024×1024 app icon (generated to match the site's actual brand colors/wordmark, uploaded). Once Published, real (non-dashboard-triggered) webhook deliveries started arriving — confirming Meta's own stated behavior that an Unpublished app only delivers *test* webhooks triggered from its own dashboard, never real traffic, even to app admins. |
| | | **A real, working number is live and proven end-to-end, connected manually (not through the Embedded Signup popup)**: a WhatsApp Business Platform number (`+52 624 159 3182`) was registered directly in Meta's dashboard under the app's own WABA (`1801366357722361`), a System User (Admin role, full access to both the app and the WABA asset) was created in Business Settings with a **long-lived, non-expiring token** (the earlier Graph API Explorer temporary token kept expiring mid-test and was replaced for this reason), and `whatsapp_connections` was updated directly via SQL — `meta_phone_number_id`/`waba_id`/`meta_system_user_token`/`display_phone_number`/`status: 'online'`. A full real conversation (photo → AI clarifying questions → priced quote → "book it" confirmation) has been run successfully multiple times, across multiple job types (a plumbing pop-up-drain job and an unrelated tile-repair job), proving the AI generalizes correctly, not just on one seeded example. |
| | | **Connection-failure alerting built** — `notify-server.ts`'s `sendConnectionFailedNotificationEmail`, fired from `markConnectionFailed` only on the transition into `'failed'` (not on every retry against an already-broken connection, to avoid duplicate-email spam), plus a `WhatsAppStatusLight` component on the dashboard's Today page (green "connected" / red "needs attention, check your email including spam" dot). Verified working end-to-end via a real, deliberate test (corrupting the stored token with a reversible string-append, forcing a real 401 from Meta, confirming both the DB write and a live dashboard-reply send correctly triggered `markConnectionFailed`). The email itself required real debugging before it could be confirmed: Gmail SMTP kept rejecting with `535 5.7.8 Username and Password not accepted` — root cause was `NOTIFICATION_FROM_EMAIL` not actually matching the Google account the App Password was generated under, found by testing the credentials directly against `smtp.gmail.com` outside the app entirely (ruled out our code, ruled out Vercel env staleness, isolated it to the Google-account mismatch specifically). Now correctly configured and confirmed sending. |
| | | **The AI now stays engaged with repeat customers instead of going silent for 48 hours** — previously, once a lead was quoted, any further message from that number was only logged and emailed to the owner; the AI never replied to the customer again, even for a genuinely new, unrelated job. Fixed in `whatsapp-conversation-server.ts`: a new photo attached is treated as strong evidence of a new job on its own (skips a redundant round-trip that was previously discarding an already-sent photo just to ask "is this the same job?"); with no new photo, a new `classifyFollowUpIntent` (`estimate-server.ts`) call decides same-job vs. new-job from the text alone, routing either to `getFollowUpAnswer` (answers directly, or honestly defers "the business will confirm" — never invents specifics) or a fresh quote flow. |
| | | **The AI can no longer invent a price for something not on the price sheet** — see the Phase 1.5 flagged-leads section above (`outside_service_scope`) for the full detail; this was found and fixed in the same work session as the above. The whole `estimate-server.ts` prompt also had its repair-trade-specific framing removed in the same pass ("trades business"/"tradesperson"/hardcoded flooding-and-gas-smell emergency examples/"describe the problem") so it reasons correctly for any service business type, not just repair trades — motivated directly by testing this against a hypothetical dog-grooming business. |
| | | **Today's finding (2026-09-19): Advanced Access has not been granted, and no App Review submission is visible.** Checked directly in the Meta dashboard → Permissions and features: both `whatsapp_business_management` and `whatsapp_business_messaging` show **"Ready for testing"** (Standard Access), not Advanced Access. Standard Access only allows Embedded Signup to work for Meta accounts that are already admins/testers on this Meta app — it does **not** yet allow a genuine unrelated third party (a real second business, unconnected to the app's own Meta team) to complete Embedded Signup and connect their own number. This is the actual remaining gate on true multi-tenant self-serve onboarding — not a code problem; the OAuth/token-exchange code itself (`completeMetaWhatsAppSignup`) has still never been exercised for real, in either direction. **Two honest next steps, not yet started:** (1) add a second Meta account as a tester on the app and run Embedded Signup with it, to validate the OAuth code actually works mechanically under Standard Access before investing in the Advanced Access review; (2) separately, start the Advanced Access App Review submission (demo video, business justification) if/when opening this to genuine strangers is the near-term goal — an external review process with its own timeline, same shape as Access Verification was. |
| | | **Also worth knowing, unrelated fixes made along the way this same session**: a real production bug was found and has since been fixed — `SITE_URL` was unset in Vercel production (`stripe-server.ts` was falling back to `http://localhost:8080` for real Stripe Checkout redirects), confirmed now set as of the 2026-09-14 audit; `jobitready.com`/`www.jobitready.com` are now actually live (domain audit done, sitemap/robots/llms.txt/widget links all point at the real domain); a Meta Business Manager domain-verification `<meta>` tag was added; and a temporary owner-only login/signup gate exists (see its own row below) unrelated to any of the above, just also done this session. |
| Owner-only login gate (`src/lib/owner-gate.ts`) | 🔴 TEMPORARY — remove before real signups | While Job It Ready isn't ready for real customer accounts (Meta integration still broken, business verification pending), `/login` and `/signup` check the authenticated email against `VITE_SITE_OWNER_EMAIL` (set to `edgarshopify@gmail.com` in Vercel Production and Preview) — anyone else is immediately signed back out and shown "coming soon" instead of reaching the dashboard. `useAuth()` itself also treats any non-owner session as logged-out (not just the two submit handlers), added after a security review caught that Supabase syncs sessions across tabs/storage — without this, a non-owner with `/dashboard` open in another tab, or hitting a transient `signOut()` failure, could otherwise still reach real `requireSupabaseAuth`-gated data before the gate caught up. Marketing pages, `/demo`, `/pricing`, and the sample dashboard are untouched and stay fully public. **Still a soft UI-level gate, not hard security** — a non-owner authenticating directly against Supabase's API (bypassing this app's UI entirely) isn't prevented; acceptable since nothing sensitive depends on it. **Known side effect, accepted for now**: `handle_new_user`'s trigger fires *inside* `signUp()`, before the gate can run — so every blocked signup attempt still leaves behind a real `auth.users` row and an auto-created `tenants` row, even though the UI shows nothing happened. Worth pruning before real launch. **Must be removed (delete `owner-gate.ts`, the checks in `login.tsx`/`signup.tsx`/`use-auth.ts`, and the env var) once ready to accept real signups** — added 2026-09-08, tracked here specifically so it isn't forgotten. |
| Rate limiting | 🟡 | A single global counter (20 requests/minute across every visitor) — a blunt anti-abuse measure, not a real per-tenant quota. (No trial enforcement needed — there is no trial.) |
| Auth / sessions | ✅ | Real Supabase Auth — `src/integrations/supabase/` (client, server-side `requireSupabaseAuth` middleware for gating server functions, client-side `attachSupabaseAuth` that auto-attaches the session token to every server-function call). Ported from a working pattern in the `buildraid` repo, wired to FrontDesk's **own**, separate Supabase project — not shared with any other app. |
| Database | ✅ core tables · 🟡 not everything reads from it yet | `supabase/migrations/0001_init.sql` defines `tenants`, `price_sheet_items`, `leads`, `lead_line_items`, `lead_messages` — all RLS-scoped to the signed-in user's own tenant, with a trigger that auto-creates a tenant row on signup (no onboarding wizard needed just to get *a* tenant to read/write). `0002_whatsapp.sql`/`0003_whatsapp_connections.sql` add WhatsApp routing (see the WhatsApp row above). `0004_business_capabilities.sql` (`tenant_capabilities` — applied and verified) and `0005_field_notes.sql` (`field_notes` — applied and verified, application layer not built yet) are new this pass — see Phase 1.5 below. `src/lib/tenant-server.ts`, `price-sheet-server.ts`, `leads-server.ts`, `capabilities-server.ts` are the auth-gated server functions the dashboard pages above call. Not yet wired to the database: the AI's live pricing input (`estimate-server.ts` still uses `SAMPLE_PRICE_SHEET`, since `/demo` isn't tenant-scoped yet — see Phase 1, step 9 below). |
| Billing (Stripe) | ✅ | Real Checkout session creation, a real Billing Portal session, and real payment-method/invoice reads (`src/lib/stripe-server.ts`, auth-gated) plus a real webhook (`src/routes/api.stripe.webhook.tsx`) that verifies Stripe's signature and records the plan on the user via Supabase's admin API. Subscription status lives in Supabase `user_metadata` for now — a real `subscriptions` table is worth it once the rest of the data model exists, but wasn't needed to make this real. |
| Email notifications | ✅ mechanism · 🟡 not triggered by anything real yet | `src/lib/notify-server.ts`'s `sendLeadNotificationEmail` — ported directly from Cabos Handyman's own working `api/send-booking-email.js` (same nodemailer + Gmail App Password approach, same HTML-escaping of user-supplied text before interpolation). Fires the moment a lead is created, not gated behind an actual confirmed booking — same real pattern Cabos already uses in production. Needs `NOTIFICATION_FROM_EMAIL` + `EMAIL_APP_PASSWORD` set (a Gmail account + an App Password, not a real password — no Meta-style business verification needed, this is the easy piece). SMS still doesn't exist. |
| Legal pages (Privacy Policy, Terms) | ✅ | `/privacy` and `/terms` now exist as real pages; footer's old "Austin, Texas" line replaced with links to both. |
| Customer-facing "remote estimate" disclaimer | ✅ | Every place a customer actually receives a price — the proposal document (`BusinessDocument.tsx`), the WhatsApp webhook's two outbound quote messages, and the dashboard's auto-drafted suggested reply (English + Spanish, `reply-composer.ts`) — now states the price is estimated from photos/description and may change after an on-site inspection. Deliberately not added to invoices/receipts (confirmed work, not an estimate) or internal-only displays. |

## Known disconnects

1. ~~**Two separate price sheets.**~~ ✅ Fixed for real users — `price_sheet_items` is now the one shape both the dashboard table and the AI-facing type (`PriceSheetItem` in `estimate-server.ts`) share structurally. **Update (2026-09-14 audit)**: the real, tenant-scoped paths (WhatsApp and `/quote/:slug`) both now fetch and pass real `price_sheet_items` rows — see Phase 1 step 9 below, done. `estimate-server.ts` itself never hardcodes a price sheet; `SAMPLE_PRICE_SHEET` only remains as `QuoteFlow`'s default value, used by the intentionally-sample `/demo` page.
2. ~~**Editing a lead doesn't reach its documents.**~~ ✅ Fixed for real users — line-item edits on `/dashboard/leads/:id` persist to `lead_line_items`, and the proposal/invoice/receipt routes read the same row via `useLeadDocument`, so a document always reflects the latest saved edit.
3. ~~**`/demo` still doesn't persist a lead.**~~ ✅ Resolved as of this audit (2026-09-14) — correct by design, not an open gap. `src/components/quote/QuoteFlow.tsx` only calls `createLead` when a `tenantSlug` prop is passed (`if (!result || !tenantSlug) return;`); `/demo` deliberately never passes one, so it stays a true no-signup sandbox with nothing persisted, exactly as its own copy promises ("No signup, no card"). The real path, `/quote/:slug` (item 10 below), passes its resolved tenant's slug and does persist a real lead. Verified directly by reading `QuoteFlow.tsx` line 208.

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
4. ~~**Get a real domain and point it at the deployment.**~~ ✅ Done, 2026-09-08 — `jobitready.com`/`www.jobitready.com` are live in Vercel's domain settings, and the sitemap/`robots.txt`/`llms.txt`/`mock-data.ts` now point at `www.jobitready.com`. `SITE_URL` itself is also now confirmed set in Vercel's production env vars (fixed since first flagged; Stripe Checkout redirects no longer fall back to `localhost:8080`). **Still open**: the `legal@`/`privacy@frontdesk.tools` mailto addresses haven't moved pending confirmation that `@jobitready.com` mailboxes exist. No JSON-LD placeholder URL was actually found in `index.tsx`'s `SOFTWARE_SCHEMA` — it has no `url` field, so nothing there needed updating.
5. **Smoke-test the live URL end to end**: sign up, log in, run `/demo`, start a Stripe checkout in test mode, confirm the webhook fires against the real deployed webhook URL (not `stripe listen` to localhost anymore).

### Phase 1 — Close the self-serve loop

Right now a stranger can sign up and explore the dashboard, but there's no way
for *their* customers to actually submit a photo against *their* price sheet —
the core product loop isn't closed for a real, unassisted business yet. This
phase closes it.

6. ~~**Auth.**~~ ✅ Done — real Supabase Auth, `/login`/`/signup` work, `/dashboard/*` is gated.
7. ~~**Database: tenants, leads, price sheet.**~~ ✅ Done — `supabase/migrations/0001_init.sql` plus the server-function layer (`tenant-server.ts`, `price-sheet-server.ts`, `leads-server.ts`), wired into settings/business, price-sheet, and the leads list/detail/documents pages.
8. **Build the five missing onboarding pages** — still genuinely open: `src/routes/onboarding.index.tsx`/`onboarding.tsx` exist, but `business-info`/`price-sheet`/`branding`/`calendar`/`done` step files still don't. **Correction (2026-09-14 audit): the "broken redirect" is no longer true** — `onboarding.index.tsx` now redirects to `/get-started` (a real, built page, confirmed to exist), not to the nonexistent `/onboarding/business-info`. It appears the original 5-step-wizard plan was superseded by the simpler single-screen `/get-started` flow rather than actually built out — worth deciding explicitly whether the 5-step wizard is still wanted at all, or whether `/get-started` is the accepted permanent answer and this item should be closed instead.
9. ~~**Wire `estimate-server.ts` to a tenant's real `price_sheet_items`, and persist a real estimate as a lead.**~~ ✅ Done — confirmed 2026-09-14 by reading the code directly, not just the checklist. `whatsapp-conversation-server.ts` fetches real `price_sheet_items` scoped to `tenant.id` for both the first-message and clarification-round paths; `quote.$slug.tsx`/`getTenantForQuote` does the same for the public quote page, and `QuoteFlow.tsx` calls the real `createLead` once a `tenantSlug` is present (see item 3 above). `SAMPLE_PRICE_SHEET` now only appears as `QuoteFlow`'s *default* prop value, used solely by the intentionally-sample `/demo` page — every real, tenant-scoped path already overrides it.
10. ~~**Build the public per-tenant quote page**~~ (`/quote/:slug`) ✅ Done — this was already fully built and wired (`getTenantForQuote`, `QuoteFlow`, real `createLead` persistence) but this checklist had never been updated to reflect it. Confirmed by reading `src/routes/quote.$slug.tsx` directly on 2026-09-14.
11. **Build the actual embeddable widget script** that `/dashboard/widget`'s embed code currently just references (`https://cdn.jobitready.com/widget.js`) but doesn't back.
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
- **The decision engine (full version)** ⬜ not started — `estimate-server.ts`
  needs a 6-step reasoning sequence (understand the problem → identify the
  actual work required, reasoned rather than keyword-triggered → check
  against capabilities/exclusions → check price-sheet relatedness → check
  information sufficiency → only then price) and a `needsReview` result
  shape for when it can't safely quote. Depends on Business Capabilities
  (done) and Field Notes (in progress) both existing first.
- **The flag/review loop (full version)** ⬜ not started — `flagged` leads
  (with a `flag_type`: missing capability, outside service scope,
  hazardous/specialized, or conflicting information), owner-facing
  resolution (dismiss, or add the capability), and the load-bearing rule
  that **adding a capability never auto-quotes the lead that triggered
  it** — the owner always prices or explicitly re-triggers the AI.

Each of the four sub-items above is being built and approved separately,
in that order — this file will move each to ✅ as it lands.

#### Minimal flagged-leads slice — ✅ done (2026-09-19), `outside_service_scope` live; other flag types wired but not yet triggered

Originally prompted by a real Cabos Handyman WhatsApp conversation
(2026-09-17, conflicting-diagnosis water-damage case — see git history for
the full story) as a `needsReview`/`conflicting_information` concept. Before
that path got built, a second, more immediate real gap surfaced first and
shipped instead: **the AI was instructed to "estimate reasonably against the
labor rate" for anything not on the price sheet** — meaning it would invent
a price for a job it had no business pricing at all. Fixed by making the
tenant's own price sheet the sole source of truth the AI is allowed to price
from, with this flagged-leads mechanism as where it defers instead of
guessing.

- **Migration** (`0008_flagged_leads.sql`, applied) — `'flagged'` added to
  `leads.status`; `flag_type` (`'conflicting_information'`,
  `'needs_human_review'`, `'outside_service_scope'`); `flag_reason` (text).
  A check constraint ensures `flag_type` is only ever set on a `'flagged'`
  row.
- **`estimate-server.ts`** — `QuoteResult` gained a third shape,
  `{needsClarification: false, outOfScope: true}`. The prompt no longer
  offers "estimate against the labor rate" as a fallback at all — it either
  matches (and reasonably extrapolates quantity/scope within) a price-sheet
  item, or returns `outOfScope`. Only `outside_service_scope` is actually
  wired to fire today; `conflicting_information`/`needs_human_review` exist
  in the schema for the original Cabos Handyman case but have no caller yet.
- **Webhook wiring** (`whatsapp-conversation-server.ts`, both the
  mid-clarification and fresh-conversation paths) — on `outOfScope`, creates
  (or updates) the lead via `createFlaggedLead`/direct update, sends the
  customer exactly: *"I can pass your request along to the team for a
  custom quote — want me to do that?"*, and notifies the owner. Never
  fabricates a price.
- **Public quote page** (`QuoteFlow.tsx`) — same handling for the
  `/quote/:slug` and `/demo` flow: a dedicated `outOfScope` stage collecting
  name/phone and creating a flagged lead, instead of showing a fabricated
  estimate.
- **Dashboard** — `dashboard.leads.$id.index.tsx` shows the flag reason
  plainly when `status === 'flagged'`, with a "Mark reviewed" action (no
  capability-add branch — that still needs the capabilities table, out of
  scope here). `StatusPill`/`STATUS_LABEL` render `'flagged'` as "Needs
  review" everywhere leads are listed.
- **Price sheet page** — a banner: *"If you leave out a service, you're
  leaving money on the table"* — since the price sheet is now genuinely the
  ceiling of what the AI can auto-quote, not just a reference the AI could
  fall back from.
- **Universality pass, same commit** — the whole `estimate-server.ts` prompt
  had its repair-trade-specific framing removed ("a trades business",
  "tradesperson", hardcoded emergency examples like flooding/gas smell,
  "describe the problem") — it now reads what kind of business a tenant
  actually is from its own price sheet and reasons/phrases accordingly,
  since this is meant to work for a groomer or any other service business,
  not just repair trades.

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