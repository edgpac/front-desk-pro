-- Foundation for the AI assistant's approved communication profile — a
-- structured description of HOW a tenant's business communicates (tone,
-- greeting/sign-off style, typical phrasing), generated from owner-imported
-- historical conversations and reviewed/approved by the owner before it
-- informs anything. See the integration investigation (Cabos Chat ×
-- Job It Ready) for the full design and why this stays separate from
-- business facts.
--
-- Deliberately NOT business facts: nothing here ever represents what the
-- business offers, charges, or excludes — that remains exactly
-- price_sheet_items / tenant_capabilities / tenants, unchanged by this
-- migration. A communication profile can only ever affect tone, never
-- service availability or pricing.
--
-- Append-only by design, mirroring the reference CLI implementation this
-- ports from: a version is written once and never updated. "The active
-- profile" is DERIVED (the most recently approved decision), never a
-- stored status flag a bug could leave stale. Approving, rejecting, editing,
-- or restoring an earlier version all INSERT a new row; nothing here is
-- ever UPDATEd. The RLS policies below deliberately omit UPDATE and DELETE
-- grants for the authenticated owner to enforce that at the database level,
-- not just by application convention — a narrower grant than this
-- codebase's usual "owner full access" pattern (see 0004's tenant_capabilities),
-- chosen specifically because this table's correctness depends on no row
-- ever changing after it's written.
--
-- No application code reads or writes these tables yet (Phase 1 of the
-- integration: schema + ported pure logic only). Safe to re-run.

create table if not exists public.communication_profile_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Monotonic per tenant, assigned by the application (not a sequence) —
  -- mirrors the reference implementation so "version 3" means the same
  -- thing here as it does there. Enforced unique per tenant below.
  version integer not null check (version > 0),
  -- The CommunicationProfile object itself — see src/lib/communication-profile.ts
  -- for its shape. Stored as JSON rather than normalized columns because
  -- its field set is still evolving and every field already carries its
  -- own source/confidence/evidence metadata that would otherwise need its
  -- own column family per field.
  profile_json jsonb not null,
  -- Which imported conversations this version was generated from, for
  -- traceability — empty for a version created purely by editing an
  -- earlier one. Lead ids are not foreign-keyed on purpose: a lead can be
  -- deleted later without invalidating the historical record of what this
  -- version was originally based on.
  source_lead_ids uuid[] not null default '{}',
  -- Set only when this version's content was copied from an earlier
  -- version via "restore" — null for a freshly generated or edited one.
  restored_from_version integer,
  created_at timestamptz not null default now(),
  unique (tenant_id, version)
);

create index if not exists communication_profile_versions_tenant_id_idx
  on public.communication_profile_versions (tenant_id);

-- An append-only decision log, never a status column on
-- communication_profile_versions — "the active profile" is derived (the
-- approved decision with the latest id/decided_at), not stored as a flag.
create table if not exists public.communication_profile_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  version integer not null,
  decision text not null check (decision in ('approved', 'rejected')),
  note text,
  decided_at timestamptz not null default now(),
  foreign key (tenant_id, version)
    references public.communication_profile_versions (tenant_id, version)
    on delete cascade
);

create index if not exists communication_profile_decisions_tenant_version_idx
  on public.communication_profile_decisions (tenant_id, version);

-- ---------------------------------------------------------------------------
-- Security model: owner-scoped RLS, same tenant-ownership check every other
-- tenant-scoped table in this codebase uses (price_sheet_items in
-- 0001_init.sql, tenant_capabilities in 0004_business_capabilities.sql).
-- Grants SELECT and INSERT only — see the table comment above for why this
-- intentionally narrows the usual "owner full access" pattern: these rows
-- are immutable history, and the database should enforce that even if a
-- future server function has a bug. Deleting a tenant still cascades
-- (on delete cascade above), so there is no orphaned-row risk from
-- omitting an owner DELETE grant.
-- ---------------------------------------------------------------------------
alter table public.communication_profile_versions enable row level security;

drop policy if exists "communication_profile_versions: owner select" on public.communication_profile_versions;
create policy "communication_profile_versions: owner select" on public.communication_profile_versions
  for select using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

drop policy if exists "communication_profile_versions: owner insert" on public.communication_profile_versions;
create policy "communication_profile_versions: owner insert" on public.communication_profile_versions
  for insert with check (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

alter table public.communication_profile_decisions enable row level security;

drop policy if exists "communication_profile_decisions: owner select" on public.communication_profile_decisions;
create policy "communication_profile_decisions: owner select" on public.communication_profile_decisions
  for select using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

drop policy if exists "communication_profile_decisions: owner insert" on public.communication_profile_decisions;
create policy "communication_profile_decisions: owner insert" on public.communication_profile_decisions
  for insert with check (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );
