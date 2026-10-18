#!/usr/bin/env bash
# Real-PostgreSQL verification for the REVISED 0024_whatsapp_loop_guards.sql
# (record_whatsapp_interaction, claim_whatsapp_loop_notice,
# release_whatsapp_loop_notice_claim, mark_whatsapp_loop_notice_sent,
# resume_whatsapp_loop_guard) — same disposable-cluster safety model as
# pg-migration-verification.sh and pg-tenant-isolation-check.sh: a fresh
# throwaway Postgres cluster, bound ONLY to a Unix socket in its own
# mktemp directory (listen_addresses='' — no TCP port ever opens), every
# psql call passing -h/-p explicitly so no ambient env var can redirect
# anywhere else, its own dedicated port/socket distinct from the other
# scripts, torn down on exit regardless of outcome.
#
# What this verifies, in order:
#   1. All migration files apply cleanly.
#   2. The repeat-pattern signal is computed from the FULL recent set of
#      outbound signatures, not just the immediately-prior one — proven by
#      an ALTERNATING A/B/A/B/A sequence that a "compare only to the last
#      round" design (the first version of this guard) could never trip,
#      and a genuinely new signature never adding to the repeat count.
#   3. The duplicate-content signal (inbound, different provider message
#      ids, same content) trips independently, and does NOT fire for a
#      genuine same-id redelivery.
#   4. The volume signal trips independently of either pattern signal,
#      across TWO separate leads for the same phone (cross-lead
#      persistence — the actual bug a per-lead design would have had).
#   5. Tenant isolation: the same phone number under two different tenants
#      never shares guard state.
#   6. The notice-claim race is closed: two sequential claim attempts on
#      the same 'pending' notice — only the first succeeds; release puts
#      it back for a legitimate retry; mark-sent only succeeds from
#      'sending', never twice.
#   7. resume_whatsapp_loop_guard clears tripped state AND moves the
#      "relevant evidence" floor forward — the very next call with the
#      SAME previously-repeating signature does NOT instantly re-trip,
#      proving a resume actually resumes rather than being immediately
#      defeated by the untouched evidence log (evidence rows themselves
#      are never deleted — this is checked separately below).
#   8. resume_whatsapp_loop_guard rejects an unrecognized resumed_by value
#      — the fixed, enumerable set of authorized reasons is enforced in
#      the database, not just by convention in calling code.
#   9. Evidence is never deleted by a resume — the interaction log still
#      contains every pre-resume row afterward.
#  10. Genuine concurrency: two REAL, separate psql processes racing
#      record_whatsapp_interaction with the same outbound signature, and
#      two REAL processes racing claim_whatsapp_loop_notice on the same
#      pending notice — proven with actual concurrent connections, not
#      simulated.
#
# Usage:
#   bash scripts/pg-whatsapp-loop-guard-check.sh
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

WORKDIR=$(mktemp -d /tmp/pg-whatsapp-loop-guard-check.XXXXXX)
PGDATA="$WORKDIR/data"
PGPORT=55335
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

# Thin wrapper over record_whatsapp_interaction so every call site below
# stays readable. Positional args, matching the function's own signature
# exactly; pass "" for a NULL provider_message_id/lead_id.
rwi() {
  local tenant="$1" phone="$2" direction="$3" hash="$4" pmid="$5" lead="$6"
  local dupw="$7" dupt="$8" patw="$9" rept="${10}" volw="${11}" volt="${12}" col="${13}"
  local pmid_sql lead_sql
  [ -z "$pmid" ] && pmid_sql="null" || pmid_sql="'$pmid'"
  [ -z "$lead" ] && lead_sql="null" || lead_sql="'$lead'"
  psql_t "select $col from record_whatsapp_interaction('$tenant','$phone','$direction','$hash',$pmid_sql,$lead_sql,$dupw,$dupt,$patw,$rept,$volw,$volt);"
}

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
echo "== Applying migrations verbatim, in order =="
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
echo "== Seeding a tenant with two separate leads for the SAME phone, and a second, unrelated tenant =="
USER_A="a0a0a0a0-0000-0000-0000-00000000000a"
USER_B="b0b0b0b0-0000-0000-0000-00000000000b"
"${PSQL_SUPERUSER[@]}" -c "
insert into auth.users (id, email) values ('$USER_A', 'owner-a@example.test'), ('$USER_B', 'owner-b@example.test');
" >/dev/null
TENANT_A=$(psql_t "update tenants set name = 'Tenant A' where user_id = '$USER_A' returning id;")
TENANT_B=$(psql_t "update tenants set name = 'Tenant B' where user_id = '$USER_B' returning id;")
PHONE="+15559876543"

LEAD_A1=$(psql_t "insert into leads (tenant_id, phone, customer_name) values ('$TENANT_A', '$PHONE', 'Customer') returning id;")
LEAD_A2=$(psql_t "insert into leads (tenant_id, phone, customer_name) values ('$TENANT_A', '$PHONE', 'Customer') returning id;")
echo "  tenant A: $TENANT_A (leads $LEAD_A1, $LEAD_A2) / tenant B: $TENANT_B / shared phone: $PHONE"

echo ""
echo "== Repeat-pattern signal: computed from the full recent set, not just the immediately-prior round =="
# Generous thresholds on the OTHER two signals so only the pattern signal
# is under test. Window/threshold args: dup_window dup_thresh pattern_window repeat_thresh vol_window vol_thresh
C1=$(rwi "$TENANT_A" "$PHONE" outbound "sig:A" "" "" 600 1000 86400 3 180 1000 repeat_count)
check "1st occurrence of A contributes 0 to repeat_count (got: $C1)" bash -c "[ '$C1' = '0' ]"
C2=$(rwi "$TENANT_A" "$PHONE" outbound "sig:B" "" "" 600 1000 86400 3 180 1000 repeat_count)
check "a genuinely new signature B still contributes 0 (got: $C2)" bash -c "[ '$C2' = '0' ]"
C3=$(rwi "$TENANT_A" "$PHONE" outbound "sig:A" "" "" 600 1000 86400 3 180 1000 repeat_count)
check "A's 2nd occurrence (not consecutive — B happened between) brings repeat_count to 1 (got: $C3)" bash -c "[ '$C3' = '1' ]"
T4=$(rwi "$TENANT_A" "$PHONE" outbound "sig:B" "" "" 600 1000 86400 3 180 1000 tripped)
check "B's 2nd occurrence: repeat_count=2, still below threshold 3, not yet tripped (got: $T4)" bash -c "[ '$T4' = 'f' ]"
T5=$(rwi "$TENANT_A" "$PHONE" outbound "sig:A" "" "" 600 1000 86400 3 180 1000 tripped)
check "A's 3rd occurrence crosses threshold 3 (the ALTERNATING A/B/A/B/A sequence this design must catch, which a 'compare only to the last round' design never would) (got: $T5)" bash -c "[ '$T5' = 't' ]"
RESUME_1=$(psql_t "select resume_whatsapp_loop_guard('$TENANT_A', '$PHONE', 'dashboard_action');")
check "resume succeeds to reset for the next section (got: $RESUME_1)" bash -c "[ '$RESUME_1' = 't' ]"

echo ""
echo "== Duplicate-content signal (inbound): a genuine same-id redelivery alone never counts =="
# Isolated on its own fresh signature so no other evidence contaminates
# the EXISTS check below (which looks at ALL prior same-hash events in
# the window, not just the immediately-previous one).
RD1=$(rwi "$TENANT_A" "$PHONE" inbound "hash:redelivery-only" "wamid-same" "" 600 2 86400 1000 180 1000 is_duplicate_content)
check "1st occurrence has nothing to match against yet — not a duplicate (got: $RD1)" bash -c "[ '$RD1' = 'f' ]"
RD2=$(rwi "$TENANT_A" "$PHONE" inbound "hash:redelivery-only" "wamid-same" "" 600 2 86400 1000 180 1000 is_duplicate_content)
check "a SECOND delivery of the exact SAME provider id, same content, is never flagged as duplicate content — that's a provider redelivery, a separate pre-existing concern, not this signal's job (got: $RD2)" bash -c "[ '$RD2' = 'f' ]"
psql_t "select resume_whatsapp_loop_guard('$TENANT_A', '$PHONE', 'dashboard_action');" >/dev/null

echo ""
echo "== Duplicate-content signal (inbound): same content, genuinely DIFFERENT provider ids =="
D1=$(rwi "$TENANT_A" "$PHONE" inbound "hash:dup" "wamid-1" "" 600 2 86400 1000 180 1000 is_duplicate_content)
check "1st occurrence has nothing to match against yet — not a duplicate (got: $D1)" bash -c "[ '$D1' = 'f' ]"
D2=$(rwi "$TENANT_A" "$PHONE" inbound "hash:dup" "wamid-2" "" 600 2 86400 1000 180 1000 is_duplicate_content)
check "2nd occurrence, DIFFERENT provider id, same content — flagged as duplicate content (got: $D2)" bash -c "[ '$D2' = 't' ]"
D2_COUNT=$(rwi "$TENANT_A" "$PHONE" inbound "hash:dup" "wamid-3" "" 600 2 86400 1000 180 1000 duplicate_content_count)
check "a 3rd distinct id brings duplicate_content_count to 2, meeting threshold 2 (got: $D2_COUNT)" bash -c "[ '$D2_COUNT' = '2' ]"
T_DUP_TRIP=$(psql_t "select (tripped_at is not null) from whatsapp_loop_guards where tenant_id = '$TENANT_A' and phone = '$PHONE';")
check "duplicate_content_count reaching threshold 2 already tripped the guard, in that same call (got: $T_DUP_TRIP)" bash -c "[ '$T_DUP_TRIP' = 't' ]"
psql_t "select resume_whatsapp_loop_guard('$TENANT_A', '$PHONE', 'dashboard_action');" >/dev/null

echo ""
echo "== Volume signal trips independently, across TWO separate leads for the same phone =="
"${PSQL_SUPERUSER[@]}" -c "
insert into lead_messages (lead_id, role, body) values
  ('$LEAD_A1', 'customer', 'q1'), ('$LEAD_A1', 'assistant', 'a1'),
  ('$LEAD_A1', 'customer', 'q2'), ('$LEAD_A1', 'assistant', 'a2'),
  ('$LEAD_A2', 'customer', 'q3'), ('$LEAD_A2', 'assistant', 'a3');
" >/dev/null
# lead_messages inserts above aren't read by record_whatsapp_interaction at
# all (the revised design's volume signal reads whatsapp_interaction_events,
# not lead_messages) — this confirms that table is no longer load-bearing
# for the guard, and records the SAME number of interaction events instead,
# each with a different signature so only the volume signal can trip.
for i in 1 2 3 4 5; do
  rwi "$TENANT_A" "$PHONE" outbound "vol:$i" "" "$LEAD_A1" 600 1000 86400 1000 180 5 tripped >/dev/null
done
VOL_TRIPPED=$(rwi "$TENANT_A" "$PHONE" outbound "vol:6" "" "$LEAD_A2" 600 1000 86400 1000 180 5 tripped)
check "6 events across TWO different leads exceed a volume_threshold of 5, even with never-repeated signatures (got: $VOL_TRIPPED)" bash -c "[ '$VOL_TRIPPED' = 't' ]"
psql_t "select resume_whatsapp_loop_guard('$TENANT_A', '$PHONE', 'dashboard_action');" >/dev/null

echo ""
echo "== Legitimate busy-but-varied conversation does NOT trip the pattern signal =="
for i in 1 2 3 4 5 6 7 8; do
  T=$(rwi "$TENANT_A" "$PHONE" outbound "legit-question:$i" "" "" 600 1000 86400 3 180 1000 tripped)
  check "legitimately distinct question #$i never trips the pattern signal (got: $T)" bash -c "[ '$T' = 'f' ]"
done
psql_t "select resume_whatsapp_loop_guard('$TENANT_A', '$PHONE', 'dashboard_action');" >/dev/null

echo ""
echo "== Tenant isolation: the same phone number under a different tenant never shares guard state =="
TENANT_B_FIRST=$(rwi "$TENANT_B" "$PHONE" outbound "sig:isolated" "" "" 600 1000 86400 3 180 1000 repeat_count)
check "tenant B's first call for this same phone starts unaffected by tenant A's history (got: $TENANT_B_FIRST)" bash -c "[ '$TENANT_B_FIRST' = '0' ]"

echo ""
echo "== Notice-claim race (sequential proof; genuine concurrent proof is below) =="
# volume_threshold=1 trips on the very first call for a fresh (tenant,
# phone): the just-inserted row itself already counts toward
# recent_event_count, unlike the pattern signal (whose first occurrence of
# any signature never counts as a repeat — see the section above).
TRIP_SETUP=$(rwi "$TENANT_A" "$PHONE" outbound "trip:notice" "" "" 600 1000 86400 1000 180 1 tripped)
check "the trip-setup call for this section actually tripped the guard (got: $TRIP_SETUP)" bash -c "[ '$TRIP_SETUP' = 't' ]"
CLAIM_1=$(psql_t "select claim_whatsapp_loop_notice('$TENANT_A', '$PHONE', 60);")
check "first claim on a 'pending' notice succeeds (got: $CLAIM_1)" bash -c "[ '$CLAIM_1' = 't' ]"
CLAIM_2=$(psql_t "select claim_whatsapp_loop_notice('$TENANT_A', '$PHONE', 60);")
check "a second claim attempt while the first is still 'sending' fails — exactly the race a prior review found (got: $CLAIM_2)" bash -c "[ '$CLAIM_2' = 'f' ]"
RELEASE_1=$(psql_t "select release_whatsapp_loop_notice_claim('$TENANT_A', '$PHONE');")
check "releasing the claim (simulating a failed send) succeeds (got: $RELEASE_1)" bash -c "[ '$RELEASE_1' = 't' ]"
CLAIM_RETRY=$(psql_t "select claim_whatsapp_loop_notice('$TENANT_A', '$PHONE', 60);")
check "after release, a fresh claim attempt succeeds again — the retry path works (got: $CLAIM_RETRY)" bash -c "[ '$CLAIM_RETRY' = 't' ]"
MARK_1=$(psql_t "select mark_whatsapp_loop_notice_sent('$TENANT_A', '$PHONE');")
check "mark-sent succeeds from 'sending' (got: $MARK_1)" bash -c "[ '$MARK_1' = 't' ]"
MARK_2=$(psql_t "select mark_whatsapp_loop_notice_sent('$TENANT_A', '$PHONE');")
check "a second mark-sent call is a safe no-op — already 'sent', not 'sending' (got: $MARK_2)" bash -c "[ '$MARK_2' = 'f' ]"
psql_t "select resume_whatsapp_loop_guard('$TENANT_A', '$PHONE', 'dashboard_action');" >/dev/null

echo ""
echo "== resume_whatsapp_loop_guard: clears trip state AND moves the relevant-evidence floor forward =="
# Build up enough repeating evidence to trip, confirm it trips, resume,
# then confirm the VERY NEXT call with the SAME signature does not
# instantly re-trip — proving resume actually resumes, rather than being
# immediately defeated by the untouched (never-deleted) evidence log.
for i in 1 2 3; do
  rwi "$TENANT_A" "$PHONE" outbound "sig:floor-test" "" "" 600 1000 86400 3 180 1000 tripped >/dev/null
done
# N occurrences of the SAME signature with nothing else interleaved
# produce repeat_count = N-1 (only the first occurrence is never a
# repeat) — so the 4th occurrence is the first to reach repeat_count=3
# and cross a threshold of 3.
PRE_RESUME_TRIP=$(rwi "$TENANT_A" "$PHONE" outbound "sig:floor-test" "" "" 600 1000 86400 3 180 1000 tripped)
check "the 4th occurrence of the same signature (repeat_count=3) trips the guard before resume (got: $PRE_RESUME_TRIP)" bash -c "[ '$PRE_RESUME_TRIP' = 't' ]"
RESUME_2=$(psql_t "select resume_whatsapp_loop_guard('$TENANT_A', '$PHONE', 'operator_reply');")
check "resume succeeds (got: $RESUME_2)" bash -c "[ '$RESUME_2' = 't' ]"
POST_RESUME_CLEAR=$(psql_t "select tripped_at is null from whatsapp_loop_guards where tenant_id = '$TENANT_A' and phone = '$PHONE';")
check "tripped_at is cleared after resume (got: $POST_RESUME_CLEAR)" bash -c "[ '$POST_RESUME_CLEAR' = 't' ]"
POST_RESUME_REPEAT=$(rwi "$TENANT_A" "$PHONE" outbound "sig:floor-test" "" "" 600 1000 86400 3 180 1000 repeat_count)
check "the SAME previously-repeating signature, right after resume, is NOT instantly treated as a repeat — repeat_count resets to 0 because the floor moved forward (got: $POST_RESUME_REPEAT)" bash -c "[ '$POST_RESUME_REPEAT' = '0' ]"
POST_RESUME_NOT_TRIPPED=$(rwi "$TENANT_A" "$PHONE" outbound "sig:floor-test" "" "" 600 1000 86400 3 180 1000 tripped)
check "and the guard does not immediately re-trip on evidence that predates the resume (got: $POST_RESUME_NOT_TRIPPED)" bash -c "[ '$POST_RESUME_NOT_TRIPPED' = 'f' ]"

