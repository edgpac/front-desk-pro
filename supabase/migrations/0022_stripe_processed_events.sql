-- FOURTH PASS (same migration number — never applied yet). Third pass
-- added the processing/completed/failed lease lifecycle but left
-- complete_stripe_event/fail_stripe_event with no ownership check at all
-- — either one would update a row by event_id alone, unconditionally.
-- Found during review: if event X's lease expires while worker A is still
-- (slowly) running, a new delivery can reclaim it (worker B/C,
-- attempt_count+1) exactly as designed — but A, unaware it's been
-- superseded, could still later call complete_stripe_event or
-- fail_stripe_event and have it succeed, incorrectly stamping the event's
-- final status based on A's stale attempt instead of whichever attempt is
-- actually current. In the worst case this could mark a genuinely-failed
-- event 'completed' (A's unconditional "success" call landing after B's
-- correct "failed" call), permanently losing the real failure signal.
--
-- Fixed the same way the per-user claim's release already is: a
-- lease_token, generated fresh by the caller on each claim attempt
-- (crypto.randomUUID() in TypeScript) and required to still match before
-- complete/fail can take effect. A stale worker's completion/failure call
-- using its own superseded token now affects zero rows — a safe no-op,
-- not a status corruption.
--
-- Safe to re-run.

create table if not exists public.stripe_processed_events (
  event_id text primary key,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  lease_token uuid not null,
  leased_at timestamptz not null default now(),
  completed_at timestamptz,
  attempt_count int not null default 1
);

-- Same zero-access RLS posture as every other internal/service-role-only
-- table in this schema.
alter table public.stripe_processed_events enable row level security;
revoke all on public.stripe_processed_events from anon, authenticated;

-- Single atomic statement decides, and simultaneously records, what this
-- delivery should do — no separate read-then-write window for two
-- concurrent deliveries of the SAME event id to disagree about who's
-- responsible for it. p_lease_token is this caller's own freshly-
-- generated token, stored on the row for as long as this caller is the
-- legitimate processor — required later by complete_stripe_event/
-- fail_stripe_event.
--
--   'claimed'             — proceed with the real work (brand new event,
--                            OR a reclaimed abandoned/failed one). The
--                            caller's lease_token is now the one of record.
--   'duplicate_completed' — already fully done; return 200, don't redo it.
--   'duplicate_processing'— someone else is actively working on it, within
--                            its lease; don't run the work; return a
--                            retryable response.
create or replace function public.claim_stripe_event(p_event_id text, p_lease_token uuid, p_lease_seconds int default 60)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result text;
begin
  insert into stripe_processed_events (event_id, status, lease_token, leased_at, attempt_count)
  values (p_event_id, 'processing', p_lease_token, now(), 1)
  on conflict (event_id) do update
    set status = 'processing',
        lease_token = p_lease_token,
        leased_at = now(),
        attempt_count = stripe_processed_events.attempt_count + 1
    where
      stripe_processed_events.status = 'failed'
      or (
        stripe_processed_events.status = 'processing'
        and stripe_processed_events.leased_at < now() - (p_lease_seconds || ' seconds')::interval
      )
  returning 'claimed' into v_result;

  if v_result is not null then
    return v_result;
  end if;

  -- Did not win the insert or the conflict-update above — read back the
  -- row to tell the caller which of the two non-claimable states this is.
  select case when status = 'completed' then 'duplicate_completed' else 'duplicate_processing' end
  into v_result
  from stripe_processed_events
  where event_id = p_event_id;

  return v_result;
end;
$$;

revoke all on function public.claim_stripe_event(text, uuid, int) from public, anon, authenticated;
grant execute on function public.claim_stripe_event(text, uuid, int) to service_role;

-- Only transitions the row if p_lease_token still matches the one on
-- record — a worker that's been superseded by a newer claim attempt
-- (its lease expired and someone else reclaimed the event) gets 0 rows
-- updated, returns false, and must not be treated as having successfully
-- finalized the event. Returns true only when THIS call is the one that
-- actually made the transition.
create or replace function public.complete_stripe_event(p_event_id text, p_lease_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated boolean := false;
begin
  update stripe_processed_events
  set status = 'completed', completed_at = now()
  where event_id = p_event_id and lease_token = p_lease_token
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.complete_stripe_event(text, uuid) from public, anon, authenticated;
grant execute on function public.complete_stripe_event(text, uuid) to service_role;

-- Marks a genuine processing failure (e.g. a transient Stripe API error) —
-- deliberately distinct from leaving the row in 'processing': this makes
-- the event immediately reclaimable by the next delivery rather than
-- making it wait out the full lease window. Same token-ownership guard as
-- complete_stripe_event — a superseded worker's failure call is also a
-- safe no-op, never overwriting a newer attempt's actual outcome.
create or replace function public.fail_stripe_event(p_event_id text, p_lease_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated boolean := false;
begin
  update stripe_processed_events
  set status = 'failed'
  where event_id = p_event_id and lease_token = p_lease_token
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.fail_stripe_event(text, uuid) from public, anon, authenticated;
grant execute on function public.fail_stripe_event(text, uuid) to service_role;
