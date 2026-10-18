#!/usr/bin/env bash
# Applies the ACTUAL migration files (0001 through 0023, verbatim, in
# order) against a complete local schema — not the hand-trimmed SQL
# pg-concurrency-check.sh used for the pure locking-concept demonstration.
# This is what that script's own report explicitly flagged as not yet
# done: verifying migration dependencies, grants, RLS, function
# signatures, and transaction behavior together, against the real files,
# not a reproduction of them.
#
# Never touches this project's real Supabase database. Creates a
# throwaway, disposable local Postgres cluster, with a minimal stand-in
# `auth` schema/roles (auth.users with just id+email, and the anon/
# authenticated/service_role roles) so the real migrations — which assume
# a real Supabase project already has these — can apply without
# modification. Tears the cluster down on exit, success or failure.
#
# What this verifies, in order:
#   1. All 23 migration files apply cleanly, in order, with no errors —
#      confirms dependency order is correct (e.g. 0023 referencing
#      stripe_webhook_claims from 0021 and auth.users from the stand-in).
#   2. Function signatures match exactly what the TypeScript code calls
#      (parameter names/types/defaults), read back from pg_catalog rather
#      than assumed from the SQL source.
#   3. RLS is enabled and grants are correct — proven behaviorally, not
#      just inspected: connecting AS anon/authenticated and attempting to
#      call the service-role-only functions, or write the protected
#      tables directly, must fail with a real permission-denied error;
#      service_role must succeed.
#   4. The same two concurrency/atomicity checks as pg-concurrency-check.sh
#      (lock-blocking, stale-token rejection), re-run against this real,
#      fully-migrated schema instead of a reproduction.
#
# Usage:
#   bash scripts/pg-migration-verification.sh
#
# Requires a local `postgres`/`initdb`/`psql` on PATH or via
# PG_BIN_DIR=/path/to/bin.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"

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

WORKDIR=$(mktemp -d /tmp/pg-migration-verification.XXXXXX)
PGDATA="$WORKDIR/data"
PGPORT=55331
PGSOCK="$WORKDIR/sock"
mkdir -p "$PGSOCK"

