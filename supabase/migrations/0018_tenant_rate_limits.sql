-- Durable, atomic, per-tenant rate limiting and AI cost ceiling for real
-- tenant traffic — the direct sibling of 0017_demo_rate_limit.sql's
-- demo_ip_usage table, extended to cover the two gaps that don't apply to
-- /demo: (1) the public lead-creation endpoints (createLead,
-- createClarifyingLead, finalizeLeadWithQuote) and getTenantForQuote have
-- no rate limit at all today, unlike /demo; (2) real tenant/WhatsApp AI
-- traffic has no durable per-tenant cost ceiling — only the same leaky,
-- per-instance, shared-with-everyone-else withinRateLimit() counter
-- 0017's own header comment already documents as unreliable across
-- concurrent Vercel instances.
--
-- Two tables, not one, because the two limits are genuinely different
-- shapes: rate limiting is scoped per (tenant, visitor IP) — a script
-- hammering one tenant's slug must never throttle a different tenant's
-- real customers — while the AI cost ceiling is scoped per tenant only,
-- with no IP dimension, since the concern there is aggregate spend
-- regardless of which visitor (or which WhatsApp customer) triggered it.
--
-- No application code reads or writes these tables yet — this migration
-- only adds the schema + the atomic increment functions, mirroring
-- 0017's own split between "add the mechanism" and "wire it up" commits.

create table if not exists public.tenant_ip_usage (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  ip_hash text not null,
  -- 'quote' covers the lead-creation endpoints (a write); 'read' covers
  -- getTenantForQuote (a read, scraping/enumeration concern, not abuse
  -- cost) — kept as a separate kind so a tighter write limit and a looser
  -- read limit can both live in this one table, same pattern as 0017's
  -- 'quote'/'followup' split.
  kind text not null check (kind in ('quote', 'read')),
  window_start timestamptz not null default now(),
  count int not null default 0,
  primary key (tenant_id, ip_hash, kind)
);

alter table public.tenant_ip_usage enable row level security;
revoke all on public.tenant_ip_usage from anon, authenticated;

create table if not exists public.tenant_ai_usage (
  tenant_id uuid not null references public.tenants (id) on delete cascade primary key,
  window_start timestamptz not null default now(),
  count int not null default 0
);

alter table public.tenant_ai_usage enable row level security;
revoke all on public.tenant_ai_usage from anon, authenticated;

-- Atomically increments (or resets, if the window has expired) the
-- counter for a given tenant_id + ip_hash + kind, and returns the
-- resulting count. Identical shape to 0017's increment_demo_usage —
-- SECURITY DEFINER so it can be granted to service_role without granting
-- broader table access; search_path pinned per standard hardening.
create or replace function public.increment_tenant_ip_usage(p_tenant_id uuid, p_ip_hash text, p_kind text, p_window_seconds int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.tenant_ip_usage (tenant_id, ip_hash, kind, window_start, count)
  values (p_tenant_id, p_ip_hash, p_kind, now(), 1)
  on conflict (tenant_id, ip_hash, kind) do update
    set count = case
          when tenant_ip_usage.window_start < now() - (p_window_seconds || ' seconds')::interval
            then 1
          else tenant_ip_usage.count + 1
        end,
        window_start = case
          when tenant_ip_usage.window_start < now() - (p_window_seconds || ' seconds')::interval
            then now()
          else tenant_ip_usage.window_start
        end
  returning count into v_count;
  return v_count;
end;
$$;

revoke all on function public.increment_tenant_ip_usage(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.increment_tenant_ip_usage(uuid, text, text, int) to service_role;

-- Same atomic reset-or-increment shape, one dimension simpler (no
-- ip_hash/kind — a single aggregate counter per tenant).
create or replace function public.increment_tenant_ai_usage(p_tenant_id uuid, p_window_seconds int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.tenant_ai_usage (tenant_id, window_start, count)
  values (p_tenant_id, now(), 1)
  on conflict (tenant_id) do update
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

revoke all on function public.increment_tenant_ai_usage(uuid, int) from public, anon, authenticated;
grant execute on function public.increment_tenant_ai_usage(uuid, int) to service_role;
