#!/usr/bin/env bash
# Permanent real-Postgres regression coverage for update_lead_with_line_items
# (0019_lead_write_atomicity.sql, fixed by 0028_fix_lead_reassessment_atomicity.sql).
#
# Never touches this project's real Supabase database. Creates a throwaway,
# disposable local Postgres cluster — same bootstrap as
# scripts/pg-migration-verification.sh (minimal stand-in auth schema/roles,
# the REAL migration files applied verbatim, not hand-copied SQL). Torn down
# on exit, success or failure.
#
# RED/GREEN structure, both halves actually executed (not claimed):
#   1. Apply every migration file EXCEPT 0028 (i.e. the ORIGINAL, still-buggy
#      update_lead_with_line_items from 0019) and run the two defect checks
#      — both are expected, and confirmed, to FAIL. This is the "red" half.
#   2. Apply 0028 on top (create or replace function, same live cluster,
#      same data) and re-run the identical checks — both are expected, and
#      confirmed, to PASS. This is the "green" half.
#   3. Run the remaining scenarios (initial creation, composition changes,
#      unrelated-flag preservation, rollback, tenant isolation, concurrency,
#      existing-caller compatibility) against the fixed function.
#
# Usage:
#   bash scripts/pg-lead-reassessment-check.sh
#
# Requires a local postgres/initdb/psql on PATH, or via
# PG_BIN_DIR=/path/to/bin.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
FIX_MIGRATION="0028_fix_lead_reassessment_atomicity.sql"

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

WORKDIR=$(mktemp -d /tmp/pg-lead-reassessment-check.XXXXXX)
PGDATA="$WORKDIR/data"
PGPORT=55341
PGSOCK="$WORKDIR/sock"
mkdir -p "$PGSOCK"

cleanup() {
  "$PG_BIN_DIR/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -p $PGPORT" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

PASS=0
FAIL=0
# check DESCRIPTION ACTUAL EXPECTED — plain string equality, no subshells,
# no dependence on any function/array being visible anywhere special.
check() {
  local desc="$1" actual="$2" expected="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (got '$actual', expected '$expected')"; FAIL=$((FAIL + 1))
  fi
}
check_not_equal() {
  local desc="$1" actual="$2" not_expected="$3"
  if [ "$actual" != "$not_expected" ]; then
    echo "  PASS: $desc"; PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc (got '$actual', which should NOT equal '$not_expected')"; FAIL=$((FAIL + 1))
  fi
}
check_true() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  PASS: $desc"; PASS=$((PASS + 1)); else echo "  FAIL: $desc"; FAIL=$((FAIL + 1)); fi
}
check_false() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  FAIL: $desc (expected this to error, it didn't)"; FAIL=$((FAIL + 1)); else echo "  PASS: $desc"; PASS=$((PASS + 1)); fi
}

echo "== Initializing throwaway Postgres cluster at $PGDATA (port $PGPORT) =="
"$PG_BIN_DIR/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PG_BIN_DIR/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -p $PGPORT -c listen_addresses=''" -l "$WORKDIR/server.log" start >/dev/null

