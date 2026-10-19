-- Adds minimal operational evidence of the pre-connect acknowledgment
-- shown in ConnectWhatsAppMeta.tsx's dialog (WhatsAppSetupGuide.tsx) to
-- the EXISTING whatsapp_connections table — deliberately not a new
-- dedicated whatsapp_consents table (that remains a future idea, not
-- approved, per ROADMAP.md's own "Future Database Tables" section).
--
-- What this IS: a timestamped record that SOME version of the notice was
-- acknowledged immediately before this specific connection completed.
-- What this is NOT, and must never be represented as: a complete legal
-- consent record. It doesn't store the full notice text, doesn't record
-- an IP or user agent, and says nothing about what the business told its
-- own customers. consent_notice_version exists specifically so a future
-- reader can tell WHICH version of the notice text was shown, not just
-- that something was — bump WHATSAPP_CONSENT_NOTICE_VERSION in
-- WhatsAppSetupGuide.tsx whenever the notice copy changes materially.
--
-- Both columns nullable — a pre-existing connection row (created before
-- this migration) legitimately has neither, and that absence is itself
-- meaningful (no acknowledgment was ever captured for it), not an error
-- to backfill or guess at.
--
-- Safe to re-run.

alter table public.whatsapp_connections
  add column if not exists consent_notice_version text,
  add column if not exists consent_acknowledged_at timestamptz;
