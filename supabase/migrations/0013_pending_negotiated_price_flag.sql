-- Extends leads.flag_type with 'pending_negotiated_price' — the AI
-- correctly determined a service-call/diagnostic fee applies (this
-- tenant's service_call_fee_mode is 'negotiated') but the exact amount is
-- deferred to a phone call, with nothing else priced in the same request
-- (estimate-server.ts's hasNoPricedWork). This is NOT a genuine $0 price —
-- it means no price was determined at all, and must never be displayed or
-- persisted as one. Reuses the exact flagged-lead mechanism 0008 already
-- built for "the AI defers to a human instead of guessing" — same
-- table, same columns, no new persistence mechanism.
--
-- Additive only: existing flag_type values, existing leads, and existing
-- statuses are all preserved untouched. The original inline column CHECK
-- constraint from 0008 was never given an explicit name, so this looks it
-- up by introspection rather than guessing — safe even if Postgres's
-- default naming convention turns out different than expected.

do $$
declare
  found_constraint text;
begin
  select con.conname into found_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_attribute att on att.attrelid = rel.oid and att.attnum = any(con.conkey)
  where rel.relname = 'leads'
    and att.attname = 'flag_type'
    and con.contype = 'c';

  if found_constraint is not null then
    execute format('alter table public.leads drop constraint %I', found_constraint);
  end if;
end $$;

alter table public.leads
  add constraint leads_flag_type_check
  check (flag_type in ('conflicting_information', 'needs_human_review', 'outside_service_scope', 'pending_negotiated_price'));
