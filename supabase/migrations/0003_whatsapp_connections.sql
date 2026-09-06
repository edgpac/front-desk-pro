-- Foundation for self-service WhatsApp onboarding (Twilio WhatsApp Tech
-- Provider Program + Meta Embedded Signup v4). This migration is schema +
-- security ONLY — no application code reads or writes this table yet, and no
-- Twilio credential is stored here yet (see note below). The existing manual
-- pipeline (tenants.whatsapp_number, api.whatsapp.webhook.tsx's lookup) is
-- completely untouched by this file and keeps working exactly as it does
-- today; this table is additive, not a replacement.
--
-- A tenant gets a new row each time they run through Embedded Signup, so
-- attempt history survives across reconnects — but an individual row IS
-- updated in place over its own lifecycle (status moves creating -> online,
-- or online -> disconnected, via server code in a later phase). Not
-- append-only in the literal sense (nothing here blocks UPDATE/DELETE);
-- what's preserved is one row per attempt, not immutability of any one row —
-- the same shape leads already has in 0001_init.sql (one row per inquiry,
-- updated over its lifecycle), not the stricter never-updated shape of
-- lead_messages.
--
-- Deliberately NOT included yet: any column for a Twilio subaccount auth
-- token. That's a live secret capable of sending messages and incurring cost
-- on a customer's subaccount — the first per-row secret this schema would
-- ever hold — and it isn't being stored until the encryption/storage
-- approach has actually been implemented and reviewed, not just planned.
-- Safe to re-run.

create table if not exists public.whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  status text not null default 'creating'
    check (status in ('creating', 'offline', 'verifying', 'online', 'failed', 'disconnected')),
  -- E.164, what a future webhook lookup would match an inbound Twilio "To"
  -- against — same shape as tenants.whatsapp_number today.
  phone_number text,
  -- Meta's WhatsApp Business Account id, returned by Embedded Signup.
  waba_id text,
  -- Meta's id for the specific phone number, returned by Embedded Signup.
  meta_phone_number_id text,
  -- Twilio subaccount identifiers. The SID alone isn't a bearer secret (akin
  -- to a username), which is why it's fine to store now even though the
  -- paired auth token is not — see note above.
  twilio_subaccount_sid text,
  whatsapp_sender_sid text,
  -- Set on status = 'failed', e.g. "display name rejected by Meta".
  error_reason text,
  connected_at timestamptz,
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one ACTIVE connection per tenant, without forbidding history: a
-- tenant can have any number of disconnected/failed rows from past attempts,
-- but only one row that isn't in a terminal state at a time.
create unique index if not exists whatsapp_connections_one_active_per_tenant
  on public.whatsapp_connections (tenant_id)
  where status not in ('disconnected', 'failed');

-- Two different tenants' active connections should never claim the same real
-- phone number — same spirit as tenants.whatsapp_number's unique constraint.
create unique index if not exists whatsapp_connections_phone_number_active_idx
  on public.whatsapp_connections (phone_number)
  where phone_number is not null and status not in ('disconnected', 'failed');

create index if not exists whatsapp_connections_tenant_id_idx
  on public.whatsapp_connections (tenant_id, created_at desc);

drop trigger if exists set_updated_at on public.whatsapp_connections;
create trigger set_updated_at before update on public.whatsapp_connections
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Security model.
--
-- The base table grants NO access to `anon`/`authenticated` at all — RLS is
-- enabled with zero policies for those roles, which is a default-deny, not
-- an oversight — plus an explicit revoke as defense-in-depth (RLS-enabled-
-- with-no-policies already returns zero rows to those roles regardless of
-- table-level grants; the revoke means a policy added carelessly later still
-- isn't enough by itself to expose anything). Only `service_role` (which
-- bypasses RLS entirely, same as every other admin-client write already in
-- this codebase — see getAdminClient() in src/lib/public-lead-server.ts) can
-- ever touch this table directly.
--
-- Deliberately NOT exposing a tenant-facing Postgres view on top of this
-- table (an earlier draft of this migration did, and was corrected): a view
-- owned by a role with BYPASSRLS bypasses this table's RLS by default, which
-- is exactly Supabase's own "Security Definer View" linter warning — a
-- fragile pattern where the view's hand-written filter is the *only* thing
-- standing between a tenant and every column, including whatever secret
-- column lands here later, and that filter can be silently weakened by
-- anyone who edits the view afterward. Nothing else in this codebase filters
-- data via a database view either — getMyTenant, public-lead-server.ts, etc.
-- all shape what a client receives in TypeScript server functions instead.
-- The same convention applies here: a future getMyWhatsappConnection server
-- function (next phase, not this migration) will use the admin client and
-- return only an explicit, hand-picked subset of fields — status, phone
-- number, error reason, connected_at — never the whole row.
-- ---------------------------------------------------------------------------
alter table public.whatsapp_connections enable row level security;
revoke all on public.whatsapp_connections from anon, authenticated;
