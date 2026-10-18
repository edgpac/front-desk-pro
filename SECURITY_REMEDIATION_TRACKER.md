# Security Remediation Tracker

Dated, authoritative log of every security-relevant fix found/built during
this engagement: what it is, what verifies it, what it depends on, and
whether it's actually live in production yet. Update this file as items
move between states — do not rely on commit messages or chat history alone
to answer "is X actually released."

**Status key**: 🟢 pushed to `origin/main` (will deploy on Vercel's next
build of that branch) · 🟡 committed locally, not pushed (blocked) · 🔵
read-only finding, no fix implemented yet · ⚪ reviewed, left as-is (not a
bug, or not in scope)

Last updated: 2026-10-18.

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
- **Migration dependency**: `0021`/`0022`/`0023` — shipped in this same
  commit, already applied (the commit includes the migration files
  themselves and this repo's migrations run via the normal deploy-time
  path — confirm with the team's actual migration-apply process if that's
  separate from app deploy; not re-verified against the live DB from here).
- **Production verification needed**: confirm `subscription_state` table
  exists in production with expected rows for existing subscribers.
- **Remaining risk**: none known.

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

## 2. Committed locally, NOT pushed — blocked

### 2.1 — WhatsApp AI-to-AI / non-progressing-loop guard
- **Commit**: `da22d34` (local only, one commit ahead of `origin/main`)
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
- **Migration dependency**: `0024_whatsapp_loop_guards.sql` — **not yet
  confirmed applied to production.** No mention of `0024` exists anywhere
  in `ROADMAP.md`, and the migration file was untracked until this
  engagement committed it — there is no record of it ever having been run
  against the production database.
- **Why this specific blocker matters**: every guard function above fails
  **closed** on error (RPC/table missing → treated as "tripped" →
  automated reply suppressed). If this code deploys before `0024` is
  live, **every single inbound WhatsApp message, across every tenant,
  gets paused and zero automated replies go out** — silently, from the
  app's own perspective ("fail closed" working as designed), but it would
  look to every tenant like the AI quoting pipeline simply stopped
  responding.
- **Approved way to apply + verify** (proposed — needs your execution,
  not mine): run `supabase/migrations/0024_whatsapp_loop_guards.sql`
  against production via the Supabase SQL Editor (the same flow used for
  every prior migration this engagement), then run:
  ```sql
  -- Confirm both tables exist
  select table_name from information_schema.tables
  where table_schema = 'public' and table_name in ('whatsapp_loop_guards', 'whatsapp_interaction_events');

  -- Confirm all five functions exist
  select routine_name from information_schema.routines
  where routine_schema = 'public' and routine_name in (
    'record_whatsapp_interaction', 'claim_whatsapp_loop_notice',
    'release_whatsapp_loop_notice_claim', 'mark_whatsapp_loop_notice_sent',
    'resume_whatsapp_loop_guard'
  );

  -- Confirm RLS is enabled on both new tables (service-role only, same as other WhatsApp tables)
  select relname, relrowsecurity from pg_class
  where relname in ('whatsapp_loop_guards', 'whatsapp_interaction_events');
  ```
  All three queries should return the expected rows (2, 5, and 2
  respectively, with `relrowsecurity = true`). Once you confirm this,
  tell me and I'll push `da22d34` — a straightforward fast-forward, no
  further review needed on my end since it's already fully tested and
  isolated.
- **Next action**: **yours** — apply + verify the migration, then
  authorize the push.

---

## 3. Preserved, untouched (not part of any commit above)

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
independently, with WhatsApp left last and unpushed. This did not rewrite
any already-pushed commit — only local-only history that had never left
this machine.

---

## 4. Next Security Phase — read-only findings (no fixes implemented)

Re-verified against current code where noted; not re-investigated where
nothing in this session's changes touched the relevant area (dates reflect
when each was last confirmed against live code).

### 4.1 — WhatsApp opt-out / STOP handling 🔵
**Confirmed still open** (re-verified 2026-10-18, current code). No
opt-out/STOP/unsubscribe keyword handling anywhere in
`whatsapp-conversation-server.ts`, `lead-reply-server.ts`,
`meta-whatsapp-server.ts`, or either webhook route. No
`whatsapp_opt_outs` table. The loop-guard feature (§2.1) is confirmed
unrelated — spam/loop detection only, no opt-out semantics.
**Outbound chokepoints** (where an opt-out check would need to live):
AI-automated path funnels through `sendGuardedReply`
(`whatsapp-conversation-server.ts:160-191`, ~14 call sites); operator path
(`lead-reply-server.ts:73,86`) has no guard at all, Twilio or Meta.
**Decision needed from you**: what "opted out" should mean operationally
(suppress all future sends to that phone? For that tenant only, or
globally?) — this is a product decision, not a code one.
**Tests required**: once a design is approved, unit tests on the
opt-out-check function + an integration-style test confirming a flagged
number gets no automated or operator reply.
**Dependencies**: none on other open items.

