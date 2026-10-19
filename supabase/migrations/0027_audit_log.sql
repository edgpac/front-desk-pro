-- Audit log for the three action categories this engagement's security
-- review flagged as needing a trace: subscription/billing state changes,
-- WhatsApp (Meta) connect/disconnect, and lead deletion — the last one
-- specifically because deleteLead/deleteLeads leave zero trace today (a
-- hard delete with cascade, no record of who deleted what or when). Scope
-- approved 2026-10-18, see SECURITY_REMEDIATION_TRACKER.md §3.4. Not a
-- general-purpose audit framework for every table in this app — adding a
-- new action category later is a deliberate, separate decision, not
-- something this table's shape should silently expand to absorb.
--
-- Append-only: application code only ever INSERTs here, never UPDATEs or
-- DELETEs a row (src/lib/audit-log-server.ts's recordAuditLog is the only
-- writer). Same zero-access RLS posture as whatsapp_connections/
-- whatsapp_opt_outs/whatsapp_loop_guards — service_role only, nothing here
-- is readable or writable from a tenant's own authenticated session. There
-- is no dashboard UI reading this table yet — same "built, not yet
-- surfaced" precedent already set by resumeWhatsAppOptOut/
-- resumeWhatsAppAutomation, which also have no UI button today.
--
-- target_id is `text`, not a uuid foreign key, because the four actions
-- point at three structurally different kinds of row (a lead id, a
-- whatsapp_connections id, or a Supabase auth user id for subscription
-- changes) — one polymorphic FK across three unrelated tables is exactly
-- the case a plain indexed text column serves better than three separate
-- nullable FK columns for the same practical purpose.
--
-- actor_user_id is null whenever actor_type = 'system' (a Stripe webhook
-- event, or scripts/reconcile-subscription-metadata.ts's own writes,
-- which both go through the same writeSubscriptionState chokepoint) —
-- there's no human in the loop to attribute those to, and NULL says that
-- honestly rather than inventing a placeholder actor.
--
-- metadata is intentionally unstructured (jsonb) — each action logs
-- whatever non-secret detail is useful for it (e.g. plan/status for a
-- subscription change, the display phone number for a WhatsApp connect)
-- without forcing every action category into the same fixed column set.
--
-- Safe to re-run.

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  actor_type text not null check (actor_type in ('owner', 'system')),
  actor_user_id uuid,
  action text not null check (
    action in ('subscription.state_changed', 'whatsapp.connected', 'whatsapp.disconnected', 'lead.deleted')
  ),
  target_type text not null check (target_type in ('subscription', 'whatsapp_connection', 'lead')),
  target_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_tenant_time_idx on public.audit_log (tenant_id, created_at desc);
create index if not exists audit_log_action_time_idx on public.audit_log (action, created_at desc);

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;
