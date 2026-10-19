-- WhatsApp opt-out (STOP/UNSUBSCRIBE/CANCEL/etc., English and Spanish).
-- Same (tenant_id, phone) key shape and zero-access RLS posture as
-- whatsapp_loop_guards (0024) and whatsapp_human_takeovers (0020) — this
-- is a DIFFERENT concern from the loop guard (that one detects a
-- non-progressing AI-to-AI exchange; this one is an explicit customer
-- request to stop receiving messages), kept in its own table rather than
-- folded into whatsapp_loop_guards so the two states can never be
-- conflated or accidentally cleared by the wrong resume path.
--
-- opted_out_at / resumed_at together express "currently opted out" as
-- opted_out_at is not null and (resumed_at is null or resumed_at <
-- opted_out_at) — the same floor/compare pattern 0024 already uses, so a
-- customer can opt out, be resumed, and opt out again later, with every
-- transition preserved rather than overwritten (auditable history, not
-- just a current boolean).
--
-- confirmation_status is the exact same claim/send/confirm state machine
-- 0024 already proved for its pause notice (pending -> sending -> sent),
-- reused here to solve the identical problem: two STOP messages arriving
-- in quick succession (or a provider redelivery) must never produce two
-- confirmation sends. record_whatsapp_opt_out (below) only resets this to
-- 'pending' on a genuinely FRESH opt-out transition — a repeat STOP while
-- already opted out leaves it untouched, so no second confirmation is
-- ever owed or attempted.
--
-- Safe to re-run.

create table if not exists public.whatsapp_opt_outs (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  phone text not null,
  opted_out_at timestamptz not null default now(),
  confirmation_status text not null default 'pending' check (confirmation_status in ('pending', 'sending', 'sent')),
  -- Set together, in the same statement, only by resume_whatsapp_opt_out
  -- below — never independently, never merely because a new message
  -- arrived. resumed_by names which of a FIXED, enumerable set of
  -- authorized actions performed the resume, matching 0024's own
  -- resumed_by discipline.
  resumed_at timestamptz,
  resumed_by text check (resumed_by in ('dashboard_action', 'opt_in_keyword')),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, phone)
);

alter table public.whatsapp_opt_outs enable row level security;
revoke all on public.whatsapp_opt_outs from anon, authenticated;

