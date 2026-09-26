-- Durable, atomic, per-IP rate limit for the public /demo flow. The
-- existing in-memory limiter in estimate-server.ts (withinRateLimit) is a
-- module-scoped counter — reliable only within a single warm Vercel
-- serverless instance, not across concurrent instances in production, and
-- shared identically across /demo, every real tenant's widget/quote page,
-- and WhatsApp. This table gives /demo (only) its own durable budget,
-- keyed by a hashed client IP, so demo abuse can never draw down the
-- budget real tenant/WhatsApp traffic relies on.
--
-- ip_hash is a SHA-256 hash of the client IP, never the raw address.
-- `kind` distinguishes the two separately-budgeted demo actions: a fresh
-- quote submission ('quote') and a follow-up question ('followup') — a
-- visitor gets 5 of each per rolling 24 hours, tracked independently.
--
-- No application code reads this table directly except through the
-- increment_demo_usage() function below, which does the atomic check-and-
-- increment in one round trip (avoids a read-then-write race that could
-- let concurrent requests both slip under the limit).

create table if not exists public.demo_ip_usage (
  ip_hash text not null,
  kind text not null check (kind in ('quote', 'followup')),
  window_start timestamptz not null default now(),
  count int not null default 0,
  primary key (ip_hash, kind)
);

-- Zero-access RLS — same posture as every other internal/service-role-only
-- table in this schema (e.g. whatsapp_connections). Nothing here is ever
-- read or written directly by an anon/authenticated client.
alter table public.demo_ip_usage enable row level security;
revoke all on public.demo_ip_usage from anon, authenticated;

-- Atomically increments (or resets, if the window has expired) the
-- counter for a given ip_hash + kind, and returns the resulting count.
-- SECURITY DEFINER so it can be granted to service_role without granting
-- broader table access; search_path pinned per standard Postgres function
-- hardening practice.
create or replace function public.increment_demo_usage(p_ip_hash text, p_kind text, p_window_seconds int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into public.demo_ip_usage (ip_hash, kind, window_start, count)
  values (p_ip_hash, p_kind, now(), 1)
  on conflict (ip_hash, kind) do update
    set count = case
          when demo_ip_usage.window_start < now() - (p_window_seconds || ' seconds')::interval
            then 1
          else demo_ip_usage.count + 1
        end,
        window_start = case
          when demo_ip_usage.window_start < now() - (p_window_seconds || ' seconds')::interval
            then now()
          else demo_ip_usage.window_start
        end
  returning count into v_count;
  return v_count;
end;
$$;

revoke all on function public.increment_demo_usage(text, text, int) from public, anon, authenticated;
grant execute on function public.increment_demo_usage(text, text, int) to service_role;
