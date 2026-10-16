-- Closes a read-modify-write race in api.stripe.webhook.tsx's
-- writeSubscriptionState, found during review of the 2026-10 subscription-
-- metadata security fix: that function reads a user's current
-- app_metadata, decides what to write, then writes the merged result back
-- — three separate steps, not one atomic operation.
--
-- If Stripe delivers two different events for the SAME user at close to
-- the same time (both invocations running concurrently, not sequentially —
-- realistic under retries or during a multi-step subscription update that
-- emits several events in quick succession), both could read the same
-- state and then write in whichever order the two requests happen to
-- finish, letting one event's write silently overwrite the other's.
--
-- REVISED (second pass, same migration number since the first version was
-- shown for review but never applied): the original version had no
-- ownership semantics on the claim — release() deleted the row
-- unconditionally, so a slow-but-not-crashed holder whose claim got stolen
-- for being stale would, on its own eventual release, delete the NEW
-- holder's legitimate claim out from under it, reopening the exact race
-- this table exists to close. Fixed by adding claim_token: each claimant
-- generates its own random token when claiming, and release only succeeds
-- if that same token is still the one on the row — a classic lease/fencing
-- token. A stolen claim's original (now-stale-tokened) holder can never
-- delete the new holder's claim.
--
-- Same shape as 0019_lead_write_atomicity.sql's whatsapp_lead_claims,
-- plus the ownership token. Scoped to this one Stripe-webhook use only —
-- not a generic "lock any user" primitive reused elsewhere. Safe to re-run.

create table if not exists public.stripe_webhook_claims (
  user_id uuid not null primary key,
  claim_token uuid not null,
  claimed_at timestamptz not null default now()
);

-- Zero-access RLS — same posture as every other internal/service-role-only
-- table in this schema (whatsapp_connections, whatsapp_lead_claims, etc.).
-- Nothing here is ever read or written directly by an anon/authenticated
-- client.
alter table public.stripe_webhook_claims enable row level security;
revoke all on public.stripe_webhook_claims from anon, authenticated;

-- Insert-or-steal-if-stale, atomic within a single statement via
-- Postgres's own row-level locking on the (user_id) unique key — two
-- concurrent callers for the same user_id can never both see v_claimed =
-- true from this function. SECURITY DEFINER so it can be granted to
-- service_role without granting broader table access; search_path pinned
-- per standard Postgres function hardening practice.
--
-- p_claim_token is the caller's own freshly-generated random token
-- (crypto.randomUUID() in the TypeScript caller) — it is NOT a secret, just
-- an opaque fencing value this one call instance owns for as long as it
-- holds the claim.
create or replace function public.claim_stripe_webhook_slot(
  p_user_id uuid,
  p_claim_token uuid,
  p_stale_seconds int default 30
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean := false;
begin
  insert into stripe_webhook_claims (user_id, claim_token, claimed_at)
  values (p_user_id, p_claim_token, now())
  on conflict (user_id) do update
    set claim_token = p_claim_token,
        claimed_at = now()
    where stripe_webhook_claims.claimed_at < now() - (p_stale_seconds || ' seconds')::interval
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.claim_stripe_webhook_slot(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.claim_stripe_webhook_slot(uuid, uuid, int) to service_role;

-- Only deletes the row if the caller's token is still the one recorded —
-- a stolen (stale, then re-claimed by someone else) slot's original holder
-- calling this later with its own stale token deletes 0 rows, never the
-- new holder's claim.
create or replace function public.release_stripe_webhook_slot(p_user_id uuid, p_claim_token uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from stripe_webhook_claims
  where user_id = p_user_id and claim_token = p_claim_token;
end;
$$;

revoke all on function public.release_stripe_webhook_slot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_stripe_webhook_slot(uuid, uuid) to service_role;

-- THIRD PASS had added renew_stripe_webhook_claim here: a fencing check
-- called immediately before the app_metadata write, re-verifying (and
-- renewing) ownership as the last gate. Review found this insufficient on
-- its own — a successful renewal is a fact about the instant the RPC
-- returned, not a guarantee that holds through the GoTrue Admin API calls
-- that followed it, which could themselves be slow enough for the claim
-- to go stale and be stolen before the write actually completed. Removed
-- (not kept alongside the real fix) rather than left as dead, misleading
-- code: superseded by 0023_subscription_state.sql's
-- write_authoritative_subscription_state, which performs the ownership
-- check and the authoritative write in the SAME function call, under a
-- row lock on this table (SELECT ... FOR UPDATE) held for the call's
-- whole duration — the check and the write can no longer be split by a
-- concurrent steal, because they're not two separate operations anymore.
-- See that migration for the full design and reasoning.