PSQL=("$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q -P pager=off -d postgres)
psql_t() { "${PSQL[@]}" -t -A -c "$1"; }
psql_run() { "${PSQL[@]}" -c "$1" >/dev/null; }
psql_run_may_fail() { "${PSQL[@]}" -c "$1" >"$WORKDIR/last-call.log" 2>&1; }

echo ""
echo "== Bootstrapping a minimal stand-in for Supabase's own schema/roles =="
"${PSQL[@]}" <<'SQL'
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
SQL

echo ""
echo "== RED: applying every real migration file EXCEPT $FIX_MIGRATION =="
APPLIED=0
for f in "$MIGRATIONS_DIR"/*.sql; do
  name=$(basename "$f")
  if [ "$name" = "$FIX_MIGRATION" ]; then continue; fi
  if "${PSQL[@]}" -f "$f" >/dev/null 2>"$WORKDIR/last-error.log"; then
    APPLIED=$((APPLIED + 1))
  else
    echo "  FAILED applying $name:"; cat "$WORKDIR/last-error.log"; exit 1
  fi
done
check "pre-fix migrations applied" "$APPLIED applied, no errors" "$APPLIED applied, no errors"

# Inserting into auth.users fires the real handle_new_user() trigger
# (0001_init.sql), which auto-creates the tenants row — never insert into
# tenants directly here, that would conflict with the trigger's own insert.
USER_A=$(psql_t "insert into auth.users (email) values ('a@example.test') returning id;")
USER_B=$(psql_t "insert into auth.users (email) values ('b@example.test') returning id;")
TENANT_A=$(psql_t "select id from tenants where user_id = '$USER_A';")
TENANT_B=$(psql_t "select id from tenants where user_id = '$USER_B';")

echo ""
echo "== RED-phase checks: both confirmed defects, against the ORIGINAL function =="
LEAD_RED=$(psql_t "insert into leads (tenant_id, customer_name, phone, channel, problem, diagnosis, confidence) values ('$TENANT_A','Riley','+15551110001','WhatsApp','Kitchen faucet','Standard replacement','High') returning id;")
psql_run "insert into lead_line_items (lead_id, description, qty, unit, rate, sort_order) values ('$LEAD_RED','Kitchen faucet replacement',1,'job',120,0);"
psql_run "select update_lead_with_line_items('$LEAD_RED','$TENANT_A','Riley','+15551110001','Corroded valves','High','[]'::jsonb,'new',null,null,'[{\"description\":\"Kitchen faucet replacement — Corroded valves\",\"qty\":1,\"unit\":\"job\",\"rate\":185}]'::jsonb);"
COUNT_RED=$(psql_t "select count(*) from lead_line_items where lead_id='$LEAD_RED';")
check_not_equal "defect 1 (duplication) reproduced: line item count is NOT 1 against the original function" "$COUNT_RED" "1"
echo "    (actual count: $COUNT_RED — expected 2 if the bug reproduces as predicted)"

LEAD_FLAG_RED=$(psql_t "insert into leads (tenant_id, customer_name, phone, channel, problem, diagnosis, confidence, status, flag_type, flag_reason) values ('$TENANT_A','Sam','+15551110002','WhatsApp','Deck repair','Needs in-person look','Low','flagged','pending_negotiated_price','Deferred pricing') returning id;")
# p_status = NULL here, matching the REAL pre-fix TypeScript caller
# (performFinalizeLeadWithQuote's old flagFields "nothing special" branch
# passed status: null) — this is the actual call shape that reproduces the
# bug; passing a non-null status would (correctly) already clear the flag
# even on the original function, since its own `p_status is not null`
# check only ever gated on null-ness, not any specific value.
psql_run "select update_lead_with_line_items('$LEAD_FLAG_RED','$TENANT_A','Sam','+15551110002','Deck repair confirmed','High','[]'::jsonb,null,null,null,'[{\"description\":\"Deck repair\",\"qty\":1,\"unit\":\"job\",\"rate\":300}]'::jsonb);"
FLAG_RED=$(psql_t "select coalesce(flag_type, 'NULL') from leads where id='$LEAD_FLAG_RED';")
check_not_equal "defect 2 (stale flag) reproduced: flag_type is NOT cleared against the original function" "$FLAG_RED" "NULL"
echo "    (actual flag_type: $FLAG_RED — expected pending_negotiated_price if the bug reproduces as predicted)"

echo ""
echo "== Applying the fix: $FIX_MIGRATION =="
if "${PSQL[@]}" -f "$MIGRATIONS_DIR/$FIX_MIGRATION" >/dev/null 2>"$WORKDIR/last-error.log"; then
  check "fix migration applied" "ok" "ok"
else
  echo "  FAILED applying $FIX_MIGRATION:"; cat "$WORKDIR/last-error.log"; exit 1
fi

echo ""
echo "== GREEN: re-running the SAME two kinds of reassessment against the FIXED function (fresh rows, same scenario) =="
LEAD_GREEN=$(psql_t "insert into leads (tenant_id, customer_name, phone, channel, problem, diagnosis, confidence) values ('$TENANT_A','Riley','+15551110003','WhatsApp','Kitchen faucet','Standard replacement','High') returning id;")
psql_run "insert into lead_line_items (lead_id, description, qty, unit, rate, sort_order) values ('$LEAD_GREEN','Kitchen faucet replacement',1,'job',120,0);"
psql_run "select update_lead_with_line_items('$LEAD_GREEN','$TENANT_A','Riley','+15551110003','Corroded valves','High','[]'::jsonb,'new',null,null,'[{\"description\":\"Kitchen faucet replacement — Corroded valves\",\"qty\":1,\"unit\":\"job\",\"rate\":185}]'::jsonb);"
check "defect 1 FIXED: exactly 1 line item after reassessment" "$(psql_t "select count(*) from lead_line_items where lead_id='$LEAD_GREEN';")" "1"
check "defect 1 FIXED: the surviving line item is the NEW one, not the stale old one" "$(psql_t "select rate::int from lead_line_items where lead_id='$LEAD_GREEN';")" "185"

LEAD_FLAG_GREEN=$(psql_t "insert into leads (tenant_id, customer_name, phone, channel, problem, diagnosis, confidence, status, flag_type, flag_reason) values ('$TENANT_A','Sam','+15551110004','WhatsApp','Deck repair','Needs in-person look','Low','flagged','pending_negotiated_price','Deferred pricing') returning id;")
psql_run "select update_lead_with_line_items('$LEAD_FLAG_GREEN','$TENANT_A','Sam','+15551110004','Deck repair confirmed','High','[]'::jsonb,'new',null,null,'[{\"description\":\"Deck repair\",\"qty\":1,\"unit\":\"job\",\"rate\":300}]'::jsonb);"
check "defect 2 FIXED: flag_type genuinely cleared (NULL) after a fully-priced reassessment" "$(psql_t "select coalesce(flag_type,'NULL') from leads where id='$LEAD_FLAG_GREEN';")" "NULL"
check "defect 2 FIXED: status transitions to 'new' (matches create_lead_with_line_items' own default)" "$(psql_t "select status from leads where id='$LEAD_FLAG_GREEN';")" "new"

echo ""
echo "== Deployment-ordering hazard: STILL-LIVE OLD application code (p_status = NULL) against the FIXED function =="
# Reproduces the exact scenario a dedicated adversarial review of this
# migration found: if 0028 is applied to production before the
# corresponding performFinalizeLeadWithQuote change deploys, the still-live
# OLD code keeps passing p_status = NULL for the normal, non-flagged case.
# leads.status is NOT NULL, so a bare `status = p_status` would throw here
# — this is exactly what the coalesce(p_status, 'new') fix exists to
# prevent. Uses a FRESH, non-flagged lead (flag_type IS NULL), the real
# shape the old code's call always had.
LEAD_OLDCODE=$(psql_t "insert into leads (tenant_id, customer_name, phone, channel, problem, diagnosis, confidence) values ('$TENANT_A','Casey','+15551110011','WhatsApp','Doorbell repair','Standard','High') returning id;")
psql_run "insert into lead_line_items (lead_id, description, qty, unit, rate, sort_order) values ('$LEAD_OLDCODE','Doorbell repair',1,'job',75,0);"
check_true "old-code call (p_status=NULL) against the fixed function succeeds (no not-null-constraint error)" \
  psql_run_may_fail "select update_lead_with_line_items('$LEAD_OLDCODE','$TENANT_A','Casey','+15551110011','Confirmed doorbell repair','High','[]'::jsonb,null,null,null,'[{\"description\":\"Doorbell repair\",\"qty\":1,\"unit\":\"job\",\"rate\":85}]'::jsonb);"
check "old-code call resolves status to 'new' via the coalesce, never NULL" "$(psql_t "select status from leads where id='$LEAD_OLDCODE';")" "new"
check "old-code call's line items are written correctly: exactly 1 item" "$(psql_t "select count(*) from lead_line_items where lead_id='$LEAD_OLDCODE';")" "1"
check "old-code call's line items are written correctly: the NEW item, not the stale old one" "$(psql_t "select description || ':' || rate::int from lead_line_items where lead_id='$LEAD_OLDCODE';")" "Doorbell repair:85"

echo ""
echo "== Scenario 1: initial quote creation, no existing line items (unaffected by the fix) =="
LEAD_FRESH=$(psql_t "select create_lead_with_line_items('$TENANT_A','Jess','+15551110005','','WhatsApp','', 'Sink repair','Standard','High','[]'::jsonb,null,null,null,'[{\"description\":\"Sink repair\",\"qty\":1,\"unit\":\"job\",\"rate\":90}]'::jsonb);")
check "fresh lead has exactly 1 line item" "$(psql_t "select count(*) from lead_line_items where lead_id='$LEAD_FRESH';")" "1"
check "fresh lead's line item is \$90" "$(psql_t "select rate::int from lead_line_items where lead_id='$LEAD_FRESH';")" "90"

echo ""
echo "== Scenario 3: reassessment that adds, removes, AND reprices items in one call =="
LEAD_MULTI=$(psql_t "insert into leads (tenant_id, customer_name, phone, channel, problem, diagnosis, confidence) values ('$TENANT_A','Morgan','+15551110006','WhatsApp','Multi job','Original','High') returning id;")
psql_run "insert into lead_line_items (lead_id, description, qty, unit, rate, sort_order) values ('$LEAD_MULTI','Item A (will be removed)',1,'job',50,0), ('$LEAD_MULTI','Item B (will be repriced)',1,'job',100,1);"
psql_run "select update_lead_with_line_items('$LEAD_MULTI','$TENANT_A','Morgan','+15551110006','Updated','High','[]'::jsonb,'new',null,null,'[{\"description\":\"Item B (will be repriced)\",\"qty\":1,\"unit\":\"job\",\"rate\":140},{\"description\":\"Item C (newly added)\",\"qty\":1,\"unit\":\"job\",\"rate\":60}]'::jsonb);"
check "composition change: exactly the 2 new items persist (removed item gone, repriced item updated, new item added)" \
  "$(psql_t "select string_agg(description || ':' || rate::int, ',' order by sort_order) from lead_line_items where lead_id='$LEAD_MULTI';")" \
  "Item B (will be repriced):140,Item C (newly added):60"

echo ""
echo "== Scenario 5: unrelated operational flags must survive a pricing reassessment =="
for flag in needs_human_review loop_suspected outside_service_scope conflicting_information; do
  LEAD_OPFLAG=$(psql_t "insert into leads (tenant_id, customer_name, phone, channel, problem, diagnosis, confidence, status, flag_type, flag_reason) values ('$TENANT_A','Flag Test','+15551110900','WhatsApp','Something','Diagnosis','High','flagged','$flag','Unrelated operational reason') returning id;")
  psql_run "select update_lead_with_line_items('$LEAD_OPFLAG','$TENANT_A','Flag Test','+15551110900','Reassessed','High','[]'::jsonb,'new',null,null,'[{\"description\":\"Something\",\"qty\":1,\"unit\":\"job\",\"rate\":100}]'::jsonb);"
  check "unrelated flag '$flag' is preserved, never clobbered by a pricing reassessment" "$(psql_t "select flag_type from leads where id='$LEAD_OPFLAG';")" "$flag"
  check "status also preserved alongside the unrelated flag '$flag'" "$(psql_t "select status from leads where id='$LEAD_OPFLAG';")" "flagged"
  check "line items STILL update even though the flag is protected (pricing and flag-state are independent)" "$(psql_t "select count(*) from lead_line_items where lead_id='$LEAD_OPFLAG';")" "1"
done

echo ""
echo "== Scenario 4 (continued): a legitimate pricing-flag TRANSITION still works (pending_negotiated_price -> partially_priced) =="
LEAD_TRANSITION=$(psql_t "insert into leads (tenant_id, customer_name, phone, channel, problem, diagnosis, confidence, status, flag_type, flag_reason) values ('$TENANT_A','Transition Test','+15551110901','WhatsApp','Something','Diagnosis','High','flagged','pending_negotiated_price','Deferred') returning id;")
psql_run "select update_lead_with_line_items('$LEAD_TRANSITION','$TENANT_A','Transition Test','+15551110901','Partially priced now','High','[]'::jsonb,'flagged','partially_priced','Some work still deferred','[{\"description\":\"Priced part\",\"qty\":1,\"unit\":\"job\",\"rate\":75}]'::jsonb);"
check "pricing flag correctly transitions between the two pricing flags this function owns" "$(psql_t "select flag_type from leads where id='$LEAD_TRANSITION';")" "partially_priced"

echo ""
echo "== Scenario 6: forced mid-transaction failure must roll back completely =="
LEAD_ROLLBACK=$(psql_t "insert into leads (tenant_id, customer_name, phone, channel, problem, diagnosis, confidence) values ('$TENANT_A','Alex','+15551110007','WhatsApp','Sink repair','Standard','High') returning id;")
psql_run "insert into lead_line_items (lead_id, description, qty, unit, rate, sort_order) values ('$LEAD_ROLLBACK','Sink repair',1,'job',90,0);"
check_false "the deliberately-malformed call actually errors (qty not castable to numeric)" psql_run_may_fail "select update_lead_with_line_items('$LEAD_ROLLBACK','$TENANT_A','Alex','+15551110007','SHOULD NOT PERSIST','High','[]'::jsonb,'new',null,null,'[{\"description\":\"bad item\",\"qty\":\"not-a-number\",\"unit\":\"job\",\"rate\":50}]'::jsonb);"
check "diagnosis is unchanged after the failed call (still 'Standard', not 'SHOULD NOT PERSIST')" "$(psql_t "select diagnosis from leads where id='$LEAD_ROLLBACK';")" "Standard"
check "line items unchanged after the failed call (still exactly 1, the original)" "$(psql_t "select count(*) from lead_line_items where lead_id='$LEAD_ROLLBACK';")" "1"

echo ""
echo "== Scenario 7: wrong-tenant attempts must not change another tenant's data =="
LEAD_TENANT_B=$(psql_t "insert into leads (tenant_id, customer_name, phone, channel, problem, diagnosis, confidence) values ('$TENANT_B','Jordan','+15551110008','WhatsApp','Different tenant job','Original','High') returning id;")
psql_run "insert into lead_line_items (lead_id, description, qty, unit, rate, sort_order) values ('$LEAD_TENANT_B','Tenant B original item',1,'job',50,0);"
RESULT=$(psql_t "select coalesce(update_lead_with_line_items('$LEAD_TENANT_B','$TENANT_A','HACKED','+10000000000','SHOULD NOT APPLY','High','[]'::jsonb,'new',null,null,'[{\"description\":\"malicious item\",\"qty\":1,\"unit\":\"job\",\"rate\":9999}]'::jsonb)::text, 'NULL');")
check "wrong-tenant call returns NULL (zero rows matched)" "$RESULT" "NULL"
check "tenant B's lead diagnosis is untouched" "$(psql_t "select diagnosis from leads where id='$LEAD_TENANT_B';")" "Original"
check "tenant B's line item is untouched (still the original, not the malicious one)" "$(psql_t "select description from lead_line_items where lead_id='$LEAD_TENANT_B';")" "Tenant B original item"

echo ""
echo "== Scenario 8: concurrent reassessment via two SEPARATE real psql connections must serialize =="
LEAD_CONCURRENT=$(psql_t "insert into leads (tenant_id, customer_name, phone, channel, problem, diagnosis, confidence) values ('$TENANT_A','Concurrent Test','+15551110009','WhatsApp','Something','Diagnosis','High') returning id;")
psql_run "insert into lead_line_items (lead_id, description, qty, unit, rate, sort_order) values ('$LEAD_CONCURRENT','Original item',1,'job',100,0);"
psql_run "select update_lead_with_line_items('$LEAD_CONCURRENT','$TENANT_A','Concurrent Test','+15551110009','From connection A','High','[]'::jsonb,'new',null,null,'[{\"description\":\"From connection A\",\"qty\":1,\"unit\":\"job\",\"rate\":111}]'::jsonb);" &
PID_A=$!
psql_run "select update_lead_with_line_items('$LEAD_CONCURRENT','$TENANT_A','Concurrent Test','+15551110009','From connection B','High','[]'::jsonb,'new',null,null,'[{\"description\":\"From connection B\",\"qty\":1,\"unit\":\"job\",\"rate\":222}]'::jsonb);" &
PID_B=$!
wait "$PID_A" "$PID_B"
check "after two genuinely concurrent reassessments, exactly 1 line item survives (never both, never zero)" "$(psql_t "select count(*) from lead_line_items where lead_id='$LEAD_CONCURRENT';")" "1"
SURVIVOR=$(psql_t "select description || ':' || rate::int from lead_line_items where lead_id='$LEAD_CONCURRENT';")
if [ "$SURVIVOR" = "From connection A:111" ] || [ "$SURVIVOR" = "From connection B:222" ]; then
  echo "  PASS: the surviving line item is whichever connection committed last — a fully consistent single row, not a mix (survivor: $SURVIVOR)"; PASS=$((PASS + 1))
else
  echo "  FAIL: survivor was '$SURVIVOR', expected one of the two whole rows, not a mix"; FAIL=$((FAIL + 1))
fi

echo ""
echo "== Scenario 9: existing callers' exact call shape still works unchanged (QuoteFlow / clarification-finalize) =="
LEAD_EXISTING_CALLER=$(psql_t "select create_lead_with_line_items('$TENANT_A','Pat','+15551110010','','WhatsApp','', 'Doorknob','Standard','High','[]'::jsonb,null,null,null,'[]'::jsonb);")
psql_run "select update_lead_with_line_items('$LEAD_EXISTING_CALLER','$TENANT_A','Pat','+15551110010','Loose doorknob','High','[]'::jsonb,'new',null,null,'[{\"description\":\"Doorknob repair\",\"qty\":1,\"unit\":\"job\",\"rate\":60}]'::jsonb);"
check "existing-caller-shape finalize: status is 'new'" "$(psql_t "select status from leads where id='$LEAD_EXISTING_CALLER';")" "new"
check "existing-caller-shape finalize: flag_type is NULL" "$(psql_t "select coalesce(flag_type,'NULL') from leads where id='$LEAD_EXISTING_CALLER';")" "NULL"
check "existing-caller-shape finalize: exactly 1 line item" "$(psql_t "select count(*) from lead_line_items where lead_id='$LEAD_EXISTING_CALLER';")" "1"

echo ""
echo "=================================================="
echo "RESULTS: $PASS passed, $FAIL failed"
echo "=================================================="
if [ "$FAIL" -gt 0 ]; then exit 1; fi
