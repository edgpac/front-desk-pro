#!/usr/bin/env bash
# Real-PostgreSQL verification for 0025_whatsapp_opt_outs.sql
# (record_whatsapp_opt_out, claim_whatsapp_opt_out_confirmation,
# release_whatsapp_opt_out_confirmation, mark_whatsapp_opt_out_confirmation_sent,
# resume_whatsapp_opt_out) — same disposable-cluster safety model as
# pg-whatsapp-loop-guard-check.sh and the other pg-*.sh scripts: a fresh
# throwaway Postgres cluster, bound ONLY to a Unix socket, torn down on
# exit regardless of outcome.
#
# What this verifies, in order:
#   1. All migration files apply cleanly, including 0025 alongside every
#      prior migration.
#   2. A first-ever opt-out is recorded with just_opted_out = true; a
#      repeat STOP from the same (tenant, phone) while already opted out
#      reports just_opted_out = false — the confirmation-dedup guarantee.
#   3. The claim/release/mark-sent confirmation state machine behaves
#      exactly like the loop guard's own proven notice-claim sequence:
#      only a 'pending' (or stale 'sending') claims; release puts it back
#      for retry; mark-sent only succeeds from 'sending'.
#   4. resume_whatsapp_opt_out clears the opted-out state, rejects an
#      unrecognized resumed_by value, and is a no-op when the phone isn't
#      currently opted out.
#   5. Opting out again after a resume is treated as a genuinely fresh
#      cycle (just_opted_out = true again, a new confirmation owed).
#   6. Tenant isolation: the same phone number under two different
#      tenants never shares opt-out state.
#   7. Genuine concurrency: two REAL, separate psql processes racing
#      record_whatsapp_opt_out on a brand-new (tenant, phone) — exactly
#      one reports just_opted_out = true, proven with actual concurrent
#      connections, not simulated — this is the specific race a prior
#      review found broken in an earlier draft of this function (see its
#      own migration comment).
#   8. Genuine concurrency: two REAL processes racing
#      claim_whatsapp_opt_out_confirmation on the same pending
#      confirmation — exactly one claims it.
#
# Usage:
#   bash scripts/pg-whatsapp-opt-out-check.sh
#
# Requires a local postgres/initdb/psql on PATH or via PG_BIN_DIR=/path/to/bin.

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

WORKDIR=$(mktemp -d /tmp/pg-whatsapp-opt-out-check.XXXXXX)
PGDATA="$WORKDIR/data"
PGPORT=55336
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
  local desc="$1"; shift
  if "$@"; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo "== Initializing throwaway Postgres cluster at $PGDATA (port $PGPORT, Unix socket only) =="
"$PG_BIN_DIR/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PG_BIN_DIR/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -p $PGPORT -c listen_addresses=''" -l "$WORKDIR/server.log" start >/dev/null

