-- Per-row free-text guidance from the business owner for the AI to follow
-- when handling that specific service — e.g. "always needs an in-person
-- look before quoting, don't estimate from a photo alone." Deliberately one
-- flexible text field rather than a new structured flag: this product
-- covers arbitrary trades/service businesses, and a business-specific
-- operating quirk for one service rarely generalizes into a checkbox every
-- other business would also need.
--
-- Nullable, no default beyond null — zero behavior change for any existing
-- row until an owner explicitly writes one. Same additive shape/risk
-- profile as 0009's bundleable, 0010's materials_policy, and 0011's
-- diagnosis_fee columns. Safe to re-run.

alter table public.price_sheet_items
  add column if not exists ai_notes text;
