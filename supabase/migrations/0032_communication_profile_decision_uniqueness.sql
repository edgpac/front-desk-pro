-- Closes a gap flagged in the independent review of Phase 1
-- (0031_communication_profiles.sql): communication_profile_decisions had
-- no database-level guarantee that a given (tenant_id, version) is only
-- ever decided once. recordCommunicationProfileDecision in
-- communication-profile-server.ts already checks for an existing
-- decision before inserting, but that check-then-insert is application
-- code, not atomic — two concurrent calls could both pass the check
-- before either one's insert lands, producing two decisions for the
-- same version. This constraint makes the second insert fail at the
-- database layer regardless of any application-level race, the same
-- way 0031's own unique(tenant_id, version) already protects
-- communication_profile_versions from a duplicate version number.
--
-- Deliberately a NEW migration rather than editing 0031: that file is
-- already applied-and-reviewed history for this project, consistent with
-- this codebase's migrations always being additive, never edited after
-- the fact (see every other 00xx file).
--
-- NOT applied by this phase of work — prepared for review only. See the
-- Phase 2 report for why.
--
-- Safe to re-run.

-- Postgres has no "ADD CONSTRAINT IF NOT EXISTS" — guarded via pg_constraint
-- instead, matching this codebase's "safe to re-run" convention for DDL.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'communication_profile_decisions_tenant_version_key'
  ) then
    alter table public.communication_profile_decisions
      add constraint communication_profile_decisions_tenant_version_key
      unique (tenant_id, version);
  end if;
end $$;
