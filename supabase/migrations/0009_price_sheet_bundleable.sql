-- Generic price-sheet capability: marks an item as "flat/quick-fix" style —
-- if a single visit needs more than one thing matching the same bundleable
-- item, it should be charged once, not once per issue. Not specific to any
-- one tenant/business; the estimate prompt (estimate-server.ts) is what
-- actually uses this to avoid double-counting.
--
-- Safe to re-run.

alter table public.price_sheet_items
  add column if not exists bundleable boolean not null default false;