-- Atomically records an opt-out. Returns whether this call is the one that
-- caused a FRESH transition into the opted-out state (just_opted_out) —
-- this is what the caller uses to decide whether a confirmation is newly
-- owed, so a repeat STOP from an already-opted-out customer never queues
-- a second one.
--
-- Two separate statements, each guarded so only one can ever "win" a given
-- transition, rather than a single read-then-branch (which a prior review
-- found was racy: it could not reliably tell "this call just created the
-- row" apart from "the row already existed," so two concurrent first-ever
-- STOP messages could both compute just_opted_out = true and both queue a
-- confirmation):
--   1. INSERT ... ON CONFLICT DO NOTHING — succeeds (RETURNING a row) only
--      for whichever concurrent caller is first to create a brand-new row
--      for this (tenant, phone); every other concurrent caller gets a
--      conflict and RETURNING produces nothing.
--   2. Only runs if (1) didn't insert: an UPDATE whose WHERE clause only
--      matches a row that is NOT currently opted out (previously
--      resumed) — a genuine re-opt-out cycle. Postgres re-evaluates this
--      WHERE clause against the row's state at the moment each
--      concurrent UPDATE actually acquires its row lock, not a stale
--      snapshot read earlier, so only the first of several concurrent
--      callers to reach this point can ever match it — the next one
--      immediately sees resumed_at already cleared and matches nothing.
-- just_opted_out is true if, and only if, exactly one of these two
-- statements actually affected a row.
create or replace function public.record_whatsapp_opt_out(
  p_tenant_id uuid,
  p_phone text
)
returns table(just_opted_out boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted boolean := false;
  v_updated boolean := false;
begin
  insert into whatsapp_opt_outs (tenant_id, phone, opted_out_at, confirmation_status)
  values (p_tenant_id, p_phone, now(), 'pending')
  on conflict (tenant_id, phone) do nothing
  returning true into v_inserted;

  if not coalesce(v_inserted, false) then
    update whatsapp_opt_outs
    set opted_out_at = now(), confirmation_status = 'pending',
        resumed_at = null, resumed_by = null, updated_at = now()
    where tenant_id = p_tenant_id and phone = p_phone
      and resumed_at is not null and resumed_at >= opted_out_at
    returning true into v_updated;
  end if;

  return query select coalesce(v_inserted, false) or coalesce(v_updated, false);
end;
$$;

revoke all on function public.record_whatsapp_opt_out(uuid, text) from public, anon, authenticated;
grant execute on function public.record_whatsapp_opt_out(uuid, text) to service_role;

-- Same claim pattern as 0024's claim_whatsapp_loop_notice — only the
-- caller whose UPDATE actually matches a row may attempt the real
-- confirmation send; every other concurrent caller must not send.
create or replace function public.claim_whatsapp_opt_out_confirmation(p_tenant_id uuid, p_phone text, p_stale_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean := false;
begin
  update whatsapp_opt_outs
  set confirmation_status = 'sending', updated_at = now()
  where tenant_id = p_tenant_id and phone = p_phone
    and (
      confirmation_status = 'pending'
      or (confirmation_status = 'sending' and updated_at < now() - make_interval(secs => p_stale_seconds))
    )
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.claim_whatsapp_opt_out_confirmation(uuid, text, int) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_opt_out_confirmation(uuid, text, int) to service_role;

-- Releases a claim back to 'pending' after the real send attempt FAILS —
-- same reasoning as 0024's release_whatsapp_loop_notice_claim.
create or replace function public.release_whatsapp_opt_out_confirmation(p_tenant_id uuid, p_phone text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released boolean := false;
begin
  update whatsapp_opt_outs
  set confirmation_status = 'pending', updated_at = now()
  where tenant_id = p_tenant_id and phone = p_phone and confirmation_status = 'sending'
  returning true into v_released;
  return coalesce(v_released, false);
end;
$$;

revoke all on function public.release_whatsapp_opt_out_confirmation(uuid, text) from public, anon, authenticated;
grant execute on function public.release_whatsapp_opt_out_confirmation(uuid, text) to service_role;

-- Only ever called after a real provider send has returned success — same
-- at-least-once (never exactly-once) guarantee as 0024's
-- mark_whatsapp_loop_notice_sent, same honest reasoning for why.
create or replace function public.mark_whatsapp_opt_out_confirmation_sent(p_tenant_id uuid, p_phone text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated boolean := false;
begin
  update whatsapp_opt_outs
  set confirmation_status = 'sent', updated_at = now()
  where tenant_id = p_tenant_id and phone = p_phone and confirmation_status = 'sending'
  returning true into v_updated;
  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.mark_whatsapp_opt_out_confirmation_sent(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_whatsapp_opt_out_confirmation_sent(uuid, text) to service_role;

-- Explicit, safe recovery — the ONLY way a currently-opted-out phone
-- stops being opted out. p_resumed_by must be one of a fixed, enumerable
-- set (enforced by the table's own check constraint): 'opt_in_keyword'
-- (the customer texted an opt-in keyword like START) or
-- 'dashboard_action' (an owner's explicit dashboard control). Never
-- "a new message arrived" — an ordinary inbound message from an
-- opted-out number must never resume them on its own. No-op (returns
-- false) if the phone isn't currently opted out.
create or replace function public.resume_whatsapp_opt_out(p_tenant_id uuid, p_phone text, p_resumed_by text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated boolean := false;
begin
  if p_resumed_by not in ('dashboard_action', 'opt_in_keyword') then
    raise exception 'resume_whatsapp_opt_out: invalid resumed_by %', p_resumed_by;
  end if;

  update whatsapp_opt_outs
  set resumed_at = now(), resumed_by = p_resumed_by, updated_at = now()
  where tenant_id = p_tenant_id and phone = p_phone
    and (resumed_at is null or resumed_at < opted_out_at)
  returning true into v_updated;
  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.resume_whatsapp_opt_out(uuid, text, text) from public, anon, authenticated;
grant execute on function public.resume_whatsapp_opt_out(uuid, text, text) to service_role;
