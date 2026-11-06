-- Gives tenant_ai_usage a `kind` dimension, mirroring the design its own
-- sibling table (tenant_ip_usage, same migration file, 0018) already
-- has — rather than inventing a new rate-limiting mechanism, this
-- applies the one that table already uses to this one.
--
-- Why this is needed: the 2026-11-06 security audit found three AI
-- classifier functions (classifyFollowUpIntent, classifyBroadServiceInquiry,
-- classifyFollowUpPhotoIntent) rely only on the in-memory, per-instance
-- withinRateLimit() counter — not reliable across Vercel's concurrent
-- serverless instances. The fix is to give them the same durable,
-- database-backed ceiling getQuoteEstimate/getFollowUpAnswer already
-- have (enforceTenantAiLimit) — but tenant_ai_usage currently has no
-- `kind` column, so simply reusing it unmodified would make these three
-- classifiers (called on every inbound follow-up message, far more
-- often than a full quote) share the exact same 300/day budget as real
-- quote generation, risking a busy tenant's classifier traffic starving
-- their own legitimate quoting later the same day. A separate `kind`
-- bucket avoids that while still using the identical, already-proven
-- atomic-increment mechanism.
--
-- Not applied by this session — same gate as every other migration.
--
-- Wrapped in an explicit transaction below, added after this session's
-- own pre-commit review found a confirmed failure window: applied as
-- separate, auto-committing statements against a live database, there
-- is a real gap between the primary key widening to (tenant_id, kind)
-- and the 3-arg increment_tenant_ai_usage overload replacing the 2-arg
-- one. Reproduced directly against a disposable Postgres instance:
--   - calling the OLD 2-arg function after the PK widens but before the
--     function is replaced fails with "there is no unique or exclusion
--     constraint matching the ON CONFLICT specification"
--   - once both overloads briefly coexist, the exact 2-named-argument
--     call shape every pre-existing caller uses (estimate-server.ts's
--     two call sites, profile-generation-server.ts's
--     enforceProfileGenerationAiLimit) becomes genuinely ambiguous:
--     "function ... is not unique ... Could not choose a best
--     candidate function"
-- Every statement below is ordinary transactional DDL (ALTER TABLE,
-- CREATE OR REPLACE FUNCTION, REVOKE/GRANT, DROP FUNCTION) — none of
-- these are on Postgres's short list of things that cannot run inside a
-- transaction block (CREATE/DROP DATABASE, CREATE/DROP TABLESPACE,
-- concurrent index operations, VACUUM, ALTER SYSTEM, an enum's ADD
-- VALUE used in the same transaction). Wrapping the whole file in
-- BEGIN/COMMIT makes every change below atomic: no concurrent session
-- can ever observe the new primary key with the old function still
-- live, or either function overload alone — only the fully-applied end
-- state, the instant this commits. If any statement fails, nothing
-- below applies.

begin;

alter table public.tenant_ai_usage add column if not exists kind text not null default 'quote';
alter table public.tenant_ai_usage drop constraint if exists tenant_ai_usage_kind_check;
alter table public.tenant_ai_usage add constraint tenant_ai_usage_kind_check check (kind in ('quote', 'classifier'));

-- Primary key was (tenant_id) alone; widen to (tenant_id, kind) so the
-- two buckets are independent rows, not one shared counter.
alter table public.tenant_ai_usage drop constraint if exists tenant_ai_usage_pkey;
alter table public.tenant_ai_usage add primary key (tenant_id, kind);

-- Same atomic reset-or-increment shape as before, with p_kind added.
-- Defaulted to 'quote' so this remains a drop-in replacement for every
-- existing 2-argument caller — getQuoteEstimate/getFollowUpAnswer
-- (which now pass 'quote' explicitly, for clarity, not because the
-- default wouldn't otherwise cover it) AND
-- enforceProfileGenerationAiLimit (profile-generation-server.ts, which
-- deliberately keeps passing only 2 arguments, continuing to share the
-- 'quote' bucket on purpose — see that file's own comment).
create or replace function public.increment_tenant_ai_usage(p_tenant_id uuid, p_window_seconds int, p_kind text default 'quote')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.tenant_ai_usage (tenant_id, kind, window_start, count)
  values (p_tenant_id, p_kind, now(), 1)
  on conflict (tenant_id, kind) do update
    set count = case
          when tenant_ai_usage.window_start < now() - (p_window_seconds || ' seconds')::interval
            then 1
          else tenant_ai_usage.count + 1
        end,
        window_start = case
          when tenant_ai_usage.window_start < now() - (p_window_seconds || ' seconds')::interval
            then now()
          else tenant_ai_usage.window_start
        end
  returning count into v_count;
  return v_count;
end;
$$;

revoke all on function public.increment_tenant_ai_usage(uuid, int, text) from public, anon, authenticated;
grant execute on function public.increment_tenant_ai_usage(uuid, int, text) to service_role;

-- The old 2-argument signature is now superseded by the 3-argument one
-- above (same name, p_kind defaulted) — drop it explicitly so there
-- isn't a stale overload left behind that nothing calls. Dropping it in
-- the SAME transaction as creating its replacement above is exactly
-- what makes the transition atomic — no session, ever, sees both
-- overloads coexisting or neither existing.
drop function if exists public.increment_tenant_ai_usage(uuid, int);

commit;