### 4.2 — Meta/customer consent and authorization 🔵
**Confirmed still open** (re-verified 2026-10-18). Grepped
`ConnectWhatsAppMeta.tsx`, `meta-whatsapp-server.ts`, and
`dashboard.settings.business.tsx` for consent/opt-in language: zero hits.
The Meta Embedded Signup flow connects a WABA and stores credentials but
records no customer-consent artifact anywhere.
**Decision needed from you**: what consent model WhatsApp/Meta policy
actually requires here — a product/legal question I can't resolve from
code alone.
**Dependencies**: none on other open items, but should be decided before
Meta Advanced Access traffic scales up.

### 4.3 — Privacy Policy processor disclosure + signup Terms/Privacy links 🔵
**Confirmed still open, two distinct findings** (re-verified 2026-10-18,
read both files in full):
- `src/routes/privacy.tsx` lists Anthropic, Twilio, Stripe, and Supabase
  as processors but **never mentions Meta**, despite a full Meta WhatsApp
  Cloud API integration already built.
- `src/routes/signup.tsx` renders no `SiteFooter`/`SiteHeader` — just a
  back-link, the form, and a "Log in" link. **No Terms/Privacy link,
  checkbox, or text anywhere on the page itself.** A user can create a
  full account without the signup flow ever surfacing either document.
**Decision needed from you**: exact copy for an explicit "by creating an
account, you agree to..." line (product/legal wording), and whether to
add Meta to the processor list (legal-text decision) — neither
implemented here per the read-only constraint.
**Dependencies**: none.

### 4.4 — Supabase Auth rate limits / app-level protection 🔵
**Confirmed still open** (re-verified 2026-10-18). Login (`login.tsx:43`),
signup (`signup.tsx:43-47`), password-reset request
(`forgot-password.tsx:42-44`), and password-reset completion
(`reset-password.tsx:70`) all call Supabase's client SDK directly — zero
`createServerFn`, zero app-level throttling. A real per-IP rate-limit
pattern exists (`enforceTenantRateLimit`, `public-lead-server.ts`) but is
wired only into public lead/quote endpoints, never auth.
**Unknown (provider-side, not verifiable from this repo)**: whatever
Supabase's own dashboard Auth rate-limit settings are currently
configured to.
**Decision needed from you**: (a) check the Supabase dashboard's current
Auth rate-limit config and report back what it actually is, (b) decide
whether that's sufficient or whether app-level throttling should be
added on top (would need its own design — this repo doesn't have a
generic IP-rate-limit helper for non-tenant-scoped endpoints like auth).
**Dependencies**: (a) blocks a real answer on (b).

### 4.5 — Audit logging 🔵
**Confirmed still absent** (re-verified 2026-10-18 — checked all 24
current migrations directly, including the two new ones from this
session): no `audit_log`/`audit_trail` table exists anywhere.
**Decision needed from you**: scope (which actions need auditing —
billing changes, price-sheet edits, WhatsApp connect/disconnect, auth
events?) before any schema can be designed. Pure product/compliance
scoping question, not something I can resolve unilaterally.
**Dependencies**: none, but should probably be scoped before Meta
Advanced Access goes fully live, given WhatsApp credential handling is
one of the more sensitive areas with zero audit trail today.

### 4.6 — Session-token storage and XSS exposure ⚪ (architectural fact, not a new vulnerability)
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

### 4.7 — Other findings, resolved this session ⚪
- **Twilio webhook dedup** — was missing, now fixed as part of §2.1 (the
  blocked WhatsApp commit): `MessageSid`-based dedup added, matching
  Meta's route. Not yet live (blocked on the same migration gate, though
  this specific piece doesn't actually depend on `0024` — see §2.1's own
  note).
- **Stripe webhook dedup** — has its own separate, durable claim-lease
  mechanism (`claim_stripe_event`/`complete_stripe_event`/
  `fail_stripe_event`, §1.2/§1.6), confirmed still correct, not reviewed
  further this round.

---

## 5. Summary of decisions needed from you

1. Apply + verify migration `0024` in production (§2.1), then authorize
   pushing `da22d34`.
2. Opt-out semantics for WhatsApp (§4.1) — product decision.
3. Consent model for Meta WhatsApp connections (§4.2) — product/legal.
4. Signup Terms/Privacy copy + whether to add Meta to the Privacy Policy's
   processor list (§4.3) — product/legal.
5. Check Supabase's actual dashboard Auth rate-limit settings, then decide
   if app-level throttling is also needed (§4.4) — provider-setting lookup
   + product decision.
6. Scope what needs audit logging before any schema design starts (§4.5)
   — product/compliance.
