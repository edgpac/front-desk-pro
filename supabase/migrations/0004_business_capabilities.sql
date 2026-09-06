-- Foundation for business capabilities — certifications, specialties, and
-- equipment a business has, and exclusions (work they won't take even if
-- capable of it). This is the hard-boundary signal for the AI's decision
-- engine, alongside the price sheet's softer "relatedness" signal — see the
-- capabilities architecture plan for the full design.
--
-- One table, four types, rather than a `tenants.certifications text[]`
-- column: certifications/specialties/equipment/exclusions all share the
-- same shape (a type + a label + optional notes), so this avoids a second
-- migration later to bolt on exclusions as an afterthought.
--
-- No application code reads or writes this table yet. Safe to re-run.

create table if not exists public.tenant_capabilities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  type text not null check (type in ('certification', 'specialty', 'equipment', 'exclusion')),
  label text not null check (length(trim(label)) > 0),
  notes text,
  -- Lets a capability be retired (certification expired, employee who held
  -- it left) without losing the historical record by deleting the row. No
  -- deactivate/reactivate server function is being built in this phase —
  -- this column just means the schema won't need a migration to add one
  -- later.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Prevents the same tenant from adding the exact same capability twice.
-- Normalized on both case AND surrounding whitespace, so "EPA Refrigerant
-- Certification", "epa refrigerant certification", and "  EPA refrigerant
-- certification " are all treated as the same entry rather than creating
-- near-duplicates.
create unique index if not exists tenant_capabilities_unique_label
  on public.tenant_capabilities (tenant_id, type, lower(trim(label)));

create index if not exists tenant_capabilities_tenant_id_idx
  on public.tenant_capabilities (tenant_id);

drop trigger if exists set_updated_at on public.tenant_capabilities;
create trigger set_updated_at before update on public.tenant_capabilities
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Security model: nothing stored here is a secret (unlike
-- whatsapp_connections), so this follows the same owner-scoped RLS pattern
-- price_sheet_items already uses in 0001_init.sql exactly — no new
-- authorization pattern invented for this table.
-- ---------------------------------------------------------------------------
alter table public.tenant_capabilities enable row level security;

drop policy if exists "tenant_capabilities: owner full access" on public.tenant_capabilities;
create policy "tenant_capabilities: owner full access" on public.tenant_capabilities
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );
