# Security Remediation Tracker

Dated, authoritative log of every security-relevant fix found/built during
this engagement: what it is, what verifies it, what it depends on, and
whether it's actually live in production yet. Update this file as items
move between states — do not rely on commit messages or chat history alone
to answer "is X actually released."

**Status key**: 🟢 pushed to `origin/main` (will deploy on Vercel's next
build of that branch) · 🟡 committed locally, not pushed (blocked) · 🟠
implemented + tested locally, **not yet committed** (awaiting review) · 🔵
read-only finding, no fix implemented yet · ⚪ reviewed, left as-is (not a
bug, or not in scope) · 🟣 migration prepared, **not applied to
production** · 🟤 manual Supabase dashboard action required, not something
code or a migration can do

Last updated: 2026-11-06.

---

## 0. Stage 1 — 2026-11-06 security audit remediation 🟠

Everything below is implemented + tested locally. **Nothing in this
section is committed, pushed, or deployed, and no migration has been
applied to production** — per this stage's own explicit stop point.
Do not treat any item here as "done" until it's actually shipped; this
section exists specifically so that distinction never gets lost.

### 1A — SSRF fix 🟠
**File**: new `src/lib/ssrf-safe-fetch.ts`, wired into
`price-sheet-server.ts`'s `extractPriceSheetFromUrl` (replacing the old
`isSafePublicUrl`, which validated hostnames as strings and never
resolved DNS before connecting — the DNS-rebinding gap the audit found).
**What it does**: resolves every DNS record for a hostname, rejects if
any is private/loopback/link-local/reserved (IPv4 and IPv6, including
IPv4-mapped IPv6), then pins the actual connection to the exact address
already validated (via Node's own `http(s).request`'s `lookup` option)
so a second, independent DNS lookup at connect time can never answer
differently. Redirects are followed manually, one hop at a time, each
hop re-validated from scratch.
**Tests**: `src/lib/ssrf-safe-fetch.test.ts`, 26 tests — localhost,
private IPv4/IPv6, link-local, mixed-safe/unsafe DNS results, redirects
to a prohibited destination, a deliberate DNS-rebinding simulation
(proven to actually catch a regression — the pinning was deliberately
broken and the test failed, then restored and re-verified green), and a
normal public HTTPS URL succeeding end to end.
**Genuinely resolved?** Yes, as far as this app's own code goes — the
exact bypass the audit described (a hostname that looks public but
resolves to an internal address) is now closed and proven closed.
**Remaining limitation**: none identified for this specific
vulnerability class.
**Migration required?** No. **Manual dashboard action?** No.

