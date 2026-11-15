-- Lets an owner turn their communication profile off (JIR Chat →
-- Communication Profile → "Turn off profile"). The active profile stays
-- DERIVED (communication-profile-server.ts's loadProfileState): the
-- latest approved version is active unless its version appears here.
-- Recording the version — not a timestamp — keeps that rule free of any
-- clock comparison: each version can be approved only once (0032), so a
-- newer approval (a new version, or a restored copy of an older one)
-- always supersedes a turn-off.
--
-- Same immutable-history security model as 0031: owner-scoped RLS with
-- SELECT and INSERT only; rows cascade away with their tenant/version.
-- Safe to re-run.

create table if not exists public.communication_profile_deactivations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  version integer not null,
  deactivated_at timestamptz not null default now(),
  unique (tenant_id, version),
  foreign key (tenant_id, version)
    references public.communication_profile_versions (tenant_id, version)
    on delete cascade
);

alter table public.communication_profile_deactivations enable row level security;

drop policy if exists "communication_profile_deactivations: owner select" on public.communication_profile_deactivations;
create policy "communication_profile_deactivations: owner select" on public.communication_profile_deactivations
  for select using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

drop policy if exists "communication_profile_deactivations: owner insert" on public.communication_profile_deactivations;
create policy "communication_profile_deactivations: owner insert" on public.communication_profile_deactivations
  for insert with check (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );
