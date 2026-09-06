-- Adds what the WhatsApp intake channel needs on top of 0001_init.sql.
-- Run this in the Supabase SQL editor the same way as the first migration.
-- Safe to re-run.

-- The number a tenant's customers text. For now this is one shared
-- FrontDesk-owned Twilio WhatsApp number per tenant slot (see
-- src/routes/api.whatsapp.webhook.tsx) — a business connecting their OWN
-- WhatsApp number via Meta's Embedded Signup is a separate, harder piece
-- for later (still needs real Meta business verification).
alter table public.tenants
  add column if not exists whatsapp_number text unique;

create index if not exists tenants_whatsapp_number_idx on public.tenants (whatsapp_number);

-- estimate-server.ts's getQuoteEstimate needs these to price a job at all —
-- they were never captured anywhere (no onboarding UI collects them yet),
-- but the WhatsApp webhook calling real AI pricing on a tenant's behalf
-- can't work without them.
--
-- 125/89 are bootstrap values for a brand-new tenant row, not a permanent
-- fallback baked into the app: there is no separate runtime default anywhere
-- in the real pricing path (see tenant-server.ts's updateMyTenant) — the
-- column itself is the only source of truth, so once a business saves their
-- own numbers from Settings, that's what every quote uses from then on.
alter table public.tenants
  add column if not exists labor_rate numeric not null default 125,
  add column if not exists service_call_fee numeric not null default 89;