### 1B — Database hardening 🟢 Applied to production, verified (2026-11-06)
**File**: `supabase/migrations/0037_database_hardening.sql` — **applied to production
and verified** via the SQL Editor: `handle_new_user` now shows
`anon_can_execute=false`, `authenticated_can_execute=false`,
`search_path_config=["search_path=public"]`; `set_updated_at` now shows
`search_path_config=["search_path=public"]`. Matches the expected
post-migration state exactly.
**What it does**: revokes `anon`/`authenticated` EXECUTE on
`handle_new_user()` (defense-in-depth — confirmed, by actually
attempting the call against a local disposable Postgres instance, that
Postgres already rejects it with "trigger functions can only be called
as triggers" regardless of the grant); sets a fixed `search_path` on
`set_updated_at()`.
**Verification performed, not just asserted**: applied against a local
disposable Postgres instance (`supabase start` + `db reset`, all 38
migrations including this one), then: (1) confirmed via
`has_function_privilege` that both grants are now `false`; (2) confirmed
the trigger-type-mismatch error directly, by temporarily re-granting and
attempting the call; (3) inserted a real row into `auth.users` and
confirmed the `tenants` row was created identically before and after
this migration; (4) updated a `tenants` row and confirmed
`set_updated_at` still fired. Local stack torn down afterward.
**Genuinely resolved?** The migration is written, correct, and
empirically proven safe — but it is **not applied to production**. This
item is not resolved until you run it.
**Migration required?** Yes — `0037_database_hardening.sql`, prepared,
not applied. **Manual dashboard action?** Separately, yes — see the
leaked-password-protection item below, which this migration does not
cover (that's a toggle, not SQL).

🟤 **Leaked-password protection** — attempted 2026-11-06, **blocked by
plan tier**: Supabase rejected the save with "Configuring leaked
password protection via HaveIBeenPwned.org is available on Pro Plans
and up" — this project is currently on the Free tier. Not something a
migration or further dashboard effort can fix; requires either
upgrading the Supabase project's plan, or accepting this as a known,
documented limitation for now (current user base is the owner's own
test accounts, not public signups — signups are also currently paused).
Owner's call, not actioned either way.

### 1C — Durable AI rate limiting for the three classifiers 🟡 Database half applied; code half not yet deployed
**Database**: `supabase/migrations/0038_tenant_ai_usage_kind.sql` —
**applied to production and verified** (2026-11-06), transactional
version. Confirmed: the one real pre-existing row survived with
`kind='quote'`, count unchanged.
**Application code**: **still not committed or deployed.** This matters:
production's deployed code still uses the old 2-argument RPC call shape
(confirmed safe — it correctly defaults to `kind='quote'`, no outage),
but that also means the three classifiers are **not yet actually using**
the new `classifier` bucket the database can now support. Until
`estimate-server.ts`/`whatsapp-conversation-server.ts`'s changes are
committed, pushed, and deployed, the classifiers remain protected only
by the old in-memory `withinRateLimit()` counter — the durable fix
this stage exists to ship is schema-ready but not yet live.
**Files**: `supabase/migrations/0038_tenant_ai_usage_kind.sql`;
`estimate-server.ts` (`enforceTenantAiLimit` now takes a `kind: "quote" |
"classifier"`, each with its own ceiling and its own row in
`tenant_ai_usage`); `whatsapp-conversation-server.ts` (the 4 call sites
across `classifyFollowUpIntent`/`classifyBroadServiceInquiry`/
`classifyFollowUpPhotoIntent` now pass `tenantSlug`).
**Why a new migration, not just a code change**: `tenant_ai_usage` had
no `kind` column — reusing it unmodified would make these three
high-frequency classifiers share the exact same 300/day budget as real
quote generation, risking a busy conversation day starving legitimate
quoting. The migration gives classifiers their own 1000/day bucket,
mirroring the `kind` design `tenant_ip_usage` (its own sibling table,
same original migration) already uses.
**Tests**: 8 new tests in `estimate-server.test.ts` covering both
ceilings independently, the default-to-"quote" behavior (so the two
pre-existing call sites don't need to change), failing closed on a
database error, the no-tenant-resolves case, and a concurrent-requests
test proving the boundary case (the request that crosses the ceiling is
rejected, not an earlier or later one) — plus the stale test-assertion
fix in `whatsapp-conversation-server.test.ts` this required.
**Genuinely resolved?** The application code is correct and tested
against a fake admin client. The real atomic-increment guarantee comes
from Postgres's `on conflict ... do update` (same proven pattern as
`0017`/`0018`'s already-live counters) — not re-provable in a unit test,
but not new logic either. **Not applied to production** — this doesn't
take effect until `0038` is run.
**Migration required?** Yes — `0038_tenant_ai_usage_kind.sql`.
**Manual dashboard action?** No.

### 1D — JIR Chat import validation 🟠
**File**: `whatsapp-import-server.ts` — `validateWhatsAppImportInput`,
wired into both `previewMyWhatsAppImport` and `confirmMyWhatsAppImport`'s
`.validator()` (previously a literal identity function with no check of
any kind).
**What it does**: rejects non-object input, missing/non-string/empty
content, content over 10MB, non-boolean `preferDayFirst`, a non-string
`originalFilename`; caps an oversized filename rather than rejecting the
whole import over a cosmetic field.
**Tests**: 14 new tests in `whatsapp-import-server.test.ts` — valid
imports, every malformed-type case, the oversized case, the at-the-limit
boundary, and unexpected extra fields.
**Genuinely resolved?** Yes — this is a pure code change with no
database or dashboard dependency, so once committed and deployed it's
fully in effect.
**Migration required?** No. **Manual dashboard action?** No.

### 1E — Price-sheet photo upload size limit 🟠
**File**: `price-sheet-server.ts` — new `validatePriceSheetPhotoUpload`
(extracted for direct testability, same reasoning as every other
`createServerFn`-wrapped handler in this codebase), wired into
`extractPriceSheetFromImage` ahead of the real AI call. Same 2.8MB
ceiling and message as `estimate-server.ts`'s own existing
`MAX_IMAGE_BASE64_CHARS` (duplicated rather than imported, same
import-protection constraint as this file's existing
`isSupportedImageBase64` copy).
**Tests**: 7 new tests — valid JPEG/PNG, wrong format, a
format/size-mismatch combination (confirms the format error wins, not a
confusing size error, when both are true), oversized, and exactly at the
boundary.
**Genuinely resolved?** Yes, same as 1D — pure code, no dependency.
**Migration required?** No. **Manual dashboard action?** No.

### 1F — Signup capacity enforcement 🟢 Done (2026-11-06, manual dashboard action)
Supabase's **"Allow new users to sign up"** toggle (Authentication →
Sign In / Providers → User Signups) has been switched off and saved —
confirmed via screenshot (toggle in the disabled position, "Save
changes" greyed out with no pending edit). This closes the real gap the
audit found: a direct `supabase.auth.signUp()` call bypassing the
UI-only `/signup` pause. New signups are now rejected at the platform
level, before this app's code or the `handle_new_user` trigger ever
runs. No code or migration involved; fully reversible by flipping it
back.

**Known loose end**: `src/routes/signup.tsx`'s own pause
(`SIGNUPS_OPEN = false`) is still uncommitted locally (deliberately left
out of the Stage 1 commit as out of scope). Until it's deployed, the
live `/signup` page still shows the normal form — submitting it now
fails with a Supabase error rather than silently succeeding, which is
safe but not a clean UX. Not blocking; just not yet shipped.

<details>
<summary>Original options analysis (for reference — Option A is what was implemented above)</summary>


The current `/signup` gate (`SIGNUPS_OPEN = false` in `signup.tsx`, from
an earlier round) is UI-only — confirmed by this round's audit:
`supabase.auth.signUp()` called directly against the public API still
creates a working account, because `handle_new_user()`'s trigger fires
on any new `auth.users` row regardless of how it was created.

Per this stage's explicit instruction, options are presented here for
your decision — **nothing below is built**:

- **Option A (recommended): Supabase's own "Allow new users to sign up"
  toggle** (Authentication → Sign In / Up settings, exact location
  varies by dashboard version). Rejects every signup attempt at the
  platform level, before this app's code or database ever runs —
  including a direct API call, which is exactly the bypass found. Zero
  code, zero migration, instantly reversible. 🟤 manual dashboard
  action, no code dependency.
- **Option B: a Postgres trigger on `auth.users` checking a flag.** More
  moving parts (a new config-flag mechanism, a migration, real risk of
  breaking signup if the trigger logic has a bug) for no additional
  protection over Option A, since Option A already stops the row from
  ever being inserted in the first place.
- **Option C: a Supabase Auth Hook.** Either a Postgres-function hook or
  an Edge Function hook, configured in the dashboard. More setup than
  Option A, no clear advantage for this specific need.

**Recommendation**: Option A. Not applied — waiting on your decision.

</details>

### 1G — Content Security Policy 🟠 (Report-Only)
**File**: `vercel.json` — added `Content-Security-Policy-Report-Only`
(deliberately not the enforcing header yet), split into two header
blocks mirroring the existing `X-Frame-Options` exception exactly (one
for everything except `/widget/*` with `frame-ancestors 'self'`, one for
`/widget/*` with `frame-ancestors *` — the embeddable quote-widget's
whole purpose is being framed by an arbitrary external site). Built from
a real inventory of this app's actual external resources, not a generic
template: Google Fonts (`fonts.googleapis.com`/`fonts.gstatic.com`),
Meta's Embedded Signup SDK (`connect.facebook.net`, plus
`frame-src https://www.facebook.com` for its own login dialog), the
Supabase project's REST/Realtime endpoints (`*.supabase.co`,
`wss://*.supabase.co`). `script-src`/`style-src` include
`'unsafe-inline'` — confirmed necessary, not a default: TanStack Start's
own SSR streaming mechanism injects inline bootstrap scripts directly
into the HTML (observed directly in this engagement's own earlier
production-verification work), and a tenant's custom brand color is
applied via an inline `style` prop (`QuoteFlow.tsx`). A stricter
nonce-based policy is possible in principle (TanStack Router supports an
`ssr.nonce` option) but needs its own per-request nonce middleware and
disabling caching on nonce-bearing pages — real framework-level work,
not attempted here; flagged as a follow-up, not guessed at.
**Verification**: JSON-validated, full build/test suite re-run clean.
**Not independently verified against real, live traffic** — this is
Report-Only specifically so real page loads can be checked (browser
DevTools' Console/Network tabs show CSP violations even in report-only
mode) before ever switching to the enforcing header. No violation-
collection endpoint (`report-to`) was built — recommended as a
follow-up if you want structured, aggregated reports rather than
checking the browser console by hand during a manual pass.
**Genuinely resolved?** Partially — real protection exists once this
header is live (even in report-only form, it tells you what WOULD
break), but moving to actual enforcement needs a monitoring period
first, by design.
**Migration required?** No. **Manual dashboard action?** No — this is a
`vercel.json` change, takes effect on next deploy.

---

## 1. Pushed and deployed (on `origin/main` as of this update)

### 1.1 — Nodemailer advisories + security headers + RLS tenant-isolation verification
- **Commit**: `adf3ebd` (pre-existing this session, pushed this session)
- **Finding**: five known nodemailer GHSA advisories; missing
  `X-Content-Type-Options`/`Referrer-Policy`/`Permissions-Policy`/
  `X-Frame-Options` headers.
- **Fix**: bumped nodemailer to 10.0.9; added headers via `vercel.json`
  (excluding `/widget/` from `X-Frame-Options` since it must stay
  embeddable).
- **Tests**: `scripts/pg-tenant-isolation-check.sh` — real-Postgres RLS
  verification across `leads`/`price_sheet_items`/`lead_line_items`/
  `lead_messages`/`tenant_capabilities`/`field_notes` with two seeded
  tenants.
- **Migration dependency**: none.
- **Production verification needed**: none beyond the deploy itself.
- **Remaining risk**: none known.

### 1.2 — Subscription-entitlement privilege escalation + webhook races
- **Commit**: `2cce874` (pre-existing this session, pushed this session)
- **Finding**: subscription state (plan/status/Stripe customer id) was
  readable, and in one path writable, via client-controllable Supabase
  `user_metadata`, letting a signed-in user self-grant a paid plan.
- **Fix**: moved the authoritative record to `subscription_state`
  (migrations `0021`-`0023`), written only through
  `claim_stripe_event`/`complete_stripe_event`/`fail_stripe_event` +
  `write_authoritative_subscription_state` — atomic claim-fenced writes,
  so a worker that lost its claim can never apply a stale write.
  `app_metadata` kept only as a best-effort, non-authoritative mirror.
- **Tests**: `scripts/pg-migration-verification.sh`,
  `scripts/pg-concurrency-check.sh` against a real disposable Postgres.
- **Migration dependency**: `0021`/`0022`/`0023` — **CRITICAL GAP FOUND
  AND FIXED 2026-10-19**: these migrations were shipped in commit `2cce874`
  (2026-10-15) but had NEVER actually been applied to production, despite
  this tracker previously (incorrectly) treating that as done. Discovered
  when a live WhatsApp smoke test failed with "This business's estimate
  service is currently unavailable" for every tenant —
  `hasActiveSubscriptionForOwner` fails closed on a missing-table error, so
  every single tenant's public quote/widget/WhatsApp intake had been
  rejecting all customers for ~4 days. Verified missing via a 9-point
  existence check (all `false`), applied via the Supabase SQL Editor,
  re-verified (all 9 `true`). Separately discovered during the same
  incident: the Stripe account's **live-mode secret key and webhook
  endpoint had never been created at all** — `STRIPE_SECRET_KEY`/
  `STRIPE_WEBHOOK_SECRET` in Vercel were pointing at test-mode or missing
  values. Both created fresh in Stripe's Live mode (secret key scoped to
  the "Recurring subscriptions and billing" template; webhook endpoint
  added for `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.payment_failed`), set in Vercel, redeployed. A reconciliation
  dry-run (`scripts/reconcile-subscription-metadata.ts`, no `--apply`)
  indexed 0 distinct Stripe customers tied to a Supabase user id,
  consistent with the live Stripe account never having processed a real
  transaction before today — i.e. this gap very likely cost no actual
  paying customers, though it was a genuine, severe architectural failure
  that needed fixing regardless.
