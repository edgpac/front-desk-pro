-- Phase 3 of the JIR Chat integration: historical WhatsApp conversation
-- import, as the training evidence for communication-profile generation.
-- See the Phase 3 plan for the full design and why this is a new,
-- dedicated table pair rather than a reuse of leads/lead_messages:
-- leads-server.ts's listMyLeads/exportMyLeadsCsv have no filter that
-- would exclude an imported row from the real sales pipeline UI/export,
-- and lead_messages.role's two values ('customer','assistant') both
-- carry the wrong meaning for the OWNER's own historical message
-- ('assistant' specifically means JIR-AI-generated text).
--
-- Not applied by this phase of work — prepared for review only.
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- Part 1: rename communication_profile_versions.source_lead_ids to
-- source_import_ids. The column was named for an assumption (profile
-- evidence would come from `leads`) that Phase 3 replaces with imports
-- instead — see the Phase 3 plan's decision #2. A RENAME is a metadata-
-- only operation: existing rows and their array values are preserved
-- exactly as they are, nothing is rewritten or re-copied. Guarded so
-- re-running this migration (or running it after the rename has already
-- landed) is a no-op rather than an error.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'communication_profile_versions'
      and column_name = 'source_lead_ids'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'communication_profile_versions'
      and column_name = 'source_import_ids'
  ) then
    alter table public.communication_profile_versions
      rename column source_lead_ids to source_import_ids;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Part 2: how the owner's own WhatsApp messages are told apart from a
-- customer's when importing (see src/lib/whatsapp-owner-identity.ts).
-- A plain array on tenants, not a new table — this is owner-entered
-- configuration (their own name/number as it appears in their own
-- exports), not imported data, and there is at most a handful of these
-- per tenant. Validated and length/count-bounded in application code
-- (tenant-server.ts's validateWhatsAppOwnerAliases) before being saved
-- here; the column itself has no CHECK constraint duplicating that,
-- consistent with how every other free-text tenant setting in
-- 0001_init.sql is validated in application code, not in SQL.
-- ---------------------------------------------------------------------------
alter table public.tenants
  add column if not exists whatsapp_owner_aliases text[] not null default '{}';

-- ---------------------------------------------------------------------------
-- Part 3: whatsapp_imports — one row per confirmed import (never a
-- "previewed" row: preview is read-only and writes nothing, see
-- whatsapp-import-server.ts's previewWhatsAppImport).
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- sha256 of the normalized export text. Enforced unique per tenant
  -- below so importing the exact same export twice is rejected at the
  -- database layer, not only by an application-level pre-check — the
  -- same reasoning this integration's own Phase 2 hardening pass
  -- applied to communication_profile_decisions: a check-then-insert
  -- race should never be the only thing preventing a duplicate.
  content_hash text not null,
  original_filename text,
  message_count integer not null default 0,
  system_count integer not null default 0,
  unparseable_count integer not null default 0,
  ambiguous_date_count integer not null default 0,
  date_range_start timestamptz,
  date_range_end timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, content_hash)
);

create index if not exists whatsapp_imports_tenant_id_idx
  on public.whatsapp_imports (tenant_id);

-- ---------------------------------------------------------------------------
-- Part 4: whatsapp_import_messages — one row per parsed message that
-- resolved to role owner/customer/unknown (system notifications and
-- media placeholders are never persisted at all — see the parser and
-- whatsapp-import-server.ts's confirmWhatsAppImport — they carry no
-- communication-style signal and this keeps what's stored to only what
-- generation can actually use).
--
-- Deliberately NO raw sender label/phone number column: once a message
-- resolves to a role, nothing downstream needs to know WHO specifically
-- the customer was by name or number — storing the resolved role and not
-- the raw label is a direct privacy-minimization choice, not an
-- oversight.
--
-- No direct tenant_id column, mirroring lead_messages' own pattern in
-- 0001_init.sql: scoped transitively via import_id -> whatsapp_imports
-- -> tenants, and RLS below joins the same way lead_messages' policy
-- joins through leads -> tenants.
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_import_messages (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.whatsapp_imports (id) on delete cascade,
  line_number integer not null,
  role text not null check (role in ('owner', 'customer', 'unknown')),
  occurred_at timestamptz,
  date_ambiguous boolean not null default false,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_import_messages_import_id_idx
  on public.whatsapp_import_messages (import_id);

-- Supports profile-generation's evidence-eligibility check (confirming a
-- cited message id both exists and has role = 'owner') without a full
-- table scan, and the owner-only filter that same check always applies.
create index if not exists whatsapp_import_messages_import_id_role_idx
  on public.whatsapp_import_messages (import_id, role);

