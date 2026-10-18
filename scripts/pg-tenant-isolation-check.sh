#!/usr/bin/env bash
# Two-tenant RLS isolation check for the ORIGINAL business-data tables
# (tenants, price_sheet_items, leads, lead_line_items, lead_messages) plus
# tenant_capabilities/field_notes, which share the identical owner-scoped
# RLS pattern. pg-migration-verification.sh already proves RLS/grants for
# the three newest subscription-related tables; this is the same real-
# PostgreSQL methodology applied to the tables that carry actual tenant
# business data, with two real tenants seeded and RLS exercised AS each
# tenant's own session — not just inspected from migration source.
#
# Never touches this project's real Supabase database, and cannot
# accidentally connect to one: a brand-new throwaway Postgres cluster is
# initialized fresh in a mktemp directory, bound ONLY to a Unix socket in
# that same throwaway directory (listen_addresses='' — no TCP port is ever
# opened, so there is no network address to misdirect to), on a dedicated
# local socket path distinct from pg-migration-verification.sh's own
# cluster. Every single psql invocation below passes -h/-p explicitly
# against that one socket — none ever rely on ambient PGHOST/PGPORT/
# DATABASE_URL/PGPASSWORD environment variables, so a stray real-looking
# env var cannot redirect any command here to a real database. The cluster
# is torn down and its directory removed on exit, success or failure.
#
# What this verifies, in order:
#   1. All 23 migration files apply cleanly (same as pg-migration-
#      verification.sh — re-applied here since this is a separate,
#      from-scratch cluster, not a shared one).
#   2. Two real tenants, each with their own auth.users row, tenant row,
#      price_sheet_items row, leads row (plus a lead_line_items and
#      lead_messages row under that lead), tenant_capabilities row, and
#      field_notes row — seeded as the postgres superuser (bypasses RLS,
#      same as a real migration/seed script would).
#   3. For EVERY one of those seven tables: connected as the `authenticated`
#      role with auth.uid() stubbed to tenant A's own user id (the same
#      stub mechanism pg-migration-verification.sh already proved —
#      current_setting('request.jwt.claim.sub')), tenant A's session must
#      see ZERO of tenant B's rows on SELECT, affect ZERO rows on UPDATE/
#      DELETE against tenant B's data, and have an INSERT claiming tenant
#      B's tenant_id/lead_id rejected by the policy's WITH CHECK clause —
#      while the identical operations against tenant A's OWN rows must all
#      succeed normally, so this is a genuine denial-vs-success contrast,
#      not just a one-sided "everything fails" check that would also pass
#      if RLS were broken in the opposite direction (denying everyone).
#
# Usage:
#   bash scripts/pg-tenant-isolation-check.sh
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

WORKDIR=$(mktemp -d /tmp/pg-tenant-isolation-check.XXXXXX)
PGDATA="$WORKDIR/data"
# A distinct port/socket from pg-migration-verification.sh's 55331, so the
# two scripts can never collide if ever run back to back or concurrently.
PGPORT=55332
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

echo "== Initializing throwaway Postgres cluster at $PGDATA (port $PGPORT, Unix socket only, no TCP listener) =="
"$PG_BIN_DIR/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PG_BIN_DIR/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -p $PGPORT -c listen_addresses=''" -l "$WORKDIR/server.log" start >/dev/null

PSQL_SUPERUSER=("$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q -P pager=off -d postgres)

echo ""
echo "== Bootstrapping the same minimal stand-in for Supabase's own schema/roles as pg-migration-verification.sh =="
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

create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

grant usage on schema public to anon, authenticated, service_role;

-- A real Supabase project grants anon/authenticated baseline SELECT/INSERT/
-- UPDATE/DELETE on public-schema tables by default at the platform level,
-- outside of and before any of this app's own migrations — RLS is what's
-- meant to actually restrict access on top of that, not table-level grants
-- (confirmed by this app's own zero-access tables needing an EXPLICIT
-- revoke in their migrations, e.g. 0003_whatsapp_connections.sql, to
-- override this same default). Reproduced here via ALTER DEFAULT
-- PRIVILEGES so every table the migrations create below picks it up
-- automatically, in the same order a real Supabase project has it: this
-- default exists BEFORE the app's migrations run, and a migration's own
-- explicit revoke (for the secret tables) correctly overrides it afterward.
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
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
echo "== Seeding two real, independent tenants (as postgres — RLS doesn't apply to a superuser) =="
TENANT_A_USER="a0a0a0a0-0000-0000-0000-00000000000a"
TENANT_B_USER="b0b0b0b0-0000-0000-0000-00000000000b"

"${PSQL_SUPERUSER[@]}" -c "
insert into auth.users (id, email) values
  ('$TENANT_A_USER', 'owner-a@example.test'),
  ('$TENANT_B_USER', 'owner-b@example.test');
" >/dev/null

psql_t() { "$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -q -t -A -d postgres -v ON_ERROR_STOP=1 -c "$1"; }

# 0001_init.sql's own on_auth_user_created trigger already auto-created one
# tenant row per auth.users insert above (discovered by running this, not
# assumed from the migration source) — real behavior the real app relies on
# (tenant-server.ts's own comment says so), so this updates that
# auto-created row to a predictable name rather than inserting a second,
# conflicting one.
TENANT_A_ID=$(psql_t "update tenants set name = 'Tenant A Handyman' where user_id = '$TENANT_A_USER' returning id;")
TENANT_B_ID=$(psql_t "update tenants set name = 'Tenant B Plumbing' where user_id = '$TENANT_B_USER' returning id;")

PRICE_A_ID=$(psql_t "insert into price_sheet_items (tenant_id, task) values ('$TENANT_A_ID', 'Tenant A task') returning id;")
PRICE_B_ID=$(psql_t "insert into price_sheet_items (tenant_id, task) values ('$TENANT_B_ID', 'Tenant B task') returning id;")

LEAD_A_ID=$(psql_t "insert into leads (tenant_id, customer_name, problem) values ('$TENANT_A_ID', 'A Customer', 'A problem') returning id;")
LEAD_B_ID=$(psql_t "insert into leads (tenant_id, customer_name, problem) values ('$TENANT_B_ID', 'B Customer', 'B problem') returning id;")

LINE_A_ID=$(psql_t "insert into lead_line_items (lead_id, description) values ('$LEAD_A_ID', 'A line item') returning id;")
LINE_B_ID=$(psql_t "insert into lead_line_items (lead_id, description) values ('$LEAD_B_ID', 'B line item') returning id;")

MSG_A_ID=$(psql_t "insert into lead_messages (lead_id, role, body) values ('$LEAD_A_ID', 'customer', 'A message') returning id;")
MSG_B_ID=$(psql_t "insert into lead_messages (lead_id, role, body) values ('$LEAD_B_ID', 'customer', 'B message') returning id;")

CAP_A_ID=$(psql_t "insert into tenant_capabilities (tenant_id, type, label) values ('$TENANT_A_ID', 'specialty', 'A capability') returning id;")
CAP_B_ID=$(psql_t "insert into tenant_capabilities (tenant_id, type, label) values ('$TENANT_B_ID', 'specialty', 'B capability') returning id;")

NOTE_A_ID=$(psql_t "insert into field_notes (tenant_id, body) values ('$TENANT_A_ID', 'A field note') returning id;")
NOTE_B_ID=$(psql_t "insert into field_notes (tenant_id, body) values ('$TENANT_B_ID', 'B field note') returning id;")

echo "  tenant A: $TENANT_A_ID / tenant B: $TENANT_B_ID"
check "all seed rows were created (every captured id is non-empty)" bash -c "
  [ -n '$TENANT_A_ID' ] && [ -n '$TENANT_B_ID' ] && [ -n '$PRICE_A_ID' ] && [ -n '$PRICE_B_ID' ] &&
  [ -n '$LEAD_A_ID' ] && [ -n '$LEAD_B_ID' ] && [ -n '$LINE_A_ID' ] && [ -n '$LINE_B_ID' ] &&
  [ -n '$MSG_A_ID' ] && [ -n '$MSG_B_ID' ] && [ -n '$CAP_A_ID' ] && [ -n '$CAP_B_ID' ] &&
  [ -n '$NOTE_A_ID' ] && [ -n '$NOTE_B_ID' ]
"

# Runs SQL as the `authenticated` role with auth.uid() stubbed to tenant
# A's own user id — the exact mechanism pg-migration-verification.sh
# already proved (set role + the same request.jwt.claim.sub GUC the stub
# auth.uid() reads). A fresh connection per call, same as every check in
# the existing script.
as_tenant_a() {
  "$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -q -t -A -d postgres -c \
    "set role authenticated; set request.jwt.claim.sub = '$TENANT_A_USER'; $1"
}
# Same, but without -t -A, so UPDATE/DELETE/INSERT command tags ("UPDATE 1",
# "INSERT 0 1", etc.) are visible in the output for row-count assertions.
as_tenant_a_tagged() {
  # No -q here, deliberately — -q suppresses psql's command-completion tags
  # ("UPDATE 0", "DELETE 1", "INSERT 0 1") entirely, which is exactly the
  # output these row-count assertions read (confirmed by direct testing,
  # not assumed — -q with an UPDATE/DELETE prints nothing at all).
  "$PG_BIN_DIR/psql" -h "$PGSOCK" -p "$PGPORT" -U postgres -d postgres -c \
    "set role authenticated; set request.jwt.claim.sub = '$TENANT_A_USER'; $1" 2>&1
}
# check's command runs in a fresh `bash -c` subshell, which does not inherit
# the parent shell's functions or variables unless exported — both are
# needed there.
export -f as_tenant_a as_tenant_a_tagged
export PG_BIN_DIR PGSOCK PGPORT TENANT_A_USER

echo ""
echo "== tenants: cross-tenant denial vs. same-tenant success =="
check "tenant A cannot SELECT tenant B's tenant row" bash -c "[ \"\$(as_tenant_a \"select count(*) from tenants where id = '$TENANT_B_ID';\")\" = '0' ]"
check "tenant A CAN SELECT their own tenant row" bash -c "[ \"\$(as_tenant_a \"select count(*) from tenants where id = '$TENANT_A_ID';\")\" = '1' ]"
check "tenant A's UPDATE against tenant B's tenant row affects 0 rows" bash -c "as_tenant_a_tagged \"update tenants set name = 'hijacked' where id = '$TENANT_B_ID';\" | grep -q 'UPDATE 0'"
check "tenant A's UPDATE against their own tenant row succeeds" bash -c "as_tenant_a_tagged \"update tenants set name = 'Tenant A renamed' where id = '$TENANT_A_ID';\" | grep -q 'UPDATE 1'"

echo ""
echo "== price_sheet_items: cross-tenant denial vs. same-tenant success =="
check "tenant A cannot SELECT tenant B's price-sheet row" bash -c "[ \"\$(as_tenant_a \"select count(*) from price_sheet_items where id = '$PRICE_B_ID';\")\" = '0' ]"
check "tenant A CAN SELECT their own price-sheet row" bash -c "[ \"\$(as_tenant_a \"select count(*) from price_sheet_items where id = '$PRICE_A_ID';\")\" = '1' ]"
check "tenant A's DELETE against tenant B's price-sheet row affects 0 rows" bash -c "as_tenant_a_tagged \"delete from price_sheet_items where id = '$PRICE_B_ID';\" | grep -q 'DELETE 0'"
check "tenant A's INSERT claiming tenant B's tenant_id is rejected (WITH CHECK)" bash -c "as_tenant_a_tagged \"insert into price_sheet_items (tenant_id, task) values ('$TENANT_B_ID', 'forged');\" | grep -qi 'new row violates row-level security'"
check "tenant A CAN insert their own price-sheet row" bash -c "as_tenant_a_tagged \"insert into price_sheet_items (tenant_id, task) values ('$TENANT_A_ID', 'A second task');\" | grep -q 'INSERT 0 1'"

echo ""
echo "== leads: cross-tenant denial vs. same-tenant success =="
check "tenant A cannot SELECT tenant B's lead" bash -c "[ \"\$(as_tenant_a \"select count(*) from leads where id = '$LEAD_B_ID';\")\" = '0' ]"
check "tenant A CAN SELECT their own lead" bash -c "[ \"\$(as_tenant_a \"select count(*) from leads where id = '$LEAD_A_ID';\")\" = '1' ]"
check "tenant A's UPDATE against tenant B's lead affects 0 rows" bash -c "as_tenant_a_tagged \"update leads set status = 'won' where id = '$LEAD_B_ID';\" | grep -q 'UPDATE 0'"
check "tenant A's DELETE against tenant B's lead affects 0 rows" bash -c "as_tenant_a_tagged \"delete from leads where id = '$LEAD_B_ID';\" | grep -q 'DELETE 0'"
check "tenant A's INSERT claiming tenant B's tenant_id is rejected (WITH CHECK)" bash -c "as_tenant_a_tagged \"insert into leads (tenant_id, customer_name) values ('$TENANT_B_ID', 'forged lead');\" | grep -qi 'new row violates row-level security'"

echo ""
echo "== lead_line_items (child table, joined through leads -> tenants): cross-tenant denial vs. same-tenant success =="
check "tenant A cannot SELECT a line item on tenant B's lead" bash -c "[ \"\$(as_tenant_a \"select count(*) from lead_line_items where id = '$LINE_B_ID';\")\" = '0' ]"
check "tenant A CAN SELECT a line item on their own lead" bash -c "[ \"\$(as_tenant_a \"select count(*) from lead_line_items where id = '$LINE_A_ID';\")\" = '1' ]"
check "tenant A's UPDATE against a line item on tenant B's lead affects 0 rows" bash -c "as_tenant_a_tagged \"update lead_line_items set description = 'hijacked' where id = '$LINE_B_ID';\" | grep -q 'UPDATE 0'"
check "tenant A's INSERT of a line item against tenant B's lead_id is rejected (WITH CHECK)" bash -c "as_tenant_a_tagged \"insert into lead_line_items (lead_id, description) values ('$LEAD_B_ID', 'forged line item');\" | grep -qi 'new row violates row-level security'"
check "tenant A CAN insert a line item against their own lead" bash -c "as_tenant_a_tagged \"insert into lead_line_items (lead_id, description) values ('$LEAD_A_ID', 'A second line item');\" | grep -q 'INSERT 0 1'"

echo ""
echo "== lead_messages (child table, joined through leads -> tenants): cross-tenant denial vs. same-tenant success =="
check "tenant A cannot SELECT a message on tenant B's lead" bash -c "[ \"\$(as_tenant_a \"select count(*) from lead_messages where id = '$MSG_B_ID';\")\" = '0' ]"
check "tenant A CAN SELECT a message on their own lead" bash -c "[ \"\$(as_tenant_a \"select count(*) from lead_messages where id = '$MSG_A_ID';\")\" = '1' ]"
check "tenant A's DELETE against a message on tenant B's lead affects 0 rows" bash -c "as_tenant_a_tagged \"delete from lead_messages where id = '$MSG_B_ID';\" | grep -q 'DELETE 0'"
check "tenant A's INSERT of a message against tenant B's lead_id is rejected (WITH CHECK)" bash -c "as_tenant_a_tagged \"insert into lead_messages (lead_id, role, body) values ('$LEAD_B_ID', 'assistant', 'forged message');\" | grep -qi 'new row violates row-level security'"

echo ""
echo "== tenant_capabilities: cross-tenant denial vs. same-tenant success =="
check "tenant A cannot SELECT tenant B's capability" bash -c "[ \"\$(as_tenant_a \"select count(*) from tenant_capabilities where id = '$CAP_B_ID';\")\" = '0' ]"
check "tenant A CAN SELECT their own capability" bash -c "[ \"\$(as_tenant_a \"select count(*) from tenant_capabilities where id = '$CAP_A_ID';\")\" = '1' ]"
check "tenant A's DELETE against tenant B's capability affects 0 rows" bash -c "as_tenant_a_tagged \"delete from tenant_capabilities where id = '$CAP_B_ID';\" | grep -q 'DELETE 0'"
check "tenant A's INSERT claiming tenant B's tenant_id is rejected (WITH CHECK)" bash -c "as_tenant_a_tagged \"insert into tenant_capabilities (tenant_id, type, label) values ('$TENANT_B_ID', 'specialty', 'forged capability');\" | grep -qi 'new row violates row-level security'"

echo ""
echo "== field_notes: cross-tenant denial vs. same-tenant success =="
check "tenant A cannot SELECT tenant B's field note" bash -c "[ \"\$(as_tenant_a \"select count(*) from field_notes where id = '$NOTE_B_ID';\")\" = '0' ]"
check "tenant A CAN SELECT their own field note" bash -c "[ \"\$(as_tenant_a \"select count(*) from field_notes where id = '$NOTE_A_ID';\")\" = '1' ]"
check "tenant A's DELETE against tenant B's field note affects 0 rows" bash -c "as_tenant_a_tagged \"delete from field_notes where id = '$NOTE_B_ID';\" | grep -q 'DELETE 0'"
check "tenant A's INSERT claiming tenant B's tenant_id is rejected (WITH CHECK)" bash -c "as_tenant_a_tagged \"insert into field_notes (tenant_id, body) values ('$TENANT_B_ID', 'forged note');\" | grep -qi 'new row violates row-level security'"

echo ""
echo "== Sanity check: an unauthenticated (anon) session sees nothing on either tenant's data =="
check "anon cannot SELECT any tenant row at all" bash -c "
  out=\$('$PG_BIN_DIR/psql' -h '$PGSOCK' -p '$PGPORT' -U postgres -q -t -A -d postgres -c \"set role anon; select count(*) from tenants;\")
  [ \"\$out\" = '0' ]
"

echo ""
echo "== Limitations, stated explicitly =="
echo "   This proves RLS denies/allows access at the database layer directly, using the"
echo "   same stand-in auth.uid() stub pg-migration-verification.sh already established."
echo "   It does NOT exercise the application's createServerFn code or a real HTTP request"
echo "   with a real Supabase-issued JWT — there is no GoTrue/PostgREST in this throwaway"
echo "   cluster, only vanilla Postgres plus the stub. That remains true of every real-"
echo "   PostgreSQL check performed this engagement, not a new gap introduced here."

echo ""
echo "== Summary: $PASS passed, $FAIL failed =="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
