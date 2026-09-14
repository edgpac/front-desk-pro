-- Duplicate-delivery dedup for the Meta WhatsApp webhook (Stage 2D item,
-- audited in against Tel-Agent's equivalent, 2026-09-14). Meta can redeliver
-- a webhook it didn't get a fast-enough 200 for; Twilio's own webhook
-- doesn't need this the same way, so this is new, Meta-specific state, not
-- a change to the shared conversation core.
--
-- message_id is Meta's own wamid, globally unique across all of WhatsApp,
-- so it alone is enough as the primary key -- no tenant_id needed for
-- uniqueness. Insert-and-catch-conflict is the dedup check itself: a
-- second delivery of the same wamid hits the primary key and is dropped
-- before any AI call or send happens.
--
-- No pruning job yet -- this table grows unbounded. Acceptable for now
-- (one small text-plus-timestamp row per inbound message is cheap), worth
-- revisiting with a retention policy before real volume. Safe to re-run.

create table if not exists public.whatsapp_processed_messages (
  message_id text primary key,
  received_at timestamptz not null default now()
);

-- Same security model as whatsapp_connections: service-role only, no
-- client access -- this table holds no tenant-facing data but there is no
-- reason for anon/authenticated to touch it either.
alter table public.whatsapp_processed_messages enable row level security;
revoke all on public.whatsapp_processed_messages from anon, authenticated;