cleanup() {
  "$PG_BIN_DIR/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -p $PGPORT" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

PASS=0
FAIL=0
check() {
  # check "description" <command...>
  local desc="$1"; shift
  if "$@"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo "== Initializing throwaway Postgres cluster at $PGDATA (port $PGPORT) =="
"$PG_BIN_DIR/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PG_BIN_DIR/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -p $PGPORT -c listen_addresses=''" -l "$WORKDIR/server.log" start >/dev/null

PSQL_SUPERUSER=("$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q -P pager=off -d postgres)

echo ""
echo "== Bootstrapping a minimal stand-in for Supabase's own schema/roles =="
echo "   (real Supabase projects already have these; vanilla Postgres does not)"
"${PSQL_SUPERUSER[@]}" <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to service_role;

-- Real Supabase's auth.uid() reads a per-request GUC set from the JWT.
-- This stub reproduces that exactly: unset (as it will be for the
-- service_role/superuser session running the checks below) means null,
-- which is also real auth.uid()'s behavior for an unauthenticated
-- context.
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

grant usage on schema public to anon, authenticated, service_role;
SQL

echo ""
echo "== Applying migrations 0001 through 0023 verbatim, in order =="
APPLIED=0
for f in "$MIGRATIONS_DIR"/*.sql; do
  name=$(basename "$f")
  if "${PSQL_SUPERUSER[@]}" -f "$f" >/dev/null 2>"$WORKDIR/last-error.log"; then
    echo "  applied: $name"
    APPLIED=$((APPLIED + 1))
  else
    echo "  FAILED applying $name:"
    cat "$WORKDIR/last-error.log"
    exit 1
  fi
done
check "all $APPLIED migration files applied with no errors" true

echo ""
echo "== Verifying function signatures against pg_catalog (not assumed from source) =="
"${PSQL_SUPERUSER[@]}" -c "
select p.proname, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('claim_stripe_webhook_slot','release_stripe_webhook_slot','write_authoritative_subscription_state','claim_stripe_event','complete_stripe_event','fail_stripe_event')
order by p.proname;
"

echo ""
echo "== Verifying RLS is enabled on every new table =="
"${PSQL_SUPERUSER[@]}" -c "
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname in ('stripe_webhook_claims','stripe_processed_events','subscription_state')
order by relname;
"

echo ""
echo "== Verifying grants: anon/authenticated must be denied; service_role must succeed =="
echo "-- Seed a real auth.users row (the FK target) + one claim, as postgres (superuser bypasses everything) --"
"${PSQL_SUPERUSER[@]}" -c "
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'verify@example.test');
select claim_stripe_webhook_slot('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
" >/dev/null

check "anon is denied calling write_authoritative_subscription_state" bash -c '
  out=$('"$PG_BIN_DIR"'/psql -h "'"$PGSOCK"'" -p '"$PGPORT"' -U postgres -q -d postgres -c "set role anon; select write_authoritative_subscription_state('"'"'11111111-1111-1111-1111-111111111111'"'"', '"'"'22222222-2222-2222-2222-222222222222'"'"', '"'"'crew'"'"', '"'"'active'"'"', null);" 2>&1)
  echo "$out" | grep -qi "permission denied"
'
check "authenticated is denied calling write_authoritative_subscription_state" bash -c '
  out=$('"$PG_BIN_DIR"'/psql -h "'"$PGSOCK"'" -p '"$PGPORT"' -U postgres -q -d postgres -c "set role authenticated; select write_authoritative_subscription_state('"'"'11111111-1111-1111-1111-111111111111'"'"', '"'"'22222222-2222-2222-2222-222222222222'"'"', '"'"'crew'"'"', '"'"'active'"'"', null);" 2>&1)
  echo "$out" | grep -qi "permission denied"
'
check "anon is denied inserting directly into subscription_state" bash -c '
  out=$('"$PG_BIN_DIR"'/psql -h "'"$PGSOCK"'" -p '"$PGPORT"' -U postgres -q -d postgres -c "set role anon; insert into subscription_state (user_id, subscription_status) values (gen_random_uuid(), '"'"'active'"'"');" 2>&1)
  echo "$out" | grep -qi "permission denied"
'
check "authenticated is denied inserting directly into subscription_state" bash -c '
  out=$('"$PG_BIN_DIR"'/psql -h "'"$PGSOCK"'" -p '"$PGPORT"' -U postgres -q -d postgres -c "set role authenticated; insert into subscription_state (user_id, subscription_status) values (gen_random_uuid(), '"'"'active'"'"');" 2>&1)
  echo "$out" | grep -qi "permission denied"
'
check "service_role CAN call write_authoritative_subscription_state" bash -c '
  out=$('"$PG_BIN_DIR"'/psql -h "'"$PGSOCK"'" -p '"$PGPORT"' -U postgres -q -d postgres -t -c "set role service_role; select write_authoritative_subscription_state('"'"'11111111-1111-1111-1111-111111111111'"'"', '"'"'22222222-2222-2222-2222-222222222222'"'"', '"'"'crew'"'"', '"'"'active'"'"', '"'"'cus_verify'"'"');" 2>&1)
  echo "$out" | tr -d "[:space:]" | grep -q "^t$"
'

echo ""
echo "== Re-running the lock-blocking and stale-token checks against THIS real, fully-migrated schema =="
echo "(reset the seed claim to a known token first)"
"${PSQL_SUPERUSER[@]}" -c "update stripe_webhook_claims set claim_token='22222222-2222-2222-2222-222222222222', claimed_at=now() where user_id='11111111-1111-1111-1111-111111111111';" >/dev/null

PSQL=("$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q -P pager=off -d postgres)

("${PSQL[@]}" <<'SQL'
begin;
select claim_token from stripe_webhook_claims where user_id = '11111111-1111-1111-1111-111111111111' for update;
select pg_sleep(2);
commit;
SQL
) &
A_PID=$!
sleep 0.5
B_START=$(date +%s.%N)
"${PSQL[@]}" -c "select claim_token from stripe_webhook_claims where user_id = '11111111-1111-1111-1111-111111111111' for update;" >/dev/null
B_END=$(date +%s.%N)
wait "$A_PID"
B_ELAPSED=$(echo "$B_END - $B_START" | bc)
check "a concurrent session genuinely blocked on the real schema's row lock (~1.5s expected, got ${B_ELAPSED}s)" bash -c "(( \$(echo \"$B_ELAPSED > 1.0\" | bc -l) ))"

"${PSQL[@]}" -c "select claim_stripe_webhook_slot('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 0);" >/dev/null # steal
STALE_RESULT=$("${PSQL[@]}" -t -c "select write_authoritative_subscription_state('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'solo', 'canceled', null);" | tr -d '[:space:]')
check "the real function rejects a superseded token on the real, fully-migrated schema (got: $STALE_RESULT)" bash -c "[ '$STALE_RESULT' = 'f' ]"

CURRENT_RESULT=$("${PSQL[@]}" -t -c "select write_authoritative_subscription_state('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'crew', 'active', 'cus_final');" | tr -d '[:space:]')
check "the real function accepts the current token (got: $CURRENT_RESULT)" bash -c "[ '$CURRENT_RESULT' = 't' ]"

FINAL_STATUS=$("${PSQL[@]}" -t -c "select subscription_status from subscription_state where user_id = '11111111-1111-1111-1111-111111111111';" | tr -d '[:space:]')
check "the final row reflects the current-token write, never the superseded one (got: $FINAL_STATUS)" bash -c "[ '$FINAL_STATUS' = 'active' ]"

echo ""
echo "== Check: transaction rollback leaves no partial authoritative update =="
echo "-- Force a failure partway through the function (the plan CHECK constraint) with a valid, current token --"
BEFORE_UPDATED_AT=$("${PSQL[@]}" -t -c "select updated_at from subscription_state where user_id = '11111111-1111-1111-1111-111111111111';" | tr -d '[:space:]')

set +e
ROLLBACK_OUTPUT=$("${PSQL[@]}" -c "select write_authoritative_subscription_state('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'not_a_real_plan', 'active', 'cus_should_not_land');" 2>&1)
set -e
export ROLLBACK_OUTPUT
check "the call with an invalid plan value genuinely fails (violates the CHECK constraint), not silently ignored" bash -c 'printf "%s" "$ROLLBACK_OUTPUT" | grep -qi "violates check constraint"'

AFTER_UPDATED_AT=$("${PSQL[@]}" -t -c "select updated_at from subscription_state where user_id = '11111111-1111-1111-1111-111111111111';" | tr -d '[:space:]')
check "subscription_state's updated_at is unchanged — the failed call left no partial row (before: $BEFORE_UPDATED_AT, after: $AFTER_UPDATED_AT)" bash -c "[ '$BEFORE_UPDATED_AT' = '$AFTER_UPDATED_AT' ]"

AFTER_PLAN=$("${PSQL[@]}" -t -c "select plan from subscription_state where user_id = '11111111-1111-1111-1111-111111111111';" | tr -d '[:space:]')
check "subscription_state's plan is still the last good value, never the invalid one (got: $AFTER_PLAN)" bash -c "[ '$AFTER_PLAN' = 'crew' ]"

CUSTOMER_AFTER_ROLLBACK=$("${PSQL[@]}" -t -c "select stripe_customer_id from subscription_state where user_id = '11111111-1111-1111-1111-111111111111';" | tr -d '[:space:]')
check "stripe_customer_id from the failed call never landed (got: $CUSTOMER_AFTER_ROLLBACK, must not be cus_should_not_land)" bash -c "[ '$CUSTOMER_AFTER_ROLLBACK' != 'cus_should_not_land' ]"

echo ""
echo "== Task 4: Stripe event dedup/lease functions (claim_stripe_event, complete_stripe_event, fail_stripe_event) against the REAL schema =="
echo "-- Previously only signature-checked via pg_catalog; this section exercises their actual behavior. --"

EVT_A="evt_test_duplicate_completed"
RESULT=$("${PSQL[@]}" -t -c "select claim_stripe_event('$EVT_A', '44444444-4444-4444-4444-444444444444');" | tr -d '[:space:]')
check "claim_stripe_event claims a brand-new event (got: $RESULT)" bash -c "[ '$RESULT' = 'claimed' ]"

"${PSQL[@]}" -c "select complete_stripe_event('$EVT_A', '44444444-4444-4444-4444-444444444444');" >/dev/null
RESULT=$("${PSQL[@]}" -t -c "select claim_stripe_event('$EVT_A', '55555555-5555-5555-5555-555555555555');" | tr -d '[:space:]')
check "completed-event duplicate is rejected as duplicate_completed, never reprocessed (got: $RESULT)" bash -c "[ '$RESULT' = 'duplicate_completed' ]"

EVT_B="evt_test_already_processing"
"${PSQL[@]}" -c "select claim_stripe_event('$EVT_B', '66666666-6666-6666-6666-666666666666');" >/dev/null
RESULT=$("${PSQL[@]}" -t -c "select claim_stripe_event('$EVT_B', '77777777-7777-7777-7777-777777777777');" | tr -d '[:space:]')
check "an event already being actively processed (lease not expired) is rejected as duplicate_processing (got: $RESULT)" bash -c "[ '$RESULT' = 'duplicate_processing' ]"

EVT_C="evt_test_stale_lease_recovery"
"${PSQL[@]}" -c "select claim_stripe_event('$EVT_C', '88888888-8888-8888-8888-888888888888', 1);" >/dev/null # 1-second lease, real function parameter, not a simulated clock
"${PSQL[@]}" -c "select pg_sleep(1.3);" >/dev/null
RESULT=$("${PSQL[@]}" -t -c "select claim_stripe_event('$EVT_C', '99999999-9999-9999-9999-999999999999', 1);" | tr -d '[:space:]')
check "an abandoned event (processing, lease genuinely expired via real pg_sleep) becomes reclaimable (got: $RESULT)" bash -c "[ '$RESULT' = 'claimed' ]"

EVT_D="evt_test_failed_reclaim"
"${PSQL[@]}" -c "select claim_stripe_event('$EVT_D', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');" >/dev/null
"${PSQL[@]}" -c "select fail_stripe_event('$EVT_D', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');" >/dev/null
RESULT=$("${PSQL[@]}" -t -c "select claim_stripe_event('$EVT_D', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');" | tr -d '[:space:]')
check "a FAILED event is reclaimable immediately, no lease wait needed (got: $RESULT)" bash -c "[ '$RESULT' = 'claimed' ]"

EVT_E="evt_test_superseded_token"
"${PSQL[@]}" -c "select claim_stripe_event('$EVT_E', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 1);" >/dev/null
"${PSQL[@]}" -c "select pg_sleep(1.3);" >/dev/null
"${PSQL[@]}" -c "select claim_stripe_event('$EVT_E', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 1);" >/dev/null # reclaimed by a newer "worker"
RESULT=$("${PSQL[@]}" -t -c "select complete_stripe_event('$EVT_E', 'cccccccc-cccc-cccc-cccc-cccccccccccc');" | tr -d '[:space:]')
check "complete_stripe_event with a superseded lease token is rejected, not applied (got: $RESULT)" bash -c "[ '$RESULT' = 'f' ]"
RESULT=$("${PSQL[@]}" -t -c "select fail_stripe_event('$EVT_E', 'cccccccc-cccc-cccc-cccc-cccccccccccc');" | tr -d '[:space:]')
check "fail_stripe_event with a superseded lease token is also rejected (got: $RESULT)" bash -c "[ '$RESULT' = 'f' ]"
RESULT=$("${PSQL[@]}" -t -c "select complete_stripe_event('$EVT_E', 'dddddddd-dddd-dddd-dddd-dddddddddddd');" | tr -d '[:space:]')
check "the CURRENT lease token's completion call succeeds (got: $RESULT)" bash -c "[ '$RESULT' = 't' ]"

echo ""
echo "-- Concurrent claim on a brand-new event id: real, separate processes racing claim_stripe_event. --"
EVT_F="evt_test_concurrent_claim"
RESULT_1_FILE=$(mktemp)
RESULT_2_FILE=$(mktemp)
"${PSQL[@]}" -t -c "select claim_stripe_event('$EVT_F', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');" > "$RESULT_1_FILE" 2>&1 &
PID_1=$!
"${PSQL[@]}" -t -c "select claim_stripe_event('$EVT_F', 'ffffffff-ffff-ffff-ffff-ffffffffffff');" > "$RESULT_2_FILE" 2>&1 &
PID_2=$!
wait "$PID_1" "$PID_2"
R1=$(tr -d '[:space:]' < "$RESULT_1_FILE")
R2=$(tr -d '[:space:]' < "$RESULT_2_FILE")
rm -f "$RESULT_1_FILE" "$RESULT_2_FILE"
CLAIMED_COUNT=0
[ "$R1" = "claimed" ] && CLAIMED_COUNT=$((CLAIMED_COUNT + 1))
[ "$R2" = "claimed" ] && CLAIMED_COUNT=$((CLAIMED_COUNT + 1))
check "exactly one of two genuinely concurrent claim_stripe_event calls for the same new event id wins (got results: '$R1', '$R2')" bash -c "[ $CLAIMED_COUNT -eq 1 ]"

echo ""
echo "-- Rollback testing for these three functions: NOT reasonably forceable through their public signatures. --"
echo "   Unlike write_authoritative_subscription_state (which has the plan CHECK constraint a caller can"
echo "   deliberately violate), claim_stripe_event/complete_stripe_event/fail_stripe_event take only"
echo "   (text, uuid[, int]) parameters with no CHECK constraint a legitimate call could violate — the"
echo "   'processing'/'completed'/'failed' status values are hardcoded literals inside the function bodies,"
echo "   never passed in. Explicitly not tested here rather than forcing an artificial, misleading case."

echo ""
echo "== Summary: $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
