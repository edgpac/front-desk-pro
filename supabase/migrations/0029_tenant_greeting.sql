-- Per-tenant AI-greeting configuration for the WhatsApp assistant's
-- first-contact message (see whatsapp-conversation-server.ts's
-- resolveFirstContactGreeting). greeting_mode picks between the
-- recommended localized default (computed in code, not stored here) and
-- the tenant's own custom text per language. Length is capped to match
-- the server-side validation in tenant-server.ts's
-- updateMyGreetingSettings (MAX_CUSTOM_GREETING_LENGTH) — defense in
-- depth against any future direct-SQL write bypassing that check.
--
-- Nullable custom columns, 'recommended' default — zero behavior change
-- for any existing row until an owner explicitly opts into 'custom' and
-- saves text. Same additive shape/risk profile as 0016's ai_notes column.
-- No new RLS policy needed — the existing "tenants: owner full access"
-- policy (0001_init.sql) already covers every column on this table.
-- Safe to re-run.

alter table public.tenants
  add column if not exists greeting_mode text not null default 'recommended'
    check (greeting_mode in ('recommended', 'custom')),
  add column if not exists custom_greeting_en text
    check (custom_greeting_en is null or length(custom_greeting_en) <= 300),
  add column if not exists custom_greeting_es text
    check (custom_greeting_es is null or length(custom_greeting_es) <= 300);
