-- Adds the two columns completeMetaWhatsAppSignup (meta-whatsapp-server.ts)
-- already writes to but were never actually added in a tracked migration --
-- found via a direct schema audit, 2026-09-14. Without this, the very first
-- successful Embedded Signup completion would fail at the database insert.
--
-- Also adds the active-per-meta_phone_number_id uniqueness constraint the
-- Meta inbound webhook route depends on for safe tenant routing -- the same
-- pattern 0003 already uses for `phone_number`, just applied to the column
-- Meta-side routing actually keys on. Safe to re-run.

alter table public.whatsapp_connections
  add column if not exists meta_system_user_token text,
  add column if not exists display_phone_number text;

-- Two different tenants' active connections should never claim the same
-- meta_phone_number_id -- this is the routing key the Meta webhook resolves
-- a tenant by, so a violation here would mean a message could route to the
-- wrong business. `status not in ('disconnected', 'failed')` mirrors every
-- other "active connection" index already in this table.
create unique index if not exists whatsapp_connections_meta_phone_number_id_active_idx
  on public.whatsapp_connections (meta_phone_number_id)
  where meta_phone_number_id is not null and status not in ('disconnected', 'failed');
