-- Field Notes: an ongoing, business-specific knowledge log — recurring
-- local problems, preferred approaches, useful contacts, anything the
-- price sheet and tenant_capabilities don't capture. Deliberately NOT a
-- source of hard rules: nothing here ever creates or implies a
-- certification, exclusion, or price on its own — see
-- src/lib/field-notes-server.ts, which only ever writes to this table.
--
-- No application code reads or writes this table yet. Safe to re-run.

create table if not exists public.field_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- What the owner actually typed — permanent, never overwritten by the
  -- AI-generated summary below.
  body text not null check (length(trim(body)) > 0),
  -- AI-extracted, filled in synchronously at write time (same pattern as
  -- extractPriceSheetFromImage/extractPriceSheetFromUrl) — not a background
  -- job, this codebase has no job queue.
  summary text,
  keywords text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists field_notes_tenant_id_idx
  on public.field_notes (tenant_id, created_at desc);

-- Security model: same owner-scoped RLS as tenant_capabilities and
-- price_sheet_items — nothing stored here is a secret.
alter table public.field_notes enable row level security;

drop policy if exists "field_notes: owner full access" on public.field_notes;
create policy "field_notes: owner full access" on public.field_notes
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );
