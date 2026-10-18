-- WhatsApp AI-to-AI / non-progressing-answer loop guard. Found via a real
-- live incident: JIR's own AI replying to an automated counterpart (e.g.
-- Meta's own Business AI feature, confirmed from this repo's own history
-- to have run on a real connected test number) with neither side able to
-- recognize the exchange wasn't progressing — bounded only by the 24-hour
-- messaging window, API cost, or manual intervention (turning the phone
-- off, deleting the chat).
--
-- REVISED DESIGN (superseding the first pass): the first version kept only
-- a single mutable counter row (`consecutive_repeat_count` compared to the
-- immediately-prior signature). An adversarial review found two structural
-- problems: (1) comparing only to the immediately-prior round never
-- catches an ALTERNATING pattern (A/B/A/B resets the counter to 1 every
-- round, since each round differs from the one right before it); (2) the
-- migration's own comment described a "time-based decay" resume path that
-- was never implemented, and on reflection that gap was accidentally
-- correct caution, not a bug — recovery must never be based on elapsed
-- time or a bare new message, only on evidence the interaction actually
-- changed, or an authorized human decision.
--
-- This version splits "evidence" from "pause state" into two tables:
--   - whatsapp_interaction_events: an APPEND-ONLY log of every inbound
--     and outbound automated interaction for a (tenant, phone), never
--     deleted, never summarized away. Detection re-derives every signal
--     fresh from this log on each call instead of trusting a running
--     counter — this is what fixes the alternating-pattern blind spot
--     (see record_whatsapp_interaction's own comment).
--   - whatsapp_loop_guards: the CURRENT pause state only (tripped/not,
--     notice delivery state, and — new — who/what last resumed it and
--     when). Resuming never deletes or rewrites the evidence log; it only
--     moves the "relevant evidence" floor forward (last_resumed_at), so a
--     resume meaningfully lets automation proceed without pretending the
--     prior loop never happened.
--
-- Same (tenant_id, phone) primary-key shape as whatsapp_human_takeovers
-- (0020), same zero-access RLS posture as every other internal/service-
-- role-only table in this schema. Deliberately NOT columns on `leads`:
-- decideLeadRoute (whatsapp-conversation-server.ts) routes a flagged
-- lead's next message to a BRAND NEW lead row, so state kept on `leads`
-- would reset the instant a new lead is created — a complete bypass.
--
-- Safe to re-run.

create table if not exists public.whatsapp_loop_guards (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  phone text not null,
  -- null = not currently paused. Set only by the atomic trip-detection
  -- inside record_whatsapp_interaction (below); cleared only by
  -- resume_whatsapp_loop_guard — never by elapsed time, never by the mere
  -- arrival of a new message.
  tripped_at timestamptz,
  -- Which signal caused the CURRENT (or most recent) trip. Informational/
  -- testable, not itself load-bearing for any gating decision.
  trip_reason text check (trip_reason in ('duplicate_content', 'repeat_pattern', 'volume')),
  -- Pause-notice delivery state machine: 'pending' (owed, not yet
  -- claimed), 'sending' (one caller has atomically claimed the right to
  -- attempt the real send — see claim_whatsapp_loop_notice), 'sent' (a
  -- real provider send has confirmed success). Never claims exactly-once
  -- delivery — see mark_whatsapp_loop_notice_sent's own comment.
  notice_status text check (notice_status in ('pending', 'sending', 'sent')),
  -- Set together, in the same statement, only by resume_whatsapp_loop_guard
  -- — never independently of each other, and never set merely because
  -- time passed. resumed_by names which of a FIXED, enumerable set of
  -- authorized actions performed the resume, so "was this resumed by a
  -- real decision" is a testable invariant, not an inference from a
  -- timestamp. Kept even while NOT currently tripped (a resumed-and-quiet
  -- guard is a distinct, auditable state from a guard that has never
  -- tripped at all — see whatsapp-loop-guard-server.ts's own comment on
  -- the three observable states).
  resumed_at timestamptz,
  resumed_by text check (resumed_by in ('dashboard_action', 'meta_human_echo', 'operator_reply')),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, phone)
);

alter table public.whatsapp_loop_guards enable row level security;
revoke all on public.whatsapp_loop_guards from anon, authenticated;