PSQL_SUPERUSER=("$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q -P pager=off -d postgres)
psql_t() { "$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -q -t -A -d postgres -v ON_ERROR_STOP=1 -c "$1"; }
psql_t_noerr() { "$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -q -t -A -d postgres -c "$1" 2>&1; }

echo ""
echo "== Bootstrapping the same minimal stand-in for Supabase's own schema/roles as the other pg-*.sh scripts =="
"${PSQL_SUPERUSER[@]}" <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to service_role;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
SQL

echo ""
echo "== Applying migrations verbatim, in order (including 0025 alongside every prior migration) =="
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
echo "== Seeding two separate tenants =="
USER_A="a0a0a0a0-0000-0000-0000-00000000000a"
USER_B="b0b0b0b0-0000-0000-0000-00000000000b"
"${PSQL_SUPERUSER[@]}" -c "
insert into auth.users (id, email) values ('$USER_A', 'owner-a@example.test'), ('$USER_B', 'owner-b@example.test');
" >/dev/null
TENANT_A=$(psql_t "update tenants set name = 'Tenant A' where user_id = '$USER_A' returning id;")
TENANT_B=$(psql_t "update tenants set name = 'Tenant B' where user_id = '$USER_B' returning id;")
PHONE="+15559876543"
echo "  tenant A: $TENANT_A / tenant B: $TENANT_B / shared phone: $PHONE"

echo ""
echo "== Section 1: a first-ever opt-out is fresh; a repeat STOP is not =="
R1=$(psql_t "select just_opted_out from record_whatsapp_opt_out('$TENANT_A', '$PHONE');")
check "first-ever opt-out reports just_opted_out = true (got: $R1)" bash -c "[ '$R1' = 't' ]"
R2=$(psql_t "select just_opted_out from record_whatsapp_opt_out('$TENANT_A', '$PHONE');")
check "repeat STOP while already opted out reports just_opted_out = false (got: $R2)" bash -c "[ '$R2' = 'f' ]"
R3=$(psql_t "select just_opted_out from record_whatsapp_opt_out('$TENANT_A', '$PHONE');")
check "a THIRD repeat STOP still reports false, not oscillating (got: $R3)" bash -c "[ '$R3' = 'f' ]"
STATUS_AFTER=$(psql_t "select confirmation_status from whatsapp_opt_outs where tenant_id = '$TENANT_A' and phone = '$PHONE';")
check "confirmation_status is still 'pending' after repeats — unaffected by them (got: $STATUS_AFTER)" bash -c "[ '$STATUS_AFTER' = 'pending' ]"

echo ""
echo "== Section 2: confirmation claim/release/mark-sent state machine =="
C1=$(psql_t "select claim_whatsapp_opt_out_confirmation('$TENANT_A', '$PHONE', 60);")
check "claim succeeds from 'pending' (got: $C1)" bash -c "[ '$C1' = 't' ]"
C2=$(psql_t "select claim_whatsapp_opt_out_confirmation('$TENANT_A', '$PHONE', 60);")
check "a second claim while already 'sending' (not yet stale) fails (got: $C2)" bash -c "[ '$C2' = 'f' ]"
REL1=$(psql_t "select release_whatsapp_opt_out_confirmation('$TENANT_A', '$PHONE');")
check "release succeeds from 'sending' (got: $REL1)" bash -c "[ '$REL1' = 't' ]"
STATUS_AFTER_RELEASE=$(psql_t "select confirmation_status from whatsapp_opt_outs where tenant_id = '$TENANT_A' and phone = '$PHONE';")
check "status is back to 'pending' after release (got: $STATUS_AFTER_RELEASE)" bash -c "[ '$STATUS_AFTER_RELEASE' = 'pending' ]"
C3=$(psql_t "select claim_whatsapp_opt_out_confirmation('$TENANT_A', '$PHONE', 60);")
check "re-claim succeeds after release (got: $C3)" bash -c "[ '$C3' = 't' ]"
M1=$(psql_t "select mark_whatsapp_opt_out_confirmation_sent('$TENANT_A', '$PHONE');")
check "mark-sent succeeds from 'sending' (got: $M1)" bash -c "[ '$M1' = 't' ]"
M2=$(psql_t "select mark_whatsapp_opt_out_confirmation_sent('$TENANT_A', '$PHONE');")
check "a second mark-sent (already 'sent') fails — never double-confirms (got: $M2)" bash -c "[ '$M2' = 'f' ]"
STATUS_FINAL=$(psql_t "select confirmation_status from whatsapp_opt_outs where tenant_id = '$TENANT_A' and phone = '$PHONE';")
check "status is 'sent' (got: $STATUS_FINAL)" bash -c "[ '$STATUS_FINAL' = 'sent' ]"

echo ""
echo "== Section 3: resume clears the opted-out state, rejects an invalid reason, no-ops when not opted out =="
set +e
RESUME_BAD=$(psql_t_noerr "select resume_whatsapp_opt_out('$TENANT_A', '$PHONE', 'because_i_said_so');")
set -e
check "resume rejects an unrecognized resumed_by value (got: $RESUME_BAD)" bash -c "echo \"$RESUME_BAD\" | grep -q 'invalid resumed_by'"
RESUME_1=$(psql_t "select resume_whatsapp_opt_out('$TENANT_A', '$PHONE', 'opt_in_keyword');")
check "resume succeeds with a valid reason (got: $RESUME_1)" bash -c "[ '$RESUME_1' = 't' ]"
RESUMED_BY=$(psql_t "select resumed_by from whatsapp_opt_outs where tenant_id = '$TENANT_A' and phone = '$PHONE';")
check "resumed_by is recorded correctly (got: $RESUMED_BY)" bash -c "[ '$RESUMED_BY' = 'opt_in_keyword' ]"
RESUME_NOOP=$(psql_t "select resume_whatsapp_opt_out('$TENANT_A', '$PHONE', 'dashboard_action');")
check "resuming an already-resumed (not currently opted out) phone is a no-op, returns false (got: $RESUME_NOOP)" bash -c "[ '$RESUME_NOOP' = 'f' ]"

echo ""
echo "== Section 4: opting out again after a resume is a genuinely fresh cycle =="
R_AGAIN=$(psql_t "select just_opted_out from record_whatsapp_opt_out('$TENANT_A', '$PHONE');")
check "opting out again after a resume reports just_opted_out = true (got: $R_AGAIN)" bash -c "[ '$R_AGAIN' = 't' ]"
STATUS_FRESH=$(psql_t "select confirmation_status from whatsapp_opt_outs where tenant_id = '$TENANT_A' and phone = '$PHONE';")
check "confirmation_status reset to 'pending' for the new cycle, not left at 'sent' from before (got: $STATUS_FRESH)" bash -c "[ '$STATUS_FRESH' = 'pending' ]"
RESUMED_AT_CLEARED=$(psql_t "select resumed_at is null from whatsapp_opt_outs where tenant_id = '$TENANT_A' and phone = '$PHONE';")
check "resumed_at/resumed_by cleared on the fresh opt-out — they describe the PREVIOUS cycle (got: $RESUMED_AT_CLEARED)" bash -c "[ '$RESUMED_AT_CLEARED' = 't' ]"

echo ""
echo "== Section 5: tenant isolation — the same phone never shares opt-out state across tenants =="
TENANT_B_OPTED_OUT=$(psql_t "select exists(select 1 from whatsapp_opt_outs where tenant_id = '$TENANT_B' and phone = '$PHONE');")
check "tenant B has no opt-out row at all for this phone, despite tenant A being opted out (got: $TENANT_B_OPTED_OUT)" bash -c "[ '$TENANT_B_OPTED_OUT' = 'f' ]"
RB1=$(psql_t "select just_opted_out from record_whatsapp_opt_out('$TENANT_B', '$PHONE');")
check "tenant B can independently opt out the same phone, as a fresh event (got: $RB1)" bash -c "[ '$RB1' = 't' ]"
TENANT_A_STILL_OPTED_OUT=$(psql_t "select resumed_at is null from whatsapp_opt_outs where tenant_id = '$TENANT_A' and phone = '$PHONE';")
check "tenant A's own opt-out state is untouched by tenant B's (got: $TENANT_A_STILL_OPTED_OUT)" bash -c "[ '$TENANT_A_STILL_OPTED_OUT' = 't' ]"

echo ""
echo "== Genuine concurrency #1: two real, separate psql processes racing record_whatsapp_opt_out on a BRAND-NEW (tenant, phone) =="
RACE_PHONE="+15550001111"
RESULT_1_FILE=$(mktemp)
RESULT_2_FILE=$(mktemp)
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -q -t -A -d postgres -c \
  "select just_opted_out from record_whatsapp_opt_out('$TENANT_A', '$RACE_PHONE');" > "$RESULT_1_FILE" 2>&1 &
PID_1=$!
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -q -t -A -d postgres -c \
  "select just_opted_out from record_whatsapp_opt_out('$TENANT_A', '$RACE_PHONE');" > "$RESULT_2_FILE" 2>&1 &
PID_2=$!
wait "$PID_1" "$PID_2"
R1_RACE=$(tr -d '[:space:]' < "$RESULT_1_FILE")
R2_RACE=$(tr -d '[:space:]' < "$RESULT_2_FILE")
rm -f "$RESULT_1_FILE" "$RESULT_2_FILE"
TRUE_COUNT=0
[ "$R1_RACE" = "t" ] && TRUE_COUNT=$((TRUE_COUNT + 1))
[ "$R2_RACE" = "t" ] && TRUE_COUNT=$((TRUE_COUNT + 1))
check "exactly one of two genuinely concurrent first-ever opt-out calls reports just_opted_out = true (got results: '$R1_RACE', '$R2_RACE')" bash -c "[ $TRUE_COUNT -eq 1 ]"

echo ""
echo "== Genuine concurrency #2: two real, separate psql processes racing claim_whatsapp_opt_out_confirmation on the SAME pending confirmation =="
CLAIM_RESULT_1_FILE=$(mktemp)
CLAIM_RESULT_2_FILE=$(mktemp)
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -q -t -A -d postgres -c \
  "select claim_whatsapp_opt_out_confirmation('$TENANT_A', '$RACE_PHONE', 60);" > "$CLAIM_RESULT_1_FILE" 2>&1 &
CPID_1=$!
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -q -t -A -d postgres -c \
  "select claim_whatsapp_opt_out_confirmation('$TENANT_A', '$RACE_PHONE', 60);" > "$CLAIM_RESULT_2_FILE" 2>&1 &
CPID_2=$!
wait "$CPID_1" "$CPID_2"
CR1=$(tr -d '[:space:]' < "$CLAIM_RESULT_1_FILE")
CR2=$(tr -d '[:space:]' < "$CLAIM_RESULT_2_FILE")
rm -f "$CLAIM_RESULT_1_FILE" "$CLAIM_RESULT_2_FILE"
CLAIM_TRUE_COUNT=0
[ "$CR1" = "t" ] && CLAIM_TRUE_COUNT=$((CLAIM_TRUE_COUNT + 1))
[ "$CR2" = "t" ] && CLAIM_TRUE_COUNT=$((CLAIM_TRUE_COUNT + 1))
check "exactly one of two genuinely concurrent confirmation claims succeeds (got results: '$CR1', '$CR2')" bash -c "[ $CLAIM_TRUE_COUNT -eq 1 ]"

echo ""
echo "== Genuine concurrency #3: real, separate psql processes racing OPPOSITE operations — a repeat STOP against a START/resume, both on an ALREADY opted-out phone =="
OPPOSE_PHONE="+15550002222"
psql_t "select record_whatsapp_opt_out('$TENANT_A', '$OPPOSE_PHONE');" >/dev/null
OPPOSE_STOP_FILE=$(mktemp)
OPPOSE_START_FILE=$(mktemp)
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -q -t -A -d postgres -c \
  "select just_opted_out from record_whatsapp_opt_out('$TENANT_A', '$OPPOSE_PHONE');" > "$OPPOSE_STOP_FILE" 2>&1 &
OPID_1=$!
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -q -t -A -d postgres -c \
  "select resume_whatsapp_opt_out('$TENANT_A', '$OPPOSE_PHONE', 'opt_in_keyword');" > "$OPPOSE_START_FILE" 2>&1 &
OPID_2=$!
wait "$OPID_1" "$OPID_2"
OPPOSE_STOP_RESULT=$(tr -d '[:space:]' < "$OPPOSE_STOP_FILE")
OPPOSE_START_RESULT=$(tr -d '[:space:]' < "$OPPOSE_START_FILE")
rm -f "$OPPOSE_STOP_FILE" "$OPPOSE_START_FILE"
# The repeat STOP's own WHERE clause only ever fires when the row is
# currently RESUMED (not opted out) — since this phone starts already
# opted out, record_whatsapp_opt_out's conditional UPDATE can never match
# regardless of how the race against resume_whatsapp_opt_out resolves, so
# this specific repeat-STOP must always report false. The two operations'
# WHERE clauses are mutually exclusive preconditions on the SAME row's
# current state (one requires "currently resumed", the other requires
# "currently opted out") — by construction, at most one of two opposing
# operations can ever have a matching precondition for a given committed
# state, which is what this assertion actually proves empirically rather
# than just by reading the SQL.
check "a repeat STOP racing a resume on an already-opted-out phone never reports a fresh opt-out (got: $OPPOSE_STOP_RESULT)" bash -c "[ '$OPPOSE_STOP_RESULT' = 'f' ]"
check "the concurrent resume succeeds (got: $OPPOSE_START_RESULT)" bash -c "[ '$OPPOSE_START_RESULT' = 't' ]"
FINAL_STATE=$(psql_t "select (resumed_at is not null and resumed_at >= opted_out_at) from whatsapp_opt_outs where tenant_id = '$TENANT_A' and phone = '$OPPOSE_PHONE';")
check "final committed state is consistent (not opted out) — no stale write silently overrode the resume (got: $FINAL_STATE)" bash -c "[ '$FINAL_STATE' = 't' ]"

echo ""
echo "== Summary: $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
