-- Extends leads.flag_type with 'partially_priced' (P2 mixed-pricing) — a
-- multi-issue request where at least one described issue matched and was
-- priced from the price sheet, and at least one other issue was deferred
-- (estimate-server.ts's hasPartiallyDeferredWork). Distinct from
-- pending_negotiated_price, which means nothing at all was priced —
-- partially_priced means something WAS priced (a real, correct line-item
-- total exists) and something else, separately, is still pending. Reuses
-- the same flagged-lead mechanism 0008/0013 already built — same table,
-- same columns, no new persistence mechanism, no new column.
--
-- Additive only: existing flag_type values, existing leads, and existing
-- statuses are all preserved untouched. Existing leads are never
-- reclassified — this value is only ever written by new AI responses going
-- forward, at creation/finalization time. The constraint is now explicitly
-- named (leads_flag_type_check, set in 0013), so this drops and re-adds it
-- directly rather than needing 0013's introspection dance.

alter table public.leads
  drop constraint leads_flag_type_check;

alter table public.leads
  add constraint leads_flag_type_check
  check (flag_type in ('conflicting_information', 'needs_human_review', 'outside_service_scope', 'pending_negotiated_price', 'partially_priced'));
