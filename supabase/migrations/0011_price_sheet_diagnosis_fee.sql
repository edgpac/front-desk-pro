-- Per-row diagnosis/assessment fee, independent of the tenant-wide
-- serviceCallFee scalar. Both columns null by default: a row with no
-- diagnosis fee configured falls back to exactly today's behavior (the
-- tenant-wide fee) — zero behavior change for any existing row until a
-- business explicitly opts a service into this.
--
-- Same shape/risk profile as 0009's bundleable column and 0010's
-- materials_policy column: additive, nullable/defaulted, no data migration
-- needed for existing rows.

alter table public.price_sheet_items
  add column if not exists diagnosis_pricing_type text
    check (diagnosis_pricing_type in ('flat', 'hourly')),
  add column if not exists diagnosis_fee numeric;

-- Both columns must be set together or both left null — never one without
-- the other, which would be an ambiguous half-configured state.
alter table public.price_sheet_items
  add constraint price_sheet_items_diagnosis_fee_pair
    check ((diagnosis_pricing_type is null) = (diagnosis_fee is null));
