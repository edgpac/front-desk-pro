-- Minimal flagged-leads slice (see ROADMAP.md Phase 1.5) — the AI defers to
-- a human instead of guessing when it can't safely act on its own:
-- conflicting/ambiguous information, or (the case that prompted this
-- migration) a request that doesn't match anything on the tenant's own
-- price sheet, so no price should ever be invented for it.
--
-- Deliberately NOT the full capabilities/field-notes decision engine from
-- the dormant design — no new table, no capabilities dependency. Just
-- enough for the AI to say "let me pass this to the team" and have that
-- actually land somewhere the owner can see and act on.

alter table public.leads
  drop constraint if exists leads_status_check;

alter table public.leads
  add constraint leads_status_check
  check (status in ('new', 'quoted', 'booked', 'won', 'lost', 'flagged'));

alter table public.leads
  add column if not exists flag_type text
    check (flag_type in ('conflicting_information', 'needs_human_review', 'outside_service_scope')),
  add column if not exists flag_reason text;

-- Safety: flag_type should only ever be set on a flagged lead, and never
-- linger on a lead that's since moved to a normal status.
alter table public.leads
  drop constraint if exists leads_flag_type_requires_flagged_status;

alter table public.leads
  add constraint leads_flag_type_requires_flagged_status
  check (flag_type is null or status = 'flagged');