-- ---------------------------------------------------------------------------
-- Security model: owner-scoped RLS, same tenant-ownership check every
-- other tenant-scoped table in this codebase uses.
--
-- whatsapp_imports gets SELECT, INSERT, and DELETE — deliberately no
-- UPDATE (there is no legitimate reason to edit a historical import's
-- content; a bad import is deleted and re-imported, never silently
-- rewritten). This differs from 0031_communication_profiles.sql's
-- SELECT/INSERT-only pattern: these rows are imported personal
-- conversation data the owner must be able to retract for their own
-- privacy reasons, not immutable decision history (see
-- whatsapp-import-server.ts's deleteWhatsAppImport for the full
-- deletion policy and its limits).
--
-- whatsapp_import_messages gets only SELECT and INSERT — deliberately
-- NO standalone DELETE policy, even though messages must be removable
-- when their import is deleted. A foreign-key ON DELETE CASCADE action
-- (set on import_id above) is enforced by Postgres's referential-
-- integrity system and bypasses the child table's RLS policies
-- entirely — documented Postgres behavior, not something this grant
-- needs to additionally permit. Granting a direct DELETE here instead
-- would let an authenticated owner delete individual messages out from
-- under their own whatsapp_imports row via Supabase's REST API without
-- going through confirmWhatsAppImport/deleteWhatsAppImport at all,
-- leaving that row's message_count/date_range_* columns stale relative
-- to what's actually left — a self-inflicted data-integrity risk with
-- no corresponding benefit, since the application itself never deletes
-- a message directly; it only ever deletes the parent import and lets
-- the cascade handle the rest.
-- ---------------------------------------------------------------------------
alter table public.whatsapp_imports enable row level security;

drop policy if exists "whatsapp_imports: owner select" on public.whatsapp_imports;
create policy "whatsapp_imports: owner select" on public.whatsapp_imports
  for select using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

drop policy if exists "whatsapp_imports: owner insert" on public.whatsapp_imports;
create policy "whatsapp_imports: owner insert" on public.whatsapp_imports
  for insert with check (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

drop policy if exists "whatsapp_imports: owner delete" on public.whatsapp_imports;
create policy "whatsapp_imports: owner delete" on public.whatsapp_imports
  for delete using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

alter table public.whatsapp_import_messages enable row level security;

drop policy if exists "whatsapp_import_messages: owner select" on public.whatsapp_import_messages;
create policy "whatsapp_import_messages: owner select" on public.whatsapp_import_messages
  for select using (
    exists (
      select 1 from public.whatsapp_imports i
      join public.tenants t on t.id = i.tenant_id
      where i.id = import_id and t.user_id = auth.uid()
    )
  );

drop policy if exists "whatsapp_import_messages: owner insert" on public.whatsapp_import_messages;
create policy "whatsapp_import_messages: owner insert" on public.whatsapp_import_messages
  for insert with check (
    exists (
      select 1 from public.whatsapp_imports i
      join public.tenants t on t.id = i.tenant_id
      where i.id = import_id and t.user_id = auth.uid()
    )
  );

-- No DELETE policy here by design — see the security-model comment
-- above. Deleting a message happens only via whatsapp_imports' own
-- DELETE policy plus the ON DELETE CASCADE on import_id.
drop policy if exists "whatsapp_import_messages: owner delete" on public.whatsapp_import_messages;
