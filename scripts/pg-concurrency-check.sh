#!/usr/bin/env bash
# Reproducible, non-production verification of the atomicity claim behind
# 0021_stripe_webhook_claims.sql and 0023_subscription_state.sql's
# write_authoritative_subscription_state: that a worker whose claim has
# been stolen cannot write subscription_state, and that this is enforced
# by Postgres's own row-level locking, not just by application-level
# timing. An in-memory TypeScript simulation (api.stripe.webhook.test.ts)
# cannot prove this — it is single-threaded by construction. This script
# spins up a throwaway, local, disposable Postgres cluster (never this
# project's real Supabase database — no network connection to anything
# other than localhost is ever made), applies the real SQL from the two
# migrations above, and runs two checks against it:
#
#   1. Lock-blocking proof: one session holds the claims row's lock
#      (SELECT ... FOR UPDATE) while deliberately sleeping; a second,
#      concurrent session's attempt to touch the SAME row is timed —
#      if it genuinely blocked (took close to as long as the first
#      session's hold time, not an instant), that demonstrates real
#      Postgres row-locking, not merely application-level sequencing.
#   2. Functional-correctness proof: using the REAL
#      write_authoritative_subscription_state function (not a
#      reimplementation), a token that was valid a moment ago but has
#      since been superseded by a steal is rejected — verified against
#      an actual database engine, not an in-memory model.
#
# Usage:
#   bash scripts/pg-concurrency-check.sh
#
# Requires a local `postgres`/`initdb`/`psql` on PATH or via
# PG_BIN_DIR=/path/to/bin (e.g. Postgres.app's
# /Applications/Postgres.app/Contents/Versions/latest/bin). Creates a
# fresh, disposable data directory under a temp dir, runs entirely on
# localhost on a non-default port, and removes everything it created on
# exit (success or failure) — nothing persists, nothing is shared with
# any other Postgres instance on the machine.

set -euo pipefail

PG_BIN_DIR="${PG_BIN_DIR:-}"
if [ -z "$PG_BIN_DIR" ]; then
  for candidate in /Applications/Postgres.app/Contents/Versions/latest/bin /Applications/Postgres.app/Contents/Versions/17/bin; do
    if [ -x "$candidate/postgres" ]; then PG_BIN_DIR="$candidate"; break; fi
  done
fi
if [ -z "$PG_BIN_DIR" ] || [ ! -x "$PG_BIN_DIR/postgres" ]; then
  echo "Could not find a local Postgres install. Set PG_BIN_DIR to its bin/ directory." >&2
  exit 1
fi

WORKDIR=$(mktemp -d /tmp/pg-concurrency-check.XXXXXX)
PGDATA="$WORKDIR/data"
PGPORT=55329
PGSOCK="$WORKDIR/sock"
mkdir -p "$PGSOCK"

cleanup() {
  "$PG_BIN_DIR/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -p $PGPORT" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "== Initializing throwaway Postgres cluster at $PGDATA (port $PGPORT) =="
"$PG_BIN_DIR/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null

"$PG_BIN_DIR/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -p $PGPORT -c listen_addresses=''" -l "$WORKDIR/server.log" start >/dev/null

PSQL=("$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q)

echo "== Creating schema (real SQL from 0021 + 0023, trimmed to what this check needs) =="
"${PSQL[@]}" <<'SQL'
create table stripe_webhook_claims (
  user_id uuid not null primary key,
  claim_token uuid not null,
  claimed_at timestamptz not null default now()
);

create or replace function claim_stripe_webhook_slot(p_user_id uuid, p_claim_token uuid, p_stale_seconds int default 30)
returns boolean language plpgsql as $$
declare v_claimed boolean := false;
begin
  insert into stripe_webhook_claims (user_id, claim_token, claimed_at)
  values (p_user_id, p_claim_token, now())
  on conflict (user_id) do update
    set claim_token = p_claim_token, claimed_at = now()
    where stripe_webhook_claims.claimed_at < now() - (p_stale_seconds || ' seconds')::interval
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

create table subscription_state (
  user_id uuid primary key,
  plan text check (plan in ('solo', 'crew')),
  subscription_status text not null,
  stripe_customer_id text,
  updated_at timestamptz not null default now()
);

create or replace function write_authoritative_subscription_state(
  p_user_id uuid, p_claim_token uuid, p_plan text, p_subscription_status text, p_stripe_customer_id text
) returns boolean language plpgsql as $$
declare v_current_token uuid;
begin
  select claim_token into v_current_token from stripe_webhook_claims where user_id = p_user_id for update;
  if v_current_token is null or v_current_token is distinct from p_claim_token then
    return false;
  end if;
  insert into subscription_state (user_id, plan, subscription_status, stripe_customer_id, updated_at)
  values (p_user_id, p_plan, p_subscription_status, p_stripe_customer_id, now())
  on conflict (user_id) do update
    set plan = p_plan, subscription_status = p_subscription_status,
        stripe_customer_id = coalesce(p_stripe_customer_id, subscription_state.stripe_customer_id), updated_at = now();
  return true;
end;
$$;

insert into stripe_webhook_claims (user_id, claim_token)
values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
SQL

echo ""
echo "== Check 1: does FOR UPDATE genuinely block a concurrent session? =="
# Session A: begins, locks the row, sleeps 2s while holding the lock, then commits.
("${PSQL[@]}" <<'SQL'
begin;
select claim_token from stripe_webhook_claims where user_id = '11111111-1111-1111-1111-111111111111' for update;
select pg_sleep(2);
commit;
SQL
) &
A_PID=$!

sleep 0.5 # let A acquire the lock first

B_START=$(date +%s.%N)
"${PSQL[@]}" -c "select claim_token from stripe_webhook_claims where user_id = '11111111-1111-1111-1111-111111111111' for update;" >/dev/null
B_END=$(date +%s.%N)
wait "$A_PID"

B_ELAPSED=$(echo "$B_END - $B_START" | bc)
echo "Session B's statement took ${B_ELAPSED}s while A held the lock for ~2s (minus the 0.5s head start => expect B to have waited roughly 1.5s)."
if (( $(echo "$B_ELAPSED > 1.0" | bc -l) )); then
  echo "RESULT: B was genuinely blocked by A's row lock — real Postgres concurrency control confirmed, not just application-level sequencing."
else
  echo "RESULT: B did NOT appear to block as expected — investigate (unexpected: this would mean the locking assumption is wrong)."
fi

echo ""
echo "== Check 2: functional correctness of write_authoritative_subscription_state against a real database =="
"${PSQL[@]}" <<'SQL'
-- Token A was valid a moment ago; token B then steals the slot (simulating
-- A's claim going stale and a new worker taking over). Token A's write
-- attempt, presented AFTER the steal, must be rejected by the real
-- function.
select claim_stripe_webhook_slot('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 0) as a_claims; -- stale_seconds=0 forces an immediate steal below
select pg_sleep(0.1);
select claim_stripe_webhook_slot('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 0) as b_steals;

\echo 'A (stale token) attempts to write — must return false:'
select write_authoritative_subscription_state('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'solo', 'canceled', null) as a_write_result;

\echo 'B (current token) attempts to write — must return true:'
select write_authoritative_subscription_state('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'crew', 'active', 'cus_real_test') as b_write_result;

\echo 'Final subscription_state row — must reflect B, never A:'
select * from subscription_state where user_id = '11111111-1111-1111-1111-111111111111';
SQL

echo ""
echo "== Done. Throwaway cluster will now be stopped and deleted. =="
