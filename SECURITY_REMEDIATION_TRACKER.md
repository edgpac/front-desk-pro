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
- **Files changed/added** (12 total, all currently uncommitted):
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

### 3.3 — Supabase Auth rate limits / app-level protection 🔵
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

### 3.4 — Audit logging 🔵 scope approved, not yet built
**Confirmed still absent** (re-verified 2026-10-18 — checked all 25
current migrations directly, including this session's new ones): no
`audit_log`/`audit_trail` table exists anywhere.
**Scope approved (2026-10-18)**: subscription/billing state changes,
WhatsApp connect/disconnect (Meta credential handling), and lead
deletion — the last one specifically because `deleteLead`/`deleteLeads`
(the bulk-delete feature added this session) currently leave zero trace,
a hard delete with cascade and no record of who deleted what or when.
**Not yet implemented** — this is a separate build from the opt-out work
in §1.10, not started yet. Next step when you're ready: a migration
proposal (table shape, same discipline as every prior migration this
session — shown for review before being written to disk) covering those
three action categories.
**Dependencies**: none, but worth doing before Meta Advanced Access goes
fully live, given WhatsApp credential handling is one of the more
sensitive areas with zero audit trail today.

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
3. When ready, say so and I'll propose the audit-logging migration
   (§3.4) — scope already approved (subscription changes, WhatsApp
   connect/disconnect, lead deletion).
4. Optional: run the WhatsApp live-traffic smoke test noted in §1.7.

(Privacy Policy Meta disclosure — resolved, §1.9. Signup Terms/Privacy
links — resolved, §1.8. Meta/customer consent — resolved, §3.2, no new
table needed.)
