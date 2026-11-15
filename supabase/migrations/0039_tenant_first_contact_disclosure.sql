-- Per-tenant switch for the privacy/AI + STOP/CANCELAR notice on the
-- WhatsApp first-contact greeting (whatsapp-conversation-server.ts's
-- resolveFirstContactGreeting / FIRST_CONTACT_DISCLOSURE). Off for every
-- tenant: the first message is just the greeting, and the notice is sent
-- on request ("privacy", "privacidad", "aviso de privacidad" — see
-- handlePrivacyInfoRequest). A tenant can switch it back on
-- by setting this to true. STOP/CANCELAR opt-out handling is unaffected.
--
-- Additive, non-null with a default, covered by the existing "tenants:
-- owner full access" policy (0001_init.sql). Must be applied BEFORE the
-- code that selects this column deploys. Safe to re-run.

alter table public.tenants
  add column if not exists first_contact_disclosure boolean not null default false;

alter table public.tenants
  alter column first_contact_disclosure set default false;

update public.tenants set first_contact_disclosure = false where first_contact_disclosure;