- **Production verification**: done — see above. Reconciliation dry-run
  pending final re-run/review now that the table exists and real live
  Stripe credentials are in place.
- **Remaining risk**: none from the schema itself. Still open: confirm the
  reconciliation dry-run's final output once re-run, and re-run the
  WhatsApp live-traffic smoke test to confirm the full chain (routing →
  entitlement check → real AI quote) now works end to end.

### 1.3 — Price-sheet backup/restore + negative-`hours` validation fix
- **Commit**: `e24e664`
- **Finding**: `validatePriceSheetItem` (the function `saveMyPriceSheet`
  calls before any database write) checked `priceMin`/`priceMax` but
  never `hours` — a negative hours value passed Save-changes validation
  silently, and `price_sheet_items.hours` has no CHECK constraint either
  (`0001_init.sql`), so nothing in the stack caught it.
- **Fix**: `validatePriceSheetItem` now also rejects `hours < 0`, same
  message shape as the existing price checks. Also ships the price-sheet
  backup/restore feature (lossless JSON export/import, atomic
  all-or-nothing restore validation).
- **Tests**: `price-sheet-server.test.ts` (13 tests — unit tests of the
  validator's own narrow shape, clearly separated from integration-style
  tests mirroring `saveMyPriceSheet`'s exact call expression);
  `price-sheet-backup.test.ts` (pre-existing).
- **Migration dependency**: none — pure application code, no schema
  change.
- **Production verification needed**: none beyond the deploy.
- **Remaining risk / limitation**: `saveMyPriceSheet` itself (a bare
  `createServerFn`) cannot be invoked outside TanStack Start's server
  runtime in this test environment (empirically confirmed, not assumed) —
  so the orchestration around the validator (auth gate, validate-before-
  delete/insert ordering) is verified only by direct source reading, not
  by an executed test. No database-level CHECK constraint was added for
  `hours` either — the application-level fix is sufficient since the
  validator call is unconditionally reached before any write, but a
  defense-in-depth constraint is a reasonable future addition, not done
  here.

### 1.4 — `stripe-server.ts` testability refactor
- **Commit**: `319ab1d`
- **What**: mechanical extraction of `createCheckoutSession`/
  `getMyBillingInfo`/`createBillingPortalSession`'s handler bodies into
  plain `performCreateCheckoutSession`/`performGetMyBillingInfo`/
  `performCreateBillingPortalSession` functions. Verified line-by-line
  (by me directly, not just the reviewing subagent) that every removed
  line reappears verbatim in the extracted function — no behavior change.
- **Tests**: `stripe-server.test.ts`, 18/18 passing.
- **Migration dependency**: none — reads `subscription_state`, already
  shipped in `2cce874`.
- **Production verification needed**: none (no behavior change).
- **Remaining risk**: none known.

### 1.5 — Missing subscription-gate on WhatsApp/widget clarification flow
- **Commit**: `aaf9f7e`
- **Finding**: `createClarifyingLead`/`finalizeLeadWithQuote` (the two
  public server functions a WhatsApp/widget clarification round-trip
  calls) never checked `hasActiveSubscriptionForOwner` — every other
  public intake path (`createLead`, `createFlaggedLead`) already enforced
  it, but these two were missed. A canceled or never-subscribed tenant's
  public WhatsApp/widget clarification flow was reachable indefinitely.
- **Fix**: added the same gate, same generic "service unavailable"
  message as the existing tenant-not-found case (so a visitor can't
  distinguish "wrong slug" from "subscription canceled"). Also extracted
  both handlers into plain, testable `perform*` functions (same pattern
  as 1.4), wrapped in `createServerOnlyFn` since this module is
  client-imported for `getTenantForQuote`.
- **Tests**: `public-lead-server.test.ts` (new), 6/6 passing.
- **Migration dependency**: none — depends only on
  `hasActiveSubscriptionForOwner`, already shipped in `2cce874`.
- **Production verification needed**: none beyond the deploy.
- **Remaining risk**: none known.

### 1.6 — Reconciliation-script race against the live Stripe webhook
- **Commit**: `e1136e4`
- **Finding**: `scripts/reconcile-subscription-metadata.ts`'s write path
  used to upsert `subscription_state` directly from a stale, bulk-fetched
  Stripe snapshot — a concurrent webhook event landing between the bulk
  pass and the script's write could be silently overwritten by older
  data.
- **Fix**: `reconcileOneUser` now calls the exact same claim-fenced
  `writeSubscriptionState` the live webhook uses, re-fetching that one
  user's Stripe state fresh inside the claim before writing; aborts
  (`stale_at_write_time`) rather than applying a decision that's no
  longer current. `pg-migration-verification.sh` gains additive test
  coverage for `claim_stripe_event`/`complete_stripe_event`/
  `fail_stripe_event` (already-shipped functions from `2cce874` — no new
  schema).
- **Tests**: `reconcile-subscription-metadata.test.ts`, 24/24 passing;
  `pg-migration-verification.sh`, 23/23 checks against a real disposable
  Postgres.
- **Migration dependency**: none new.
- **Production verification needed**: **none from this push** — this is
  a manually-invoked, re-runnable backfill script, default dry-run
  (`--apply` required to write). Committing/pushing its source does not
  execute it. **Running it with `--apply` against production is a
  separate action requiring its own explicit authorization** — not
  implied by this push, and not done as part of this work.
- **Remaining risk**: none from the push itself. If/when `--apply` is
  actually run against production, review its dry-run output first (it
  prints a reconciled/unchanged/no-Stripe-customer/ambiguous/error
  summary and a `flagged` list of anything needing manual review).

---

### 1.7 — WhatsApp AI-to-AI / non-progressing-loop guard 🟢 PUSHED
- **Commit**: `d1d1ef0` (pushed). Originally committed as `e3b1172`/`da22d34`,
  held back pending migration coordination, then cherry-picked onto
  `main` as `d1d1ef0` once the migration was confirmed live — same diff,
  new hash, since the original commits had already been superseded by a
  local reorder and a revert along the way (see the process note in §3).
- **Finding**: a live incident where this app's own AI replied to an
  automated counterpart (e.g. Meta's own Business AI feature) with
  neither side recognizing the exchange wasn't progressing — bounded only
  by the 24-hour messaging window, API cost, or manual intervention.
- **Fix**: `0024_whatsapp_loop_guards.sql` (new tables
  `whatsapp_interaction_events` — append-only evidence log —  and
  `whatsapp_loop_guards` — current pause state — plus functions
  `record_whatsapp_interaction`, `claim_whatsapp_loop_notice`,
  `release_whatsapp_loop_notice_claim`, `mark_whatsapp_loop_notice_sent`,
  `resume_whatsapp_loop_guard`). Every automated WhatsApp send now funnels
  through `sendGuardedReply`, which checks the guard first and **fails
  closed** (no automated reply) if the check itself errors. Also closes a
  confirmed bypass (the webhook error-fallback message used to send
  directly, skipping the guard) and adds Twilio `MessageSid` dedup
  (reuses the pre-existing `whatsapp_processed_messages` table from
  migration `0007` — not a new dependency on `0024`).
- **Tests**: `whatsapp-loop-guard-server.test.ts` +
  `whatsapp-conversation-server.test.ts`, 60/60 passing. Full repo suite
  250/250, `tsc` clean, `bun run build` clean.
- **Migration dependency**: `0024_whatsapp_loop_guards.sql` — **confirmed
  applied to production on 2026-10-18**, via the Supabase SQL Editor.
  Verified with a combined query covering all 4 checks (2 tables, 5
  functions, RLS on both tables, `leads` constraint widened to include
  `loop_suspected`) — all 10 rows returned `true`, zero `MISSING`.
  Confirmed before applying, separately, that the `leads_flag_type_check`
  constraint this migration drops/recreates existed exactly as expected
  (`convalidated: true`, all 5 pre-existing flag values present,
  `loop_suspected` not yet among them) — so the one named-constraint
  dependency the migration assumes was verified, not guessed.
- **Why the blocker mattered** (resolved, kept for the record): every
  guard function fails **closed** on error (RPC/table missing → treated
  as "tripped" → automated reply suppressed) — deploying before `0024`
  was live would have silently paused every automated WhatsApp reply
  across every tenant. Not a live risk anymore now that the migration is
  confirmed applied first.
- **Deployment status**: pushed to `origin/main` as `d1d1ef0`
  (`deac3ac..d1d1ef0`, fast-forward, no force). Will deploy on Vercel's
  next build of `main`.
- **Production verification still worth doing** (post-deploy, not
  blocking): send a real WhatsApp test message through a connected tenant
  and confirm a normal automated reply still goes out (proves the guard
  isn't spuriously tripping on legitimate traffic now that it's live
  against the real schema) — not yet performed as part of this push.
- **Next action**: none required from me; optional for you — the
  live-traffic smoke test above, whenever convenient.

### 1.8 — Signup page missing Terms/Privacy consent links 🟢 PUSHED
- **Commit**: `20c9292`
- **Finding**: `signup.tsx` renders no `SiteFooter`/`SiteHeader` and had
  no Terms/Privacy link, checkbox, or text anywhere on the page — a user
  could create a full account (email, password) without the signup flow
  ever surfacing either document, even though `/terms` and `/privacy` are
  real pages already linked elsewhere (site footer).
- **Fix**: added a standard "By creating an account, you agree to our
  Terms and Privacy Policy" line directly below the submit button,
  linking to the existing `/terms` and `/privacy` routes.
- **Tests**: markup-only change, no new logic — `tsc` clean, build clean,
  full suite 250/250 unaffected.
- **Migration dependency**: none.
- **Production verification needed**: none beyond the deploy — visually
  confirm the line renders correctly once live.
- **Remaining risk**: none. Note this resolves only the signup-links half
  of the original combined finding — the Privacy Policy's separate
  missing-Meta-as-processor gap is resolved separately, see §1.9.

### 1.9 — Privacy Policy omits Meta as a processor 🟢 PUSHED
- **Commit**: `b1aa1a6`
- **Finding**: `privacy.tsx` listed Anthropic, Twilio, Stripe, and
  Supabase as processors but never mentioned Meta, despite a full Meta
  WhatsApp Cloud API integration already built.
- **Fix**: added a Meta entry to the processor list, matching the
  existing format/tone, noting messages for Cloud-API-connected tenants
  go through Meta's platform instead of Twilio's. Bumped the "Last
  updated" date.
- **Tests**: markup-only, `tsc` clean, full suite unaffected.
- **Migration dependency**: none. **Production verification**: none
  beyond the deploy.

### 1.10 — WhatsApp opt-out (STOP/UNSUBSCRIBE/CANCEL, English+Spanish) 🟢 PUSHED
- **Status**: implemented, adversarially reviewed, one High-severity
  defect found and fixed (see below). Migration `0025` applied to
  production and verified (7/7 checks). Pushed as `8a2f49e`, deployed,
  no runtime errors observed.
- **Finding**: no opt-out handling existed anywhere in the WhatsApp
  pipeline — a customer texting STOP had no effect; both the automated
  and operator-initiated send paths would keep messaging them.
- **Files changed/added** (12 total, pushed as `8a2f49e`):
  - New `supabase/migrations/0025_whatsapp_opt_outs.sql` — one table
    (`whatsapp_opt_outs`, same `(tenant_id, phone)` key shape and
    zero-access RLS posture as `whatsapp_loop_guards`), five
    `SECURITY DEFINER`/`service_role`-only functions
    (`record_whatsapp_opt_out`, `claim_whatsapp_opt_out_confirmation`,
    `release_whatsapp_opt_out_confirmation`,
    `mark_whatsapp_opt_out_confirmation_sent`,
    `resume_whatsapp_opt_out`).
  - New `src/lib/whatsapp-opt-out-server.ts` — keyword detection
    (exact-match, not substring, after normalizing
    punctuation/whitespace/case — see its own comment for the
    false-positive reasoning), the RPC wrappers, `OptOutCheckFailed`
    (fail-closed on a check error) and `WhatsAppOptedOutError`.
  - **Enforcement added at the actual outbound-sending layer, not just
    the callers** — `src/lib/twilio-server.ts` (`sendWhatsAppMessage`),
    `src/lib/meta-whatsapp-server.ts` (`sendWhatsAppMessageMeta`,
    `sendWhatsAppTemplateMessage`) each now require a `tenantId` param
    and check opt-out status as the first line before any HTTP call —
    this is what makes it bypass-proof: every send in the codebase,
    present or future, funnels through one of these three functions.
    Each gained a narrow `allowWhileOptedOut` escape hatch, used by
    exactly one caller (the opt-out confirmation message itself, which
    must legitimately reach a number the instant it opts out).
  - `src/lib/whatsapp-conversation-server.ts` — `handleOptOutState` runs
    as the first thing in `handleInboundWhatsAppMessage`, before even the
    loop guard; `handleOptOutConfirmation`/`sendOptInConfirmation` mirror
    the loop guard's own proven claim→send→confirm crash-safety sequence.
    `ChannelAdapter.sendMessage` gained the `allowWhileOptedOut` param,
    threaded through both channel adapters.
  - `src/routes/api.whatsapp.webhook.tsx` — Twilio's adapter moved from a
    module-level constant to per-request (needed `tenant.id` in closure
    to pass through).
  - `src/routes/api.whatsapp.meta-webhook.tsx` — passes `tenantId`
    through; a `WhatsAppOptedOutError` is no longer mistaken for a broken
    connection (same treatment as the existing 24h-window case).
  - `src/lib/lead-reply-server.ts` — the operator send path (which had no
    other guard at all) now passes `tenantId` and returns a new
    `{status: "opted_out"}` result instead of a generic error.
  - `src/routes/dashboard.leads.$id.index.tsx` — handles the new
    `opted_out` status with a clear toast in both the reply and
    template-send flows.
  - `scripts/pg-whatsapp-opt-out-check.sh` — new, real-Postgres
    verification script, mirroring `pg-whatsapp-loop-guard-check.sh`.
- **A real concurrency bug was found and fixed during implementation**
  (not shipped broken, caught before testing): the first draft of
  `record_whatsapp_opt_out` tried to infer "did I just create this row"
  by re-reading timestamps after an `INSERT ... ON CONFLICT DO NOTHING`,
  which could let two genuinely concurrent first-ever STOP messages both
  compute `just_opted_out = true` and both queue a confirmation.
  Rewritten to use `RETURNING` on the insert itself to detect the winner
  unambiguously — proven correct against real concurrent Postgres
  connections, not just reasoned about (see below).
- **Tests**:
  - `whatsapp-opt-out-server.test.ts` (new) — keyword matching (all
    English/Spanish keywords, case variations, punctuation, and
    specifically the false-positive guard: "can you cancel the old
    quote" / "please stop by tomorrow" do NOT match), `isOptedOut`'s
    timestamp-comparison branches, fail-closed on a DB error.
  - `whatsapp-conversation-server.test.ts` — 8 integration tests: STOP
    records opt-out + exactly one confirmation; a repeat STOP sends no
    second confirmation; an ordinary message from an opted-out number
    gets zero reply (no auto-resume); START resumes + sends exactly one
    opt-in confirmation; START while NOT opted out falls through to
    normal processing; two concurrent STOP messages (simulated) only
    ever produce one confirmation; plus two phone-normalization
    regression tests (below). Structural "every send goes through a
    gated chokepoint" guard updated from 2 to 4 expected call sites.
  - `scripts/pg-whatsapp-opt-out-check.sh` — **run against a real
    disposable local Postgres, 28/28 checks passing**, including three
    genuine-concurrency sections (real, separate `psql` processes
    racing `record_whatsapp_opt_out`, `claim_whatsapp_opt_out_confirmation`,
    and — added during the adversarial review — a repeat STOP racing a
    resume on the same already-opted-out row) that specifically prove
    the concurrency guarantees, not just reasoned about.
  - Full app suite: 271/271 passing. `tsc` clean. `bun run build` clean.
- **A second defect was found by a dedicated adversarial review and
  fixed** — HIGH severity: `handleOptOutState` used the raw,
  unnormalized inbound phone for its `whatsapp_opt_outs` keys
  (`recordOptOut`/`isOptedOut`/`resumeOptOut`), while the enforcement
  checks inside the three send functions always normalized via
  `normalizePhone`. If a raw phone format ever diverged from its
  normalized form, the write and read keys would silently mismatch —
  the worst-case outcome for this feature: a customer's STOP silently
  failing to actually block future messages, or a dashboard resume
  silently failing to find the row. Fixed by normalizing once in
  `handleOptOutState` and threading that normalized value through
  `handleOptOutConfirmation`'s own claim/release/mark-sent calls too
  (which had the identical issue one step later) — `adapter.sendMessage`
  still delivers to the original, unnormalized address; normalization is
  a DB-key concern only. Two regression tests were written and — not
  just asserted — **empirically proven** to fail against the pre-fix
  code (reverted temporarily, confirmed the exact expected failure, then
  restored) and pass against the corrected version.
- **Known, documented limitation — not eliminated**: there's an
  unavoidable gap between checking opt-out status and the actual HTTP
  call to Twilio/Meta — no way to make that atomic across an external API
  call. Documented in `whatsapp-opt-out-server.ts`'s own header comment.
  What IS proven race-safe: the database write itself, and the
  confirmation-send dedup, under genuine concurrent connections.
- **Also documented, deliberately not built this round**: no dashboard UI
  button for the owner-resume action (`resumeWhatsAppOptOut` exists as an
  auth-gated server function, same as the loop guard's own
  `resumeWhatsAppAutomation`, which also has no UI button yet — consistent
  with existing precedent in this codebase, not a new gap). Opt-out
  events aren't currently surfaced in a lead's message thread or anywhere
  else visible to the owner — pure background enforcement state for now.
- **Migration dependency**: `0025_whatsapp_opt_outs.sql` — applied to
  production and verified via a 7-check query (all `true`) before this
  was pushed. An earlier verification attempt returned all `false`
  (the migration genuinely hadn't been applied yet despite an initial
  belief that it had) — caught by this exact gate, re-applied correctly,
  re-verified, then pushed.
- **Deployment**: pushed as `8a2f49e` (`9049574..8a2f49e`). Vercel
  production build succeeded (`dpl_2LZdb6tace6feKuUxh4xthwv7s9P`, READY).
  No runtime errors observed in the hour after deploy.
- **Production verification still worth doing**: a real WhatsApp STOP
  message through a connected tenant, whenever convenient — not
  performed as part of this push (no customer was contacted, no real
  opt-out state was touched, per explicit instruction).

### 1.11 — Privacy Policy photo-retention wording covered only Twilio 🟢 PUSHED
- **Commit**: `c58cee4`
- **Finding**: "How long we keep it" referenced only Twilio's media
  retention window, despite Meta being listed elsewhere in the same
  policy as a second real WhatsApp processor.
- **Fix**: generalized to cover both, without inventing a specific
  retention duration for either provider.
- **Tests**: markup-only. `tsc` clean, full suite unaffected.
- **Migration dependency**: none.

### 1.12 — WhatsApp connect dialog didn't disclose data processing 🟢 PUSHED
- **Commit**: `96a24b6`
- **Finding**: the Meta Embedded Signup confirmation dialog's checkbox
  ("I've read this and understand what to expect") only ever gated
  acknowledgment of a walkthrough of *Meta's own screens* — never named
  what Job It Ready itself does with WhatsApp data, never linked the
  Privacy Policy, and the acknowledgment was never persisted anywhere.
  Confirmed via a dedicated review of `ConnectWhatsAppMeta.tsx`,
  `completeMetaWhatsAppSignup`, and the `whatsapp_connections` schema —
  this closes the item previously tracked at §3.2.
- **Fix**:
  - `WhatsAppSetupGuide.tsx` — new opening paragraph naming Meta's
    WhatsApp Business Platform and Anthropic's Claude API explicitly,
    with a real `/privacy` link. Shown on both surfaces that already
    share this content (standalone guide page + the connect dialog).
    `WHATSAPP_CONSENT_NOTICE_VERSION` exported so a specific notice
    version is identifiable later, not just "something was shown."
  - `ConnectWhatsAppMeta.tsx` — checkbox label reworded to name what it
    covers; sends the notice version to the server.
  - `meta-whatsapp-server.ts` — `completeMetaWhatsAppSignup` requires
    `consentNoticeVersion` and **rejects the request server-side if
    missing** — enforced at the function that actually completes the
    connection, not just by the dialog's disabled button.
  - New migration `0026_whatsapp_connection_consent.sql` — two columns
    on the *existing* `whatsapp_connections` table
    (`consent_notice_version`, `consent_acknowledged_at`), deliberately
    not a new dedicated `whatsapp_consents` table. Explicitly documented
    as operational evidence only, not a complete legal consent record.
- **Tests**: `ConnectWhatsAppMeta.test.ts` (new) — 8 structural
  regression tests (source-text matching, no component-test
  infrastructure exists in this codebase) proving `handleConnect()` is
  only reachable via the gated Continue button, the checkbox resets on
  dialog close, and the consent version is actually transmitted. Full
  suite 279/279 passing, `tsc` clean, build clean.
- **Migration dependency**: `0026` — applied to production and verified
  (3/3 checks: both columns present with correct types, RLS unchanged)
  before this was pushed.
- **Deployment**: pushed, Vercel production build succeeded
  (`dpl_2XVczPwEfyASSvQSasrN6wN4wnRD`, READY, aliased to
  `jobitready.com`). No runtime errors observed.
- **Explicitly NOT resolved by this change, stated plainly**: WABA-access
  authorization itself still happens entirely on Meta's own screens, not
  in this dialog — this component was never the right place to represent
  that. Any consent the business owes its own customers is also outside
  this component's reach. Neither is claimed to be solved here.
- **Known limitation**: `bun run lint` hung indefinitely on this
  project (two processes stuck at ~99% CPU for 15-20+ minutes, killed
  manually) — could not be run as a check for this change. Pre-existing
  issue, not introduced by this work; `tsc` and the full test suite are
  both clean.

### 1.13 — Photo Intelligence (WhatsApp photo-aware reassessment) + a critical lead-persistence defect found and fixed along the way 🟠 implemented + tested locally, not yet committed/pushed/applied anywhere

**Feature context**: a dedicated investigation (2026-10-19) into whether the AI
"sees" photos correctly (confirmed working, proven via tests rather than
assumed) led to building Priority 2 — a photo sent on an already-quoted
WhatsApp lead is now classified as evidence for the *same* job, a genuinely
*different* job, or *ambiguous*, instead of always being assumed to be a new
job. New: `classifyFollowUpPhotoIntent` (estimate-server.ts),
`handleQuotedFollowUpPhoto` (whatsapp-conversation-server.ts). Also fixed in
the same pass: the `confidence` field's prompt wording used to say "your
confidence in reading the photo" unconditionally, risking the model implying
it saw a photo that was never sent — reworded to be evidence-general.

**Critical defect found, not assumed — proven against two separate real
disposable Postgres instances**: building the reassessment path required
calling `finalizeLeadWithQuote`/`update_lead_with_line_items`
(`0019_lead_write_atomicity.sql`) a **second** time on an already-finalized
lead — something no existing caller (QuoteFlow.tsx, the WhatsApp
clarification-finalize path) had ever done. This surfaced two real,
previously-undetected bugs in that function, neither ever covered by any
existing test (mocked or real-Postgres — confirmed by `grep`, zero hits):
1. **Line-item duplication**: the function only ever `INSERT`ed line items,
   never deleted the lead's existing ones first — a reassessment left BOTH
   old and new line items persisted (proven: 2 rows where 1 was expected).
2. **Stale flags never clearing**: `p_status = null` meant "leave
   flag_type/flag_reason untouched," so a lead that became fully priced
   after being flagged `pending_negotiated_price`/`partially_priced` kept
   that stale flag forever.

Initially mitigated (temporary, local-only): disabled the unsafe call,
routed a materially-changed reassessment to a manual-review flag instead
(plain, tenant-scoped, error/zero-row-checked `leads` UPDATE — never the
buggy RPC), with a conservative customer message. Verified with dedicated
tests (flag-update success, error, and zero-rows cases).

**Permanent fix implemented**: `supabase/migrations/0028_fix_lead_reassessment_atomicity.sql`
— `update_lead_with_line_items` now deletes existing line items before
inserting the new set (same transaction, still atomic), and requires every
caller to state the lead's real target status/flag_type/flag_reason
explicitly (no more null-means-leave-alone). Critically, the fix also
protects **unrelated operational flags** (`needs_human_review`,
`outside_service_scope`, `loop_suspected`, `conflicting_information`) from
ever being cleared by a pricing-driven reassessment — only the two flags
this function actually owns (`pending_negotiated_price`, `partially_priced`)
can be set/cleared by it; any other existing flag leaves status/flag_type/
flag_reason completely untouched. `performFinalizeLeadWithQuote`
(public-lead-server.ts) updated to pass `status: "new"` instead of `null`
for the normal, non-flagged case. The mitigation's manual-review-flag code
was removed; the reassessment path now calls the (now-fixed)
`finalizeLeadWithQuote` directly again.

**New permanent regression coverage**: `scripts/pg-lead-reassessment-check.sh`
— applies every real migration file from disk (0001–0027) against a
throwaway, disposable local Postgres cluster, runs both defect
reproductions against the ORIGINAL function (confirmed **red** — both
fail, as predicted), applies `0028` on the same live cluster, and re-runs
the identical scenarios (confirmed **green**). Also covers: initial
creation unaffected; added/removed/repriced items in one call; all four
unrelated operational flags surviving a pricing reassessment; a legitimate
pricing-flag transition; a forced real error rolling back completely
(diagnosis and line items unchanged); a wrong-tenant call matching zero
rows with the other tenant's data untouched; two genuinely separate `psql`
connections racing the same lead serializing to exactly one consistent
row; the exact existing-caller call shape producing identical output to
before. **35/35 passed**, never previously run before this work (confirmed:
`grep -rl "update_lead_with_line_items" scripts/*.sh` was empty before this
migration existed).

**🟢 Deployment-ordering hazard — FIXED locally (2026-10-19), not yet
applied anywhere.** A final adversarial review of this fix found (not a
logic bug in the function itself — a deployment-ordering hazard) that if
migration `0028` were applied to production **before** the corresponding
`public-lead-server.ts` code change deploys, every call to
`finalizeLeadWithQuote`'s normal/non-flagged branch from the **still-live
old code** (which passes `status: null`) would throw a real
`null value in column "status" ... violates not-null constraint` error —
breaking both the WhatsApp clarification-finalize path and the public
QuoteFlow.tsx widget's quote completion for every tenant until the new code
deployed. (The reverse order — new code against the old function — was
already proven safe.) **Fixed**: `0028` now uses
`coalesce(p_status, 'new')` specifically for the `status` column (the one
NOT NULL column affected) — `flag_type`/`flag_reason` needed no such
change, they're nullable and `null` already correctly means "no flag"
under both the old and new caller. The migration is now safely deployable
in **either order** relative to the application code deploy — no longer an
exception to this project's usual migration-first workflow. Proven, not
assumed: a new, dedicated real-Postgres check calls the FIXED function with
`p_status = NULL` (the exact shape the still-live old code produces) and
confirms it succeeds, resolves `status` to `'new'`, and writes the correct
line items — 4 new checks, all passing.

**Verification results**: `scripts/pg-lead-reassessment-check.sh` **39/39**
(35 from the original fix + 4 new for this deployment-ordering scenario;
every original scenario — red→green, rollback, tenant isolation, unrelated-
flag preservation, pricing-flag transitions, concurrency, existing-caller
compatibility — re-confirmed still passing against the doubly-fixed
function) · targeted Vitest (`whatsapp-conversation-server.test.ts` +
`public-lead-server.test.ts`) 51/51 · full suite 310/310 · `tsc --noEmit`
clean · lint: zero new findings in production code touched
(`public-lead-server.ts`, `whatsapp-conversation-server.ts`, both
unchanged from before — this fix only touched the SQL migration and the
test script); the test file's findings are the same pre-existing
`any`-mock-casting convention already used throughout it (unchanged count)
· `bun run build` clean.

**Explicitly not yet done**: the live Supabase environment has not been
inspected or migrated in any way — every check above ran against disposable
local Postgres instances only, never this project's real database. Nothing
in this entry has been committed, staged, pushed, or deployed.

**Separate, pre-existing, out-of-scope observation surfaced along the
way**: `leads-server.ts`'s `saveLeadLineItems` (the dashboard's own manual
"owner edits line items" mutation) already does the identical
delete-then-insert pattern this fix uses — but as two separate,
non-atomic Supabase client calls, not inside one transaction/function call.
Same theoretical crash-window gap `0019` was originally written to close
for the other two paths, never addressed for this one. Flagged as a
genuine follow-up item for a later, separate task — not expanded into this
one's scope.

---

## 2. Preserved, untouched (not part of any commit above)

- `ROADMAP.md` — still has its own uncommitted edits from earlier this
  engagement (the "Future Database Tables" section). Left alone
  deliberately; not required for any of the fixes above and mixes many
  topics, so bundling it into any one commit would have violated the
  "only the files required" rule for each.
- Pre-existing untracked folders: `Home folder/`, `graphify-out/`,
  `jir-carousel-photos/` — not security-relevant, never touched.
- Local safety branch `backup-before-reorder` — created before a local
  commit reorder (see note below), still present. Safe to delete once
  you're satisfied the reorder didn't lose anything (it didn't — verified
  via `git diff --stat` before and after, full test suite + tsc clean
  after).

**Process note on the reorder**: `e3b1172` (WhatsApp) and `603a7f9`
(price-sheet) were originally committed in that order, which would have
forced the blocked WhatsApp commit to push alongside anything after it.
Since neither had been pushed yet, I reordered them locally (via
`git reset --soft` + rebuilding each commit from the same diffs, not an
interactive rebase) so price-sheet, the Stripe refactor, the
subscription-gate fix, and the reconciliation-script fix could all push
independently, with WhatsApp (`da22d34`) left last and unpushed. This did
not rewrite any already-pushed commit — only local-only history that had
never left this machine.

**Process note on a mistake and its fix**: committing the tracker doc
itself on top of `da22d34` meant the next `git push origin main` pushed
the tracker commit AND the still-blocked WhatsApp commit together — an
error, caught within minutes. Fixed with `git revert da22d34 --no-edit`
(commit `deac3ac`), pushed immediately — a new commit undoing the change,
not a force-push or history rewrite, so it's fully visible in the log.
Once the migration was confirmed applied (see §1.7), `da22d34` was
cherry-picked back onto `main` as `d1d1ef0` and pushed for real. Net
effect on the repo: `da22d34`'s changes were briefly live, reverted
within minutes, then correctly re-applied once the migration was
actually confirmed — the log (`da22d34` → `1842651` → `deac3ac` →
`d1d1ef0`) records exactly that sequence rather than hiding it.

---

## 3. Next Security Phase — read-only findings (no fixes implemented)

Re-verified against current code where noted; not re-investigated where
nothing in this session's changes touched the relevant area (dates reflect
when each was last confirmed against live code).

### ~~3.1 — WhatsApp opt-out / STOP handling~~ → implemented, see §1.10
No longer an open finding — implemented and tested locally per your
approved design (STOP/UNSUBSCRIBE/CANCEL/QUIT/END + Spanish
ALTO/CANCELAR/BASTA, scoped by `(tenant_id, phone)`, enforced at the
actual outbound-sending layer for both automated and operator paths).
Awaiting your review and separate approval to commit/apply the
migration/push — see §1.10 for the complete writeup.

### 3.2 — Meta/customer consent and authorization — owner-facing half resolved, see §1.12 ⚪
**Owner-facing half (the Meta connect dialog)**: resolved, §1.12. The
dialog now discloses what Job It Ready processes and links the Privacy
Policy before connecting; operational evidence of the acknowledgment is
stored on `whatsapp_connections`.
**End-customer consent/contact-evidence half, still applies as before**:
**Decision made (2026-10-18)**: no dedicated consent table — leaning on
existing evidence instead. `whatsapp_interaction_events` (from the loop
guard, `0024`) already timestamps every inbound message per
`(tenant_id, phone)`, which can serve as evidence of when a customer
first made contact, without building anything new.
**Explicit limitation, not silently assumed**: a customer-initiated
message is NOT being treated as blanket consent for every type of
processing or communication — it only establishes the
"customer-initiated contact" fact WhatsApp's own platform policy already
requires before a business can message someone. If a broader, formally-
labeled consent record is ever needed (e.g. for a specific legal
requirement beyond that), that's a separate, later review — not resolved
or built here.
**Dependencies**: none on other open items, but should be revisited
before Meta Advanced Access traffic scales up if requirements change.

### 3.3 — Supabase Auth rate limits / app-level protection ✅ resolved (checked live, 2026-11-06; independently re-verified 2026-11-06)
Login (`login.tsx:43`), signup (`signup.tsx:43-47`), password-reset
request (`forgot-password.tsx:42-44`), and password-reset completion
(`reset-password.tsx:70`) all call Supabase's client SDK directly — zero
`createServerFn`, zero app-level throttling of their own. A real per-IP
rate-limit pattern exists (`enforceTenantRateLimit`, `public-lead-server.ts`)
but is wired only into public lead/quote endpoints, never auth.

**Previously unknown, now confirmed** by checking the live Dashboard
(Authentication → Rate Limits) directly: every value is at Supabase's own
documented platform default, nothing loosened —
- Sign-ups and sign-ins (the one that matters for login brute-forcing):
  30 requests/5 min per IP (360/hour)
- Token refresh: 150 requests/5 min per IP
- Token verification (OTP/magic link): 30 requests/5 min per IP
- Anonymous sign-ins: 30/hour per IP
- "IP address forwarding" is off, which is correct here, not a gap — it
  only matters when a secret key proxies auth requests server-side on
  behalf of many users; this app's auth calls go straight from each
  visitor's own browser to Supabase, so Auth already sees their real IP.

**Independently re-verified** (separate review, instructed to treat the
above as an unverified claim, not ground truth): confirmed the four
default values directly against Supabase's own documentation (not citing
this entry), and confirmed `login.tsx`/`signup.tsx`/`forgot-password.tsx`/
`reset-password.tsx` all call the Supabase client SDK with the public
publishable key, never a secret key or server proxy. Added evidence this
entry didn't have: the two IP-reading call sites this app's own code has
(`getClientIpHash`, used only for rate-limiting, never auth) read
`X-Forwarded-For` — and Vercel's own documentation states it overwrites
that header and does not forward externally-supplied values, specifically
to prevent spoofing. That's the fact that actually closes "could someone
fake their IP," not just the architectural absence of a proxy point.

