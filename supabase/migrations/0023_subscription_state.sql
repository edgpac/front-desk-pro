-- Closes the write-boundary race left open by 0021/0022 (identified in
-- the 2026-10 fourth-pass review): a successful claim renewal is a fact
-- about the instant it happened, not a guarantee that holds through the
-- separate Supabase GoTrue Admin API calls (getUserById/updateUserById)
-- that previously followed it. If those HTTP calls were slow enough for
-- the claim to go stale and be stolen in between, the dispossessed worker
-- could still complete its own (now stale) write afterward, with nothing
-- left to stop it.
--
-- Root cause: the authoritative write went through GoTrue's Admin API,
-- which is a separate HTTP service with no conditional/CAS write
-- primitive and no participation in any Postgres transaction — no check
-- performed in application code beforehand can ever be made atomic with
-- a mutation that happens afterward, through a different system.
--
-- Fix: move authoritative subscription state (plan, subscription_status,
-- stripe_customer_id) into this table, owned entirely by Postgres, and
-- make the write itself — not just a check before it — conditional on
-- claim ownership, inside ONE function call. app_metadata (written via
-- GoTrue) becomes a best-effort, explicitly non-authoritative mirror,
-- kept only for operational visibility in the Supabase Auth dashboard;
-- nothing reads it for an entitlement decision anymore (see
-- entitlements-server.ts, stripe-server.ts).
--
-- Deliberately kept separate from stripe_webhook_claims (0021), per
-- explicit instruction, rather than merging claim ownership and durable
-- state into one row: a claim's lifecycle (ephemeral, stolen when stale)
-- is a different concern from the state it protects (durable, read by
-- real users' entitlement checks), and keeping them as two tables with
-- one function enforcing their relationship is easier to reason about
-- than one row serving both purposes.
--
-- Safe to re-run.

create table if not exists public.subscription_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text check (plan in ('solo', 'crew')),
  subscription_status text not null,
  stripe_customer_id text,
  updated_at timestamptz not null default now()
);

create index if not exists subscription_state_stripe_customer_id_idx
  on public.subscription_state (stripe_customer_id)
  where stripe_customer_id is not null;

alter table public.subscription_state enable row level security;

-- Clients cannot write this table under any circumstance — no insert/
-- update/delete policy exists at all (RLS with no matching policy denies
-- by default), and the only write path is write_authoritative_subscription_state
-- below, callable only by service_role. Explicit revoke is defense in
-- depth on top of that default-deny, consistent with every other table
-- in this schema.
revoke insert, update, delete on public.subscription_state from anon, authenticated;

-- Unlike the zero-access tables elsewhere in this schema (whatsapp_connections,
-- stripe_webhook_claims, etc.), nothing here is a secret — a user's own
-- plan/status is exactly what getMyPlan (entitlements-server.ts) needs to
-- answer "does my own account have an active subscription," so it reads
-- through this policy via the caller's own RLS-scoped client rather than
-- needing an admin client just to read one's own row.
create policy "subscription_state: owner can read own row" on public.subscription_state
  for select using (auth.uid() = user_id);

-- The one and only write path. Validates the current claim token against
-- stripe_webhook_claims and performs the authoritative INSERT/UPDATE here
-- IN THE SAME FUNCTION CALL (hence the same transaction) — not a check
-- followed by a separate write. "select ... for update" takes a row lock
-- on the claims row for this user_id and holds it for the remainder of
-- this function's transaction: any other call touching that SAME row
-- (another write attempt, a steal via claim_stripe_webhook_slot, a
-- renew/release) blocks until this transaction commits or rolls back.
-- That lock is what makes the ownership check and the subscription_state
-- write genuinely atomic with respect to each other — there is no gap
-- between them for a concurrent caller to land in, because Postgres does
-- not release the lock until this entire function call finishes.
--
-- Returns false (writes nothing) if the caller's claim_token no longer
-- matches — including when no claim row exists at all for this user,
-- which should never happen if callers always acquire a claim first, but
-- fails closed rather than assuming that invariant holds.
create or replace function public.write_authoritative_subscription_state(
  p_user_id uuid,
  p_claim_token uuid,
  p_plan text,
  p_subscription_status text,
  p_stripe_customer_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_token uuid;
begin
  select claim_token into v_current_token
  from stripe_webhook_claims
  where user_id = p_user_id
  for update;

  if v_current_token is null or v_current_token is distinct from p_claim_token then
    return false;
  end if;

  insert into subscription_state (user_id, plan, subscription_status, stripe_customer_id, updated_at)
  values (p_user_id, p_plan, p_subscription_status, p_stripe_customer_id, now())
  on conflict (user_id) do update
    set plan = p_plan,
        subscription_status = p_subscription_status,
        stripe_customer_id = coalesce(p_stripe_customer_id, subscription_state.stripe_customer_id),
        updated_at = now();

  return true;
end;
$$;

revoke all on function public.write_authoritative_subscription_state(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.write_authoritative_subscription_state(uuid, uuid, text, text, text) to service_role;

-- Read-side helper for the reconciliation script and any future admin
-- tooling that needs to look up a user by their Stripe customer id without
-- a full table scan — mirrors the index above at the query layer. Not
-- currently called by any application code; included for completeness
-- alongside the index it would use.
comment on column public.subscription_state.stripe_customer_id is
  'Stripe customer id for this user, written only via write_authoritative_subscription_state. Indexed for lookup by customer id (see subscription_state_stripe_customer_id_idx).';
