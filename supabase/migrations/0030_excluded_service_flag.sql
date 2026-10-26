-- Extends leads.flag_type with 'excluded_service' — same reasoning and
-- exact same pattern as 0024's own extension for 'loop_suspected': reuses
-- the existing flagged-lead mechanism (0008/0013/0014/0024), same table,
-- same columns, no new persistence shape.
--
-- Distinguishes two previously-conflated cases that both currently share
-- 'outside_service_scope':
--   - 'outside_service_scope': nothing on the tenant's price sheet
--     reasonably covers the request at all.
--   - 'excluded_service' (new): the request matched something the
--     business DOES have priced, but the business has explicitly
--     configured it as work they won't take (tenant_capabilities, type
--     'exclusion') — see src/lib/estimate-server.ts's applyExclusionGuard,
--     which independently re-derives this via deterministic keyword
--     overlap and overrides the AI's own result if it priced the request
--     anyway. Never AI-decided alone.
--
-- Not applied by Claude — review, then apply via the Supabase SQL Editor
-- (same workflow as every prior migration this session).

alter table public.leads
  drop constraint leads_flag_type_check;

alter table public.leads
  add constraint leads_flag_type_check
  check (flag_type in ('conflicting_information', 'needs_human_review', 'outside_service_scope', 'pending_negotiated_price', 'partially_priced', 'loop_suspected', 'excluded_service'));