**Decision:** no app-level throttling added on top. These are real,
platform-enforced limits (not zero protection), signups are currently
paused anyway (see the capacity-pause change on `/signup`), and this
project has exactly one real user right now — building the restructuring
needed to route login/signup/reset through a server function first (they
currently call the Supabase client SDK directly from the browser) isn't
justified by the current risk. Revisit if/when real third-party signups
resume and traffic grows.

### 3.4 — Audit logging 🟠 implemented + tested locally, awaiting migration review/apply
**Scope approved (2026-10-18)**: subscription/billing state changes,
WhatsApp (Meta) connect/disconnect, and lead deletion — the last one
specifically because `deleteLead`/`deleteLeads` currently leave zero
trace, a hard delete with cascade and no record of who deleted what or
when.
**Files changed/added** (6 total, all currently uncommitted):
- New `supabase/migrations/0027_audit_log.sql` — one append-only table
  (`audit_log`: `tenant_id`, `actor_type` in `('owner','system')`,
  `actor_user_id` nullable, `action` in `('subscription.state_changed',
  'whatsapp.connected','whatsapp.disconnected','lead.deleted')`,
  `target_type`, `target_id` text (not a polymorphic FK — see the
  migration's own comment), `metadata` jsonb, `created_at`), two indexes
  (`(tenant_id, created_at desc)`, `(action, created_at desc)`), same
  zero-access RLS posture as `whatsapp_connections`/`whatsapp_opt_outs`
  (service-role only, nothing readable/writable from a tenant's own
  session).
- New `src/lib/audit-log-server.ts` — `recordAuditLog`, the single shared
  writer all three call sites use. **Deliberately fails OPEN, not
  closed** — unlike the opt-out/loop-guard pattern, a failed or missing-
  table audit insert is caught, logged, and never blocks, undoes, or
  surfaces as an error for the real action it's recording. This means
  (unlike §1.10/§1.7) shipping this code before the migration is applied
  would not break anything — it would just silently no-op the audit
  insert until `0027` is live. Still following the same
  review-then-apply-then-verify-then-push gate as every other migration
  this session, just noting the risk profile is lower.
- `src/routes/api.stripe.webhook.tsx` — `writeSubscriptionState` (the one
  chokepoint both the live webhook and `reconcile-subscription-metadata.ts`
  already go through) now resolves the owning tenant and records
  `subscription.state_changed` after the authoritative write succeeds.
  `actor_type` is always `'system'` here — no human is in the loop for
  either caller.
- `src/lib/meta-whatsapp-server.ts` — `completeMetaWhatsAppSignup` records
  `whatsapp.connected` after the connection reaches `'online'`;
  `disconnectMetaWhatsApp` records `whatsapp.disconnected` after the
  update succeeds. Both `actor_type: 'owner'`, `actor_user_id:
  context.userId` (the authenticated tenant owner who triggered it).
- `src/lib/leads-server.ts` — `deleteLead` records one `lead.deleted` row;
  `deleteLeads` records one row per deleted lead (not one row for the
  whole batch — keeps per-lead history queryable the same way regardless
  of whether it was deleted individually or in bulk), tagged
  `metadata: {bulk: true, batchSize}`.
**Tests**: `api.stripe.webhook.test.ts` gained 5 new tests against the
real, exported `writeSubscriptionState` (not a reimplementation) — the
audit row's shape, that the Stripe customer id never appears in
`metadata`, that a missing tenant row or a missing `audit_log` table
never affects the authoritative write, and that repeat writes each log
their own row (append-only, not upserted). `meta-whatsapp-server.ts` and
`leads-server.ts`'s new call sites have **no executable test** — same
pre-existing limitation noted in §1.3/§3.2 (bare `createServerFn` handlers
can't be invoked outside TanStack Start's server runtime in this test
environment) — verified only by direct source reading. Full suite
284/284 passing (up from 279), `tsc` clean, `bun run build` clean,
`bun run lint` clean (no new findings in the changed files after a
`prettier --write` pass incidentally fixed some pre-existing formatting
issues in files this touched).
**Migration dependency**: `0027_audit_log.sql` — **not yet applied to
production**. Written for your review below; once you've run it in the
Supabase SQL Editor and pasted back the verification query's result,
this gets committed and pushed, same gate as every migration this
session.
**Dependencies**: none, but worth doing before Meta Advanced Access goes
fully live, given WhatsApp credential handling is one of the more
sensitive areas that had zero audit trail until now.

### 3.5 — Session-token storage and XSS exposure ⚪ (architectural fact, not a new vulnerability)
**Re-confirmed 2026-10-18.** `src/integrations/supabase/client.ts` uses a
custom storage adapter: Supabase's session (access+refresh JWT) goes to
`localStorage` if "Remember me" is checked (default), `sessionStorage`
otherwise — same general exposure model as Supabase's own default
behavior. No other sensitive data found in Web Storage anywhere in `src/`
(one grep, zero other hits). This is a standard architectural tradeoff of
browser-storage session persistence vs. httpOnly cookies — an XSS
elsewhere in this client-rendered SPA could in principle read it, but no
XSS hunt was performed (out of scope for this pass) and none is known to
exist.
**Decision needed from you**: none required immediately; flagging as a
standing architectural fact. If this tool's security surface grows
(e.g. before a much larger customer base), migrating to httpOnly-cookie
session storage would remove this exposure class entirely — a larger
change, not proposed for implementation now.

### 3.6 — Other findings, resolved this session ⚪
- **Twilio webhook dedup** — was missing, fixed and now live as part of
  §1.7 (the WhatsApp commit, pushed as `d1d1ef0`): `MessageSid`-based
  dedup added, matching Meta's route.
- **Stripe webhook dedup** — has its own separate, durable claim-lease
  mechanism (`claim_stripe_event`/`complete_stripe_event`/
  `fail_stripe_event`, §1.2/§1.6), confirmed still correct, not reviewed
  further this round.

---

## 4. Summary of decisions needed from you

1. **Review the WhatsApp opt-out implementation (§1.10)** and decide
   whether to commit it, apply migration `0025`, verify it, and push —
   same gated process as §1.7's WhatsApp loop guard. This is the most
   consequential open item: the enforcement code already added to the
   three outbound-send functions would break ALL WhatsApp sending
   (not just opt-out) if it ever shipped before the migration is live.
2. Check Supabase's actual dashboard Auth rate-limit settings, then decide
   if app-level throttling is also needed (§3.3) — provider-setting lookup
   + product decision.
3. **Review and apply migration `0027_audit_log.sql` (§3.4)** — SQL below,
   run the verification query after, paste the result back so this can be
   committed and pushed.
4. Run the WhatsApp live-traffic smoke test noted in §1.7.
5. **Review and apply migration `0028_fix_lead_reassessment_atomicity.sql`
   (§1.13)** — the deployment-ordering hazard found in the prior review is
   now fixed locally and re-verified (39/39 real-Postgres checks); safe to
   apply in either order relative to the application code deploy. Same
   gated process as every other migration this session: review the SQL,
   apply via the Supabase SQL Editor, paste back verification query
   results, then this (and the corresponding `public-lead-server.ts`/
   `whatsapp-conversation-server.ts` changes) gets committed and pushed.

(Privacy Policy Meta disclosure — resolved, §1.9. Signup Terms/Privacy
links — resolved, §1.8. Meta/customer consent — resolved, §3.2, no new
table needed.)
