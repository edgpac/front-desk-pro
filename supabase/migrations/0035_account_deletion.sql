-- Phase 4A: account deletion and customer-data deletion (Settings > Data &
-- Privacy). Two parts:
--
-- 1. Widens audit_log's action/target_type CHECK constraints (0027's own
--    comment: "adding a new action category later is a deliberate, separate
--    decision" — this is that decision) to cover the two new actions this
--    feature records: a "delete all customer data" action, and the full
--    account-deletion sequence's start/failure (a completed deletion cascades
--    the tenant away, including any audit_log row recorded moments earlier —
--    see account-deletion-server.ts's own comment on why that's correct, not
--    a gap).
--
-- 2. Adds account_deletion_requests: durable, per-tenant state for the
--    multi-step account-deletion sequence (Stripe cancel -> Meta disconnect
--    -> orphan cleanup -> Supabase Auth user delete). A plain in-memory
--    sequence across three external systems (Stripe, Meta's Graph API,
--    Supabase's Auth Admin API) has no atomicity guarantee if the server
--    process crashes or times out partway through — this table is what
--    makes a retry resume from the last completed checkpoint instead of
--    re-running already-completed, not-safely-repeatable side effects (most
--    importantly: never calling Stripe's cancel endpoint twice, and never
--    attempting to delete an already-deleted customer/subscription), and
--    what prevents two concurrent deletion requests for the same tenant
--    from racing each other.
--
-- NOT applied to production as part of this change — see
-- account-deletion-server.ts's header comment and this phase's final report
-- for the exact SQL to run and why it's being held for explicit approval.
--
-- Safe to re-run.

alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check check (
  action in (
    'subscription.state_changed',
    'whatsapp.connected',
    'whatsapp.disconnected',
    'lead.deleted',
    'customer_data.deleted',
    'account.deletion_requested',
    'account.deletion_failed'
  )
);

alter table public.audit_log drop constraint if exists audit_log_target_type_check;
alter table public.audit_log add constraint audit_log_target_type_check check (
  target_type in ('subscription', 'whatsapp_connection', 'lead', 'tenant')
);

-- ---------------------------------------------------------------------------
-- account_deletion_requests
-- ---------------------------------------------------------------------------
-- status is intentionally a two-value state machine, not three: there is no
-- 'completed' value, because a successful run ends by deleting the tenant's
-- auth.users row, which cascades this row away (tenant_id references
-- tenants on delete cascade) in the very same operation that completes the
-- deletion — there is never a moment where a "completed" row exists to be
-- read. 'failed' is the only state that persists on disk, by design: it's
-- the one outcome a human (the owner retrying, or the operator debugging)
-- actually needs a durable record of.
create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'failed')),
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_cancelled_at timestamptz,
  whatsapp_disconnect_attempted_at timestamptz,
  whatsapp_disconnected_at timestamptz,
  whatsapp_disconnect_error text,
  failure_reason text,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one NOT-failed request per tenant at a time. A concurrent second
-- attempt (another tab, a double click, a retried request that landed twice)
-- hits this unique index as a 23505 violation, which the application
-- translates into "a deletion is already in progress" rather than racing
-- the first attempt's Stripe/Meta calls. A 'failed' row deliberately falls
-- outside this index so a retry can re-use (update) the same row and resume
-- from its recorded checkpoint, instead of being blocked by its own prior
-- failure.
create unique index if not exists account_deletion_requests_tenant_inflight_idx
  on public.account_deletion_requests (tenant_id)
  where status = 'pending';

-- Same zero-access posture as every other internal/service-role-only table
-- in this schema (whatsapp_connections, stripe_webhook_claims, audit_log):
-- nothing here is ever read or written by an anon/authenticated client —
-- only account-deletion-server.ts's admin-client calls touch this table.
alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from anon, authenticated;
