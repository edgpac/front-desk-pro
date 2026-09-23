-- Per-service materials/parts policy — business-configured, never AI-inferred.
-- Replaces the earlier `materials_included: boolean` design (never shipped,
-- design-only) with a three-value enum: a boolean couldn't distinguish
-- "customer must already have the part" from "we'll price it after
-- inspection," and those need different customer-facing wording, not just
-- different degrees of one fact.
--
-- Default 'included' matches every existing row's current, unchanged
-- behavior — no existing tenant's estimates change because this migration
-- is applied. Safe to re-run.

alter table public.price_sheet_items
  add column if not exists materials_policy text
    not null default 'included'
    check (materials_policy in ('included', 'customer_pays_receipt', 'confirmed_after_inspection'));