-- Append-only evidence log. Deliberately NOT raw customer message text:
-- outbound events store the same fact-signature string the old design
-- already stored in plaintext (price-sheet item ids + validated dollar
-- amounts, or a fixed code for a canned/non-priced message — never
-- sensitive on its own); inbound events store a SHA-256 hash of the
-- normalized customer text (or, for a media-only message, a hash of the
-- media reference instead) — never the customer's actual words. This is a
-- deliberate scope boundary, not an oversight: it means this table never
-- becomes a new place raw customer conversation content accumulates, so
-- the data-retention question for PII content is largely moot here. What
-- IS left open, honestly, not silently decided: this table has no
-- automatic deletion/expiry job. It will grow without bound over time.
-- Introducing a retention policy (e.g. "delete events older than N days
-- once they're no longer within any detection window") is a real,
-- separate product/legal decision this migration deliberately does NOT
-- make — adding one silently here would be exactly the kind of unrelated
-- policy change this phase was told not to introduce. Flagged for a
-- deliberate, later decision.
create table if not exists public.whatsapp_interaction_events (
  id bigserial primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  phone text not null,
  occurred_at timestamptz not null default now(),
  direction text not null check (direction in ('inbound', 'outbound')),
  -- Twilio's MessageSid or Meta's wamid for inbound messages where the
  -- channel supplies one; null for outbound (this codebase doesn't
  -- currently capture the provider's returned message id on send — a
  -- real, stated limitation, not required for the detection algorithm,
  -- which keys off content_hash, not provider ids).
  provider_message_id text,
  content_hash text not null,
  -- Nullable: an inbound message recorded before any lead exists yet (the
  -- pre-lead greeting path), or an inbound message that never resulted in
  -- a lead, has no lead to attach to.
  lead_id uuid references public.leads (id) on delete set null,
  -- Computed once, at insert time, by record_whatsapp_interaction: does a
  -- prior event (same tenant+phone+direction+content_hash, within the
  -- duplicate-content window, not yet past any resume floor) exist with a
  -- different-or-absent provider_message_id? This is the signal that
  -- catches "an AI sending new messages with different ids while
  -- repeating the same content" — see that function's own comment.
  is_duplicate_content boolean not null default false
);

create index if not exists whatsapp_interaction_events_tenant_phone_time_idx
  on public.whatsapp_interaction_events (tenant_id, phone, occurred_at);
create index if not exists whatsapp_interaction_events_tenant_phone_dir_hash_idx
  on public.whatsapp_interaction_events (tenant_id, phone, direction, content_hash, occurred_at);

alter table public.whatsapp_interaction_events enable row level security;
revoke all on public.whatsapp_interaction_events from anon, authenticated;

-- Extends leads.flag_type with 'loop_suspected' — reuses the exact
-- existing flagged-lead mechanism (0008/0013/0014), same table, same
-- columns, no new lead-level persistence. This is the DASHBOARD-VISIBLE
-- half of the guard; whatsapp_loop_guards above is the cross-lead,
-- authoritative half that actually gates automated replies. The atomic
-- UPDATE that sets this (in application code, guarded by
-- `where flag_type is null`) never overwrites an existing, unrelated flag.
alter table public.leads
  drop constraint leads_flag_type_check;

alter table public.leads
  add constraint leads_flag_type_check
  check (flag_type in ('conflicting_information', 'needs_human_review', 'outside_service_scope', 'pending_negotiated_price', 'partially_priced', 'loop_suspected'));

-- The one chokepoint every inbound and outbound automated WhatsApp
-- interaction records through — atomically inserts the evidence row AND
-- (re-)decides, from the evidence log itself rather than a running
-- counter, whether to trip. No separate read-then-compare-then-write
-- window exists for two concurrent callers (same lead, two DIFFERENT
-- leads for the same phone, or an inbound recording racing an outbound
-- send) to both observe "under threshold" and both proceed — the actual
-- state transition is a single guarded UPDATE at the bottom, same
-- discipline as the first design's evaluate_whatsapp_loop_guard.
--
-- THREE independent trip signals, computed fresh every call, any one
-- sufficient on its own:
--
--   1. duplicate_content (inbound only): p_direction = 'inbound' and this
--      exact normalized content has recurred p_duplicate_threshold times
--      within p_duplicate_window_seconds, each time with a DIFFERENT (or
--      absent) provider_message_id than the one it matched. This is
--      deliberately NOT keyed on provider_message_id matching — a
--      provider-level redelivery of the SAME message id is a separate,
--      pre-existing concern (wasMessageAlreadyProcessed) and is not what
--      this signal is for. This signal is for the specific case the
--      product requirement named: an automated counterpart that
--      re-generates a new message (new id) that happens to carry
--      identical content — strong, fast-triggering evidence of
--      non-human repetition, so its threshold/window are tighter than
--      the other two signals.
--
--   2. repeat_pattern (outbound only): among this phone's OUTBOUND events
--      within p_pattern_window_seconds, count every occurrence of a
--      content_hash AFTER its first appearance in that window. This is
--      the fix for the alternating-pattern blind spot: A, B, A, B across
--      four rounds counts as 2 repeats (A's second occurrence, B's
--      second occurrence) even though no two CONSECUTIVE rounds matched
--      each other — a plain "does this round match the one right before
--      it" check (the first design's whole mechanism) would see A≠B,
--      B≠A, forever, and never trip. Comparing against the full recent
--      set, not just the immediately-prior round, is what "considering
--      whether the AI is making meaningful progress" actually requires:
--      a genuinely NEW signature is real evidence of progress and is
--      never counted against the threshold; a RECURRING one — in any
--      position, not just back-to-back — is evidence of none.
--      Deliberately NOT proof two customer questions were identical — a
--      customer can legitimately ask several different questions that
--      happen to land on the same stated price; p_repeat_threshold exists
--      to tolerate a realistic handful of such legitimate rounds before
--      concluding nothing is progressing. This remains a real,
--      unresolved ambiguity (see whatsapp-loop-guard-server.ts's own
--      comment) — the threshold is the only mitigation, not a fix.
--
--   3. volume: total events (either direction) within
--      p_volume_window_seconds reaching p_volume_threshold — independent
--      of whether any individual signature repeats. A legitimately busy
--      conversation (lots of genuinely different questions in a short
--      burst) can still trip this; kept anyway as a safety net, per the
--      explicit instruction to keep it despite that trade-off.
--
-- last_resumed_at (read from the guard row before computing any window)
-- is a FLOOR, not a filter that discards history: every count above
-- additionally requires occurred_at > last_resumed_at. This is what makes
-- a resume actually resume automation — without it, the very next
-- message would immediately re-trip on the identical pre-resume evidence
-- still sitting in the window, since nothing in this design ever deletes
-- that evidence (see the table's own comment). The evidence rows
-- themselves are untouched and remain permanently queryable; only NEW
-- trip determinations stop counting anything at or before the last
-- resume.
--
-- All six threshold/window parameters are plain arguments, not constants
-- baked into this function, so they stay configurable from the calling
-- code (see whatsapp-loop-guard-server.ts) without a new migration.
--
-- CONCURRENCY FIX (adversarial review #2, confirmed via a forced two-
-- session reproduction): the previous version of this function reused
-- ONE variable (v_tripped_at) both for "the state I read at the top" AND
-- as the RETURNING target of the conditional trip UPDATE below. PL/pgSQL
-- resets an INTO target to NULL whenever its statement matches zero
-- rows — so a LOSING concurrent caller (one whose own UPDATE attempt
-- found the row already tripped by someone else, moments earlier) had
-- its correct, already-read non-null-or-null value overwritten by that
-- zero-row NULL, and could report `tripped: false` to its caller even
-- though the guard was, at that exact moment, genuinely tripped. This
-- function now (1) writes any trip-UPDATE's RETURNING result into its
-- OWN dedicated variable (v_trip_update_result), never reusing
-- v_tripped_at for that purpose, and (2) performs one final,
-- unconditional, authoritative re-read of the row immediately before
-- constructing the return value — regardless of which branch above ran.
-- This guarantees the returned `tripped` column always reflects the
-- row's true committed state at the latest possible moment, never a
-- value clobbered by this call's own failed write attempt.
--
-- The trip UPDATE's WHERE clause also now requires
-- `resumed_at is not distinct from v_resumed_at` — an optimistic-
-- concurrency check against the SAME resumed_at this call's window
-- floor was computed from. Without it, a human resume that commits
-- between this call's initial read and its own trip UPDATE could be
-- silently overridden by a trip decision this call computed from stale,
-- pre-resume evidence (the exact "stale window-floor causes a spurious
-- re-trip right after a completed resume" gap). With it, that UPDATE's
-- WHERE clause simply fails to match (resumed_at changed under it), this
-- call's own would-be trip is discarded, and the final authoritative
-- re-read reports whatever the guard's TRUE current state actually is.
create or replace function public.record_whatsapp_interaction(
  p_tenant_id uuid,
  p_phone text,
  p_direction text,
  p_content_hash text,
  p_provider_message_id text,
  p_lead_id uuid,
  p_duplicate_window_seconds int,
  p_duplicate_threshold int,
  p_pattern_window_seconds int,
  p_repeat_threshold int,
  p_volume_window_seconds int,
  p_volume_threshold int
)
returns table(
  tripped boolean,
  just_tripped boolean,
  trip_reason text,
  is_duplicate_content boolean,
  duplicate_content_count int,
  repeat_count int,
  recent_event_count int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tripped_at timestamptz;
  v_trip_reason_value text;
  v_resumed_at timestamptz;
  v_window_floor timestamptz;
  v_is_duplicate boolean := false;
  v_duplicate_count int := 0;
  v_repeat_count int := 0;
  v_recent_count int := 0;
  v_just_tripped boolean := false;
  v_new_trip_reason text;
  -- Dedicated RETURNING target for the trip UPDATE below — deliberately
  -- NEVER v_tripped_at itself. See this function's own header comment
  -- for why reusing v_tripped_at here was the confirmed concurrency bug.
  v_trip_update_result timestamptz;
begin
  if p_direction not in ('inbound', 'outbound') then
    raise exception 'record_whatsapp_interaction: invalid direction %', p_direction;
  end if;

  insert into whatsapp_loop_guards (tenant_id, phone)
  values (p_tenant_id, p_phone)
  on conflict (tenant_id, phone) do nothing;

  -- Table alias required: the function's own OUT parameter is also named
  -- trip_reason (returns table(..., trip_reason text, ...)), which
  -- plpgsql implicitly declares as a variable in scope for the whole
  -- function body — an unqualified "trip_reason" here is genuinely
  -- ambiguous between that variable and this column, and Postgres
  -- correctly refuses to guess.
  select g.tripped_at, g.trip_reason, g.resumed_at
  into v_tripped_at, v_trip_reason_value, v_resumed_at
  from whatsapp_loop_guards g
  where g.tenant_id = p_tenant_id and g.phone = p_phone;

  v_window_floor := coalesce(v_resumed_at, '-infinity'::timestamptz);

  select exists (
    select 1 from whatsapp_interaction_events e
    where e.tenant_id = p_tenant_id and e.phone = p_phone and e.direction = p_direction
      and e.content_hash = p_content_hash
      and e.occurred_at > now() - make_interval(secs => p_duplicate_window_seconds)
      and e.occurred_at > v_window_floor
      and (
        p_provider_message_id is null
        or e.provider_message_id is null
        or e.provider_message_id is distinct from p_provider_message_id
      )
  ) into v_is_duplicate;

  insert into whatsapp_interaction_events
    (tenant_id, phone, direction, provider_message_id, content_hash, lead_id, is_duplicate_content)
  values (p_tenant_id, p_phone, p_direction, p_provider_message_id, p_content_hash, p_lead_id, v_is_duplicate);

  select count(*) into v_duplicate_count
  from whatsapp_interaction_events e
  where e.tenant_id = p_tenant_id and e.phone = p_phone and e.direction = p_direction
    and e.is_duplicate_content
    and e.occurred_at > now() - make_interval(secs => p_duplicate_window_seconds)
    and e.occurred_at > v_window_floor;

  select count(*) into v_repeat_count
  from (
    select content_hash, row_number() over (partition by content_hash order by occurred_at) as rn
    from whatsapp_interaction_events e
    where e.tenant_id = p_tenant_id and e.phone = p_phone and e.direction = 'outbound'
      and e.occurred_at > now() - make_interval(secs => p_pattern_window_seconds)
      and e.occurred_at > v_window_floor
  ) ranked
  where rn > 1;

  select count(*) into v_recent_count
  from whatsapp_interaction_events e
  where e.tenant_id = p_tenant_id and e.phone = p_phone
    and e.occurred_at > now() - make_interval(secs => p_volume_window_seconds)
    and e.occurred_at > v_window_floor;

  if v_tripped_at is null then
    if p_direction = 'inbound' and v_duplicate_count >= p_duplicate_threshold then
      v_new_trip_reason := 'duplicate_content';
    elsif v_repeat_count >= p_repeat_threshold then
      v_new_trip_reason := 'repeat_pattern';
    elsif v_recent_count >= p_volume_threshold then
      v_new_trip_reason := 'volume';
    end if;

    if v_new_trip_reason is not null then
      -- Optimistic-concurrency guard: `resumed_at is not distinct from
      -- v_resumed_at` means this UPDATE only applies if the resume state
      -- this call's window floor was computed from hasn't changed since
      -- that read. See this function's header comment for why.
      update whatsapp_loop_guards
      set tripped_at = now(), notice_status = 'pending', trip_reason = v_new_trip_reason, updated_at = now()
      where tenant_id = p_tenant_id and phone = p_phone and tripped_at is null
        and resumed_at is not distinct from v_resumed_at
      returning tripped_at into v_trip_update_result;
      if v_trip_update_result is not null then
        v_just_tripped := true;
      end if;
    end if;
  end if;

  -- Authoritative re-read, always performed last regardless of which
  -- branch above ran or how it resolved. See this function's header
  -- comment: this is what guarantees the returned `tripped` value can
  -- never be a value clobbered by this call's own zero-row UPDATE
  -- attempt — it always reflects the row's true committed state at the
  -- latest possible moment. just_tripped still reflects only whether
  -- THIS call was the one that performed the trip, not the final state.
  select g.tripped_at, g.trip_reason
  into v_tripped_at, v_trip_reason_value
  from whatsapp_loop_guards g
  where g.tenant_id = p_tenant_id and g.phone = p_phone;

  return query select
    (v_tripped_at is not null),
    v_just_tripped,
    v_trip_reason_value,
    v_is_duplicate,
    v_duplicate_count,
    v_repeat_count,
    v_recent_count;
end;
$$;

revoke all on function public.record_whatsapp_interaction(uuid, text, text, text, text, uuid, int, int, int, int, int, int) from public, anon, authenticated;
grant execute on function public.record_whatsapp_interaction(uuid, text, text, text, text, uuid, int, int, int, int, int, int) to service_role;

-- Atomically CLAIMS the right to attempt the real pause-notice send — the
-- fix for a concurrent-notice-claim race the first design left open (two
-- near-simultaneous inbound messages for the same just-tripped phone could
-- both read notice_status = 'pending' and both attempt a real send before
-- either confirmed). Only the caller whose UPDATE actually matches a row
-- may proceed to call the provider; every other concurrent caller sees
-- zero rows affected and must NOT send.
--
-- Claims a 'pending' notice, OR a 'sending' notice whose claim has gone
-- stale (p_stale_seconds) — this is a liveness/retry mechanism for
-- MESSAGE DELIVERY only (recovering from a crash between claim and
-- confirmation), not a resume/recovery mechanism for the loop guard
-- itself; it never touches tripped_at and is unrelated to the "no
-- time-based auto-clear" rule that governs the guard's trip state.
create or replace function public.claim_whatsapp_loop_notice(p_tenant_id uuid, p_phone text, p_stale_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean := false;
begin
  update whatsapp_loop_guards
  set notice_status = 'sending', updated_at = now()
  where tenant_id = p_tenant_id and phone = p_phone
    and (
      notice_status = 'pending'
      or (notice_status = 'sending' and updated_at < now() - make_interval(secs => p_stale_seconds))
    )
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.claim_whatsapp_loop_notice(uuid, text, int) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_loop_notice(uuid, text, int) to service_role;

-- Releases a claim back to 'pending' after a send attempt FAILS (provider
-- error, thrown exception) — so the very next inbound message can retry
-- immediately rather than waiting out claim_whatsapp_loop_notice's
-- staleness window. Guarded by `where notice_status = 'sending'` so this
-- can never affect an already-'sent' or already-reclaimed row.
create or replace function public.release_whatsapp_loop_notice_claim(p_tenant_id uuid, p_phone text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released boolean := false;
begin
  update whatsapp_loop_guards
  set notice_status = 'pending', updated_at = now()
  where tenant_id = p_tenant_id and phone = p_phone and notice_status = 'sending'
  returning true into v_released;
  return coalesce(v_released, false);
end;
$$;

revoke all on function public.release_whatsapp_loop_notice_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.release_whatsapp_loop_notice_claim(uuid, text) to service_role;

-- Marks the pause notice as confirmed-sent — ONLY ever called after a real
-- provider send call has returned success, never optimistically before.
-- Transitions from 'sending' (the claim state), not 'pending' directly —
-- a caller must hold the claim from claim_whatsapp_loop_notice before it's
-- ever allowed to reach this. Guarantee is explicitly AT-LEAST-ONCE, never
-- exactly-once: if a provider call times out and the response is lost —
-- the message may or may not have actually been delivered — this
-- function is never called optimistically, so the claim is released (or
-- goes stale) and the notice is retried on a later message, which can
-- produce a genuine duplicate delivery to the customer if the first
-- attempt actually DID succeed despite the timeout. This remaining
-- uncertainty is accepted, not hidden: there is no way to know, from this
-- side, whether a timed-out send actually reached the customer, and this
-- codebase has no provider delivery-receipt reconciliation to close that
-- gap. If no further inbound message ever arrives after such a failure,
-- the notice is never retried at all — also a real, accepted limitation
-- (no background job queue exists here to retry on a timer instead).
create or replace function public.mark_whatsapp_loop_notice_sent(p_tenant_id uuid, p_phone text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated boolean := false;
begin
  update whatsapp_loop_guards
  set notice_status = 'sent', updated_at = now()
  where tenant_id = p_tenant_id and phone = p_phone and notice_status = 'sending'
  returning true into v_updated;
  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.mark_whatsapp_loop_notice_sent(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_whatsapp_loop_notice_sent(uuid, text) to service_role;

-- Explicit, safe recovery — the ONLY way tripped_at is ever cleared.
-- p_resumed_by must be one of a fixed, enumerable set of authorized
-- actions (enforced by whatsapp_loop_guards' own check constraint, not
-- just convention): 'dashboard_action' (an owner's explicit "resume
-- automation" control), 'meta_human_echo' (a genuine Meta
-- smb_message_echoes event — the owner is personally handling this
-- conversation via their own WhatsApp Business App), or 'operator_reply'
-- (a dashboard operator's own reply to this lead, recorded ONLY after
-- that reply's real provider send has confirmed success — never before,
-- same at-least-once-first discipline as every other "only after a real
-- send" rule in this design).
--
-- Deliberately NEVER called for "a new inbound message arrived" or "N
-- hours have passed" — those are exactly the recovery models this design
-- replaces. tripped_at, notice_status, and trip_reason are cleared
-- together; resumed_at/resumed_by are set together in the same statement
-- — there is no intermediate state where tripped_at is null but
-- resumed_by is not yet recorded, or vice versa. This UPDATE does NOT
-- touch whatsapp_interaction_events — no evidence is deleted or
-- rewritten; see record_whatsapp_interaction's own comment for how
-- resumed_at instead becomes the floor for future trip determinations.
create or replace function public.resume_whatsapp_loop_guard(p_tenant_id uuid, p_phone text, p_resumed_by text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated boolean := false;
begin
  if p_resumed_by not in ('dashboard_action', 'meta_human_echo', 'operator_reply') then
    raise exception 'resume_whatsapp_loop_guard: invalid resumed_by %', p_resumed_by;
  end if;

  update whatsapp_loop_guards
  set tripped_at = null, notice_status = null, trip_reason = null,
      resumed_at = now(), resumed_by = p_resumed_by, updated_at = now()
  where tenant_id = p_tenant_id and phone = p_phone
  returning true into v_updated;
  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.resume_whatsapp_loop_guard(uuid, text, text) from public, anon, authenticated;
grant execute on function public.resume_whatsapp_loop_guard(uuid, text, text) to service_role;
