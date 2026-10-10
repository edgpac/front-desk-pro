-- Coexistence blind spot, found via real live traffic (2026-10-10): the
-- bot and the business owner's own WhatsApp Business App both receive the
-- same inbound messages on a connected number, but the bot has no way to
-- know a human already personally replied — it only checks whether it has
-- its own bot-created lead for that phone in the last 48h. A customer the
-- owner is already texting personally (no bot lead ever created, since the
-- owner handled it directly) still gets the canned "Thanks for reaching
-- out..." greeting injected into the middle of their real conversation.
--
-- Meta's Cloud API has a dedicated mechanism for exactly this: the
-- `smb_message_echoes` webhook field, confirmed against Meta's own
-- developer docs (developers.facebook.com/documentation/business-
-- messaging/whatsapp/embedded-signup/onboarding-business-app-users/) —
-- delivers an echo of every message the owner sends via the connected
-- WhatsApp Business App. This table records the most recent echo per
-- (tenant, customer phone); the webhook route checks it before letting the
-- bot reply, and suppresses the automated reply if a human has been
-- active on that conversation recently.
--
-- Requires a one-time manual step outside this migration: subscribing to
-- `smb_message_echoes` in the Meta App Dashboard (WhatsApp > Configuration
-- > Webhook fields) — Meta does not send this field by default even once
-- the webhook route can parse it.
--
-- Safe to re-run.

create table if not exists public.whatsapp_human_takeovers (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  phone text not null,
  last_echo_at timestamptz not null default now(),
  primary key (tenant_id, phone)
);

alter table public.whatsapp_human_takeovers enable row level security;
revoke all on public.whatsapp_human_takeovers from anon, authenticated;
