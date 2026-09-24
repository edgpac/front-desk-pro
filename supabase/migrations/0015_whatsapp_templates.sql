-- WhatsApp message template management (Meta Cloud API). Scoped 2026-09-24:
-- required both to unblock the Advanced Access App Review video ("your app
-- being used to create a message template") and to close a real gap —
-- MetaOutsideWindowError (Meta error 131047) has been caught since the Meta
-- send path was built, surfaced to the owner with copy admitting "which
-- isn't set up yet." This table is the local mirror of Meta's own
-- message_templates resource: the actual template lives on Meta's side once
-- submitted, this table tracks what was submitted and its approval status
-- (kept in sync by api.whatsapp.meta-webhook.tsx's new
-- message_template_status_update handling).
--
-- Security model: same as 0003_whatsapp_connections.sql, not the owner-RLS
-- pattern price_sheet_items/tenant_capabilities use — every row here is
-- created by calling Meta's API using a whatsapp_connections row's stored
-- system-user token (itself zero-RLS/service-role-only), so keeping this
-- table on the same footing keeps the whole WhatsApp-connection family
-- consistent and avoids the "Security Definer View" trap 0003 already
-- documented. src/lib/whatsapp-templates-server.ts's auth-gated server
-- functions are the only access path, same as
-- getMyWhatsAppConnection/disconnectMetaWhatsApp today. Safe to re-run.

create table if not exists public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Meta's numeric template id, returned once the create call succeeds.
  -- Null only in the narrow window before that response is recorded — never
  -- used as a lookup key before it's populated.
  meta_template_id text,
  -- Meta's naming rule: lowercase letters, numbers, underscores only.
  -- Enforced server-side in whatsapp-templates-server.ts before ever
  -- calling Meta, not just here.
  name text not null check (name ~ '^[a-z0-9_]+$'),
  category text not null check (category in ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  language text not null,
  header_text text,
  body_text text not null check (length(trim(body_text)) > 0),
  footer_text text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'paused')),
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Mirrors Meta's own uniqueness rule (one name per WABA per language) —
-- catches a duplicate locally before wasting a real API call.
create unique index if not exists whatsapp_templates_tenant_name_language_idx
  on public.whatsapp_templates (tenant_id, name, language);

create index if not exists whatsapp_templates_tenant_id_idx
  on public.whatsapp_templates (tenant_id, created_at desc);

-- Webhook status-sync looks templates up by Meta's own (globally unique)
-- template id directly — no tenant resolution needed for that lookup.
create index if not exists whatsapp_templates_meta_template_id_idx
  on public.whatsapp_templates (meta_template_id)
  where meta_template_id is not null;

drop trigger if exists set_updated_at on public.whatsapp_templates;
create trigger set_updated_at before update on public.whatsapp_templates
  for each row execute function public.set_updated_at();

alter table public.whatsapp_templates enable row level security;
revoke all on public.whatsapp_templates from anon, authenticated;