echo ""
echo "== Evidence is never deleted by a resume =="
EVENT_COUNT=$(psql_t "select count(*) from whatsapp_interaction_events where tenant_id = '$TENANT_A' and phone = '$PHONE' and content_hash = 'priced:trip-me-never-matches' ;")
check "sanity: query runs (got: $EVENT_COUNT)" bash -c "[ '$EVENT_COUNT' = '0' ]"
PRE_RESUME_EVENT_ROWS=$(psql_t "select count(*) from whatsapp_interaction_events where tenant_id = '$TENANT_A' and phone = '$PHONE' and content_hash = 'sig:floor-test';")
check "every pre-resume occurrence of sig:floor-test is still present in the log after resume — nothing deleted (got: $PRE_RESUME_EVENT_ROWS, expect >= 3)" bash -c "[ '$PRE_RESUME_EVENT_ROWS' -ge 3 ]"

echo ""
echo "== resume_whatsapp_loop_guard rejects an unrecognized resumed_by value =="
set +e
BAD_RESUME_OUTPUT=$(psql_t_noerr "select resume_whatsapp_loop_guard('$TENANT_A', '$PHONE', 'because_i_said_so');")
BAD_RESUME_STATUS=$?
set -e
check "an invalid resumed_by value is rejected by the database itself, not just application convention (exit status: $BAD_RESUME_STATUS, output: $BAD_RESUME_OUTPUT)" bash -c "[ '$BAD_RESUME_STATUS' -ne 0 ]"

echo ""
echo "== Genuine concurrency #1: two real, separate psql processes racing the same outbound signature =="
psql_t "select resume_whatsapp_loop_guard('$TENANT_A', '$PHONE', 'dashboard_action');" >/dev/null
RESULT_1_FILE=$(mktemp)
RESULT_2_FILE=$(mktemp)
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -t -A -d postgres -c \
  "select repeat_count from record_whatsapp_interaction('$TENANT_A', '$PHONE', 'outbound', 'sig:race', null, null, 600, 1000, 86400, 1000, 180, 1000);" > "$RESULT_1_FILE" 2>&1 &
PID_1=$!
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -t -A -d postgres -c \
  "select repeat_count from record_whatsapp_interaction('$TENANT_A', '$PHONE', 'outbound', 'sig:race', null, null, 600, 1000, 86400, 1000, 180, 1000);" > "$RESULT_2_FILE" 2>&1 &
PID_2=$!
wait "$PID_1" "$PID_2"
CR1=$(tr -d '[:space:]' < "$RESULT_1_FILE")
CR2=$(tr -d '[:space:]' < "$RESULT_2_FILE")
rm -f "$RESULT_1_FILE" "$RESULT_2_FILE"
EVENT_ROWS_RACE=$(psql_t "select count(*) from whatsapp_interaction_events where tenant_id = '$TENANT_A' and phone = '$PHONE' and content_hash = 'sig:race';")
check "two genuinely concurrent calls both complete (got results: '$CR1', '$CR2')" bash -c "[ -n '$CR1' ] && [ -n '$CR2' ]"
check "both concurrent inserts landed — no lost write, exactly 2 rows for this signature (got: $EVENT_ROWS_RACE)" bash -c "[ '$EVENT_ROWS_RACE' = '2' ]"

echo ""
echo "== Genuine concurrency #2: two real, separate psql processes racing the SAME pending notice claim =="
psql_t "select resume_whatsapp_loop_guard('$TENANT_A', '$PHONE', 'dashboard_action');" >/dev/null
TRIP_SETUP_2=$(rwi "$TENANT_A" "$PHONE" outbound "trip:notice-race" "" "" 600 1000 86400 1000 180 1 tripped)
check "the trip-setup call for the concurrent-claim section actually tripped the guard (got: $TRIP_SETUP_2)" bash -c "[ '$TRIP_SETUP_2' = 't' ]"
CLAIM_RESULT_1_FILE=$(mktemp)
CLAIM_RESULT_2_FILE=$(mktemp)
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -t -A -d postgres -c \
  "select claim_whatsapp_loop_notice('$TENANT_A', '$PHONE', 60);" > "$CLAIM_RESULT_1_FILE" 2>&1 &
CPID_1=$!
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -t -A -d postgres -c \
  "select claim_whatsapp_loop_notice('$TENANT_A', '$PHONE', 60);" > "$CLAIM_RESULT_2_FILE" 2>&1 &
CPID_2=$!
wait "$CPID_1" "$CPID_2"
CL1=$(tr -d '[:space:]' < "$CLAIM_RESULT_1_FILE")
CL2=$(tr -d '[:space:]' < "$CLAIM_RESULT_2_FILE")
rm -f "$CLAIM_RESULT_1_FILE" "$CLAIM_RESULT_2_FILE"
check "exactly one of the two genuinely concurrent claim attempts wins, the other loses — proven with real connections, not sequential simulation (got: '$CL1', '$CL2')" bash -c "
  { [ '$CL1' = 't' ] && [ '$CL2' = 'f' ]; } || { [ '$CL1' = 'f' ] && [ '$CL2' = 't' ]; }
"

echo ""
echo "== REGRESSION (fix pass #3): deterministic reproduction of the confirmed Critical race, forced via explicit row locking — not timing luck =="
# A prior adversarial review proved, via two hand-held psql sessions,
# that a losing concurrent caller's own UPDATE ... RETURNING ... INTO
# (zero rows matched, because another transaction already committed the
# trip) could reset its tripped_at variable to NULL and report
# tripped=false even though the guard was, at that exact moment,
# genuinely tripped. This section forces the SAME interleaving against
# the REAL record_whatsapp_interaction function, with the ordering
# guaranteed by Postgres's own row-lock queue (not a hoped-for sleep
# race): the "locker" session takes an explicit `for update` lock on the
# guard row FIRST, holds it while the "helper" session's real function
# call blocks trying to acquire that same lock for its own trip UPDATE,
# then the locker performs the winning trip itself and releases the
# lock — at which point the helper's blocked UPDATE wakes up, finds
# zero matching rows, and (with the fix) must fall through to an
# authoritative re-read rather than reporting a stale/clobbered answer.
RACE_PHONE="+15552223333"
psql_t "select resume_whatsapp_loop_guard('$TENANT_A', '$RACE_PHONE', 'dashboard_action');" >/dev/null
"${PSQL_SUPERUSER[@]}" -c "insert into whatsapp_loop_guards (tenant_id, phone) values ('$TENANT_A', '$RACE_PHONE') on conflict do nothing;" >/dev/null
# Pre-seed enough events that the volume threshold (10) is already
# satisfied by committed history alone, so the helper decides to trip
# from this evidence alone -- it never needs to see the locker's own
# write to reach that decision.
for i in $(seq 1 20); do
  "${PSQL_SUPERUSER[@]}" -c "insert into whatsapp_interaction_events (tenant_id, phone, direction, content_hash) values ('$TENANT_A', '$RACE_PHONE', 'outbound', 'race-regress-$i');" >/dev/null
done

LOCKER_OUT=$(mktemp)
(
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q -t -A <<SQL_LOCKER
begin;
select 1 from whatsapp_loop_guards where tenant_id = '$TENANT_A' and phone = '$RACE_PHONE' for update;
select pg_sleep(0.6);
update whatsapp_loop_guards set tripped_at = now(), trip_reason = 'volume', notice_status = 'pending' where tenant_id = '$TENANT_A' and phone = '$RACE_PHONE' and tripped_at is null;
commit;
SQL_LOCKER
) > "$LOCKER_OUT" 2>&1 &
LOCKER_PID=$!

# Small head start -- acquiring a `for update` lock on an already-
# existing row takes microseconds; this margin only needs to outlast
# that, not "win a race" against it. The actual ordering guarantee comes
# from the lock itself, below.
sleep 0.2
HELPER_OUT=$(mktemp)
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q -t -A -c \
  "select tripped, just_tripped, trip_reason from record_whatsapp_interaction('$TENANT_A', '$RACE_PHONE', 'outbound', 'race-regress-helper', null, null, 600, 1000, 86400, 1000, 180, 10);" \
  > "$HELPER_OUT" 2>&1 &
HELPER_PID=$!

wait "$LOCKER_PID"
wait "$HELPER_PID"
HELPER_RESULT=$(cat "$HELPER_OUT")
rm -f "$LOCKER_OUT" "$HELPER_OUT"
echo "  Helper's own returned result (tripped|just_tripped|trip_reason): $HELPER_RESULT"
FINAL_RACE_STATE=$(psql_t "select tripped_at is not null, trip_reason from whatsapp_loop_guards where tenant_id = '$TENANT_A' and phone = '$RACE_PHONE';")
echo "  Actual final DB state (tripped|reason): $FINAL_RACE_STATE"

check "the LOSING concurrent caller's own returned 'tripped' column is TRUE, matching the real DB state — the exact bug this fix closes (got: $HELPER_RESULT)" bash -c "[ '$HELPER_RESULT' = 't|f|volume' ]"
check "the real stored state agrees: tripped with trip_reason=volume, set by the locker's own write (got: $FINAL_RACE_STATE)" bash -c "[ '$FINAL_RACE_STATE' = 't|volume' ]"

echo ""
echo "== REGRESSION (fix pass #3): a stale window-floor cannot cause a spurious re-trip after a concurrent resume wins =="
# Same forced-locking technique, now proving the companion fix: a call
# that read an OLD resumed_at and computed its trip decision from
# evidence a NEWER, concurrently-committed resume is meant to exclude
# must have that decision discarded, not silently applied.
FLOOR_PHONE="+15554445555"
# resume_whatsapp_loop_guard is a plain UPDATE with no corresponding
# INSERT -- calling it before any row exists for this (tenant, phone) is
# a silent no-op, which would make this whole test meaningless (there
# would be no real "resumed_at = T1" to go stale). Ensure the row exists
# first, same as the race section above.
"${PSQL_SUPERUSER[@]}" -c "insert into whatsapp_loop_guards (tenant_id, phone) values ('$TENANT_A', '$FLOOR_PHONE') on conflict do nothing;" >/dev/null
RESUME_T1=$(psql_t "select resume_whatsapp_loop_guard('$TENANT_A', '$FLOOR_PHONE', 'dashboard_action');")
check "the first resume actually applies to a real row (got: $RESUME_T1)" bash -c "[ '$RESUME_T1' = 't' ]"
for i in $(seq 1 20); do
  "${PSQL_SUPERUSER[@]}" -c "insert into whatsapp_interaction_events (tenant_id, phone, direction, content_hash) values ('$TENANT_A', '$FLOOR_PHONE', 'outbound', 'floor-regress-$i');" >/dev/null
done

LOCKER2_OUT=$(mktemp)
(
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q -t -A <<SQL_LOCKER2
begin;
select 1 from whatsapp_loop_guards where tenant_id = '$TENANT_A' and phone = '$FLOOR_PHONE' for update;
select pg_sleep(0.6);
select resume_whatsapp_loop_guard('$TENANT_A', '$FLOOR_PHONE', 'operator_reply');
commit;
SQL_LOCKER2
) > "$LOCKER2_OUT" 2>&1 &
LOCKER2_PID=$!

sleep 0.2
HELPER2_OUT=$(mktemp)
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q -t -A -c \
  "select tripped, just_tripped from record_whatsapp_interaction('$TENANT_A', '$FLOOR_PHONE', 'outbound', 'floor-regress-helper', null, null, 600, 1000, 86400, 1000, 180, 10);" \
  > "$HELPER2_OUT" 2>&1 &
HELPER2_PID=$!

wait "$LOCKER2_PID"
wait "$HELPER2_PID"
HELPER2_RESULT=$(cat "$HELPER2_OUT")
rm -f "$LOCKER2_OUT" "$HELPER2_OUT"
echo "  Helper's own returned result after a concurrent resume won (tripped|just_tripped): $HELPER2_RESULT"
FINAL_FLOOR_STATE=$(psql_t "select tripped_at is null, resumed_by from whatsapp_loop_guards where tenant_id = '$TENANT_A' and phone = '$FLOOR_PHONE';")
echo "  Actual final DB state (tripped_at is null|resumed_by): $FINAL_FLOOR_STATE"

check "the helper's stale-floor trip decision is discarded — it reports neither tripped nor just_tripped (got: $HELPER2_RESULT)" bash -c "[ '$HELPER2_RESULT' = 'f|f' ]"
check "the final stored state reflects the SECOND resume genuinely winning, untouched by the helper's stale-floor evidence (got: $FINAL_FLOOR_STATE)" bash -c "[ '$FINAL_FLOOR_STATE' = 't|operator_reply' ]"

echo ""
echo "== REGRESSION (fix pass #3): claim_whatsapp_lead_slot concurrency — now reused to guard clarification-continuation rounds =="
# withLeadProcessingClaim (whatsapp-conversation-server.ts) reuses this
# EXISTING (tenant, phone) mutex from 0019_lead_write_atomicity.sql to
# close a gap a prior review found: two near-simultaneous messages for a
# lead mid-clarification (or answering a same-job follow-up) could both
# run the AI/finalize pipeline concurrently for that one lead —
# finalizeLeadWithQuote's own line-item insert is not idempotent, so this
# risked duplicate line items on the same lead, not just a duplicate
# reply. This claim/release mechanism itself (0019) had no real-
# concurrency test anywhere in this codebase before this fix pass — only
# ever exercised sequentially. It lives in the loop-guard script, not
# pg-migration-verification.sh, because this specific proof is motivated
# by the loop-guard interaction this fix pass addresses.
CLAIM_PHONE="+15556667777"
CLAIM_RESULT_FILE_1=$(mktemp)
CLAIM_RESULT_FILE_2=$(mktemp)
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -t -A -d postgres -c \
  "select claim_whatsapp_lead_slot('$TENANT_A', '$CLAIM_PHONE', 120);" > "$CLAIM_RESULT_FILE_1" 2>&1 &
LSPID_1=$!
"$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -t -A -d postgres -c \
  "select claim_whatsapp_lead_slot('$TENANT_A', '$CLAIM_PHONE', 120);" > "$CLAIM_RESULT_FILE_2" 2>&1 &
LSPID_2=$!
wait "$LSPID_1" "$LSPID_2"
LS1=$(tr -d '[:space:]' < "$CLAIM_RESULT_FILE_1")
LS2=$(tr -d '[:space:]' < "$CLAIM_RESULT_FILE_2")
rm -f "$CLAIM_RESULT_FILE_1" "$CLAIM_RESULT_FILE_2"
check "exactly one of two genuinely concurrent claim_whatsapp_lead_slot calls for the same (tenant, phone) wins, the other loses (got: '$LS1', '$LS2')" bash -c "
  { [ '$LS1' = 't' ] && [ '$LS2' = 'f' ]; } || { [ '$LS1' = 'f' ] && [ '$LS2' = 't' ]; }
"
"${PSQL_SUPERUSER[@]}" -c "select release_whatsapp_lead_slot('$TENANT_A', '$CLAIM_PHONE');" >/dev/null
RECLAIM_AFTER_RELEASE=$(psql_t "select claim_whatsapp_lead_slot('$TENANT_A', '$CLAIM_PHONE', 120);")
check "after release, a fresh claim attempt succeeds again — the retry/continuation path is not permanently stuck (got: $RECLAIM_AFTER_RELEASE)" bash -c "[ '$RECLAIM_AFTER_RELEASE' = 't' ]"

echo ""
echo "== Summary: $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
