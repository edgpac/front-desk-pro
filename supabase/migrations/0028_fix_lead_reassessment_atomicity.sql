-- Fixes two confirmed defects in update_lead_with_line_items
-- (0019_lead_write_atomicity.sql), found during the 2026-10-19 Photo
-- Intelligence Priority 2 adversarial review and reproduced twice,
-- independently, against real disposable Postgres instances (not just
-- inferred from reading the SQL) — see SECURITY_REMEDIATION_TRACKER.md.
--
-- 1. Line-item duplication: calling this function a second time on an
--    already-finalized lead only ever INSERTed new line items — it never
--    removed the existing ones first, so a reassessment left BOTH the old
--    and new line items persisted. Every pre-existing caller (QuoteFlow.tsx,
--    the WhatsApp clarification-finalize path) only ever calls this once,
--    on a freshly-created lead with zero existing line items, so appending
--    was indistinguishable from replacing and this never surfaced. Fixed by
--    deleting the lead's existing line items before inserting the new set,
--    inside this same function call — the operation stays exactly as
--    atomic as before (one function call, one implicit transaction), just
--    correct.
--
-- 2. Stale flags never clearing: p_status = null previously meant "leave
--    flag_type/flag_reason/status exactly as they are," so a lead that
--    reached a fully-priced state after previously being flagged
--    pending_negotiated_price/partially_priced had no way to signal "no
--    longer deferred, clear it." Fixed by requiring the caller to always
--    state the lead's real target status/flag_type/flag_reason explicitly
--    (no more null-means-leave-alone) — see performFinalizeLeadWithQuote's
--    own updated comment (public-lead-server.ts) for the corresponding
--    caller-side change. Both existing callers pass status: "new" for the
--    normal, non-flagged case now (matching create_lead_with_line_items'
--    own coalesce(p_status, 'new') default for a brand-new lead) — not a
--    behavior change for either of them.
--
-- Protecting unrelated flags (required, not incidental): flag_type is a
-- single column shared by two genuinely different concerns — pricing
-- state (pending_negotiated_price, partially_priced), which THIS function
-- legitimately owns and transitions, and operational/safety state
-- (needs_human_review, outside_service_scope, loop_suspected,
-- conflicting_information — see 0013/0014/0024's leads_flag_type_check),
-- which it has never owned and must never clobber. The UPDATE below only
-- ever applies the caller's status/flag_type/flag_reason when the row's
-- CURRENT flag_type is null or already one of the two pricing flags —
-- any other existing flag leaves status/flag_type/flag_reason completely
-- untouched, even though diagnosis/confidence/line items still update
-- normally. This uses only the existing flag_type enum — no new column
-- needed, and no change to leads_flag_type_check itself.
--
-- Both existing callers (QuoteFlow.tsx, the clarification-finalize path)
-- are unaffected: they only ever call this on a lead with flag_type IS
-- NULL (freshly created via createClarifyingLead), so the "pricing or
-- null" condition is always true for them, and the line-item delete is a
-- no-op (zero existing rows) — net behavior change for both: none.
--
-- Same signature as before (name, parameter names, types, and order) —
-- `create or replace function` updates the body in place; no caller needs
-- to change how it invokes this RPC, only what values it passes for
-- p_status/p_flag_type/p_flag_reason (see the caller-side change above).
--
-- Deployment-ordering safety (found by a dedicated adversarial review of
-- this very migration, proven against real Postgres, not just inferred):
-- deploying this migration before the corresponding performFinalizeLeadWithQuote
-- change (public-lead-server.ts) would otherwise leave the still-live OLD
-- application code calling this function with p_status = null for the
-- normal, non-flagged case — and `status` is NOT NULL on leads, so a bare
-- `status = p_status` would throw "null value in column status violates
-- not-null constraint" for every such call until the new code deployed.
-- Fixed with `coalesce(p_status, 'new')` specifically for the status
-- column (the one NOT NULL column affected) — 'new' matches
-- create_lead_with_line_items' own existing default for a brand-new lead,
-- so this is a safe, sensible fallback, not an arbitrary one. flag_type/
-- flag_reason need no such coalesce — they're nullable, and null already
-- means exactly "no flag" under both the old and new caller. This makes
-- the migration safely deployable in EITHER order relative to the
-- application code change (confirmed: new code against this function was
-- already safe; old code against this function now is too) — no more an
-- exception to this project's usual migration-first deployment workflow.
--
-- Safe to re-run.

create or replace function public.update_lead_with_line_items(
  p_lead_id uuid,
  p_tenant_id uuid,
  p_customer_name text,
  p_phone text,
  p_diagnosis text,
  p_confidence text,
  p_ai_line_items_snapshot jsonb,
  p_status text,
  p_flag_type text,
  p_flag_reason text,
  p_line_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated_id uuid;
begin
  update leads set
    customer_name = p_customer_name,
    phone = p_phone,
    diagnosis = p_diagnosis,
    confidence = p_confidence,
    ai_line_items_snapshot = p_ai_line_items_snapshot,
    status = case
      when flag_type is null or flag_type in ('pending_negotiated_price', 'partially_priced')
      then coalesce(p_status, 'new')
      else status
    end,
    flag_type = case
      when flag_type is null or flag_type in ('pending_negotiated_price', 'partially_priced')
      then p_flag_type
      else flag_type
    end,
    flag_reason = case
      when flag_type is null or flag_type in ('pending_negotiated_price', 'partially_priced')
      then p_flag_reason
      else flag_reason
    end,
    updated_at = now()
  where id = p_lead_id and tenant_id = p_tenant_id
  returning id into v_updated_id;

  if v_updated_id is null then
    return null;
  end if;

  -- Replace, not append — the fix for defect 1. This is the ONLY
  -- behavioral addition for existing callers' common case, and it's a
  -- no-op there (zero pre-existing rows to delete).
  delete from lead_line_items where lead_id = v_updated_id;

  if p_line_items is not null and jsonb_array_length(p_line_items) > 0 then
    insert into lead_line_items (lead_id, description, qty, unit, rate, sort_order)
    select
      v_updated_id,
      item ->> 'description',
      (item ->> 'qty')::numeric,
      item ->> 'unit',
      (item ->> 'rate')::numeric,
      (ord - 1)::int
    from jsonb_array_elements(p_line_items) with ordinality as t(item, ord);
  end if;

  return v_updated_id;
end;
$$;

revoke all on function public.update_lead_with_line_items(
  uuid, uuid, text, text, text, text, jsonb, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.update_lead_with_line_items(
  uuid, uuid, text, text, text, text, jsonb, text, text, text, jsonb
) to service_role;
