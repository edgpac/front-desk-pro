-- Closes two lower-severity, known gaps flagged by the earlier foundation
-- audit but not yet fixed:
--
-- 1. createLead/finalizeLeadWithQuote (public-lead-server.ts) each did the
--    `leads` write and the `lead_line_items` write as two separate,
--    non-transactional requests. If the second failed after the first
--    committed, the customer saw an error (and likely retried), while the
--    business was left with a real lead already in their inbox showing
--    zero line items — not lost data, but a silently inconsistent,
--    broken-looking lead. Fixed by moving both writes into one
--    SECURITY DEFINER function each, so they commit or roll back together
--    in a single transaction — same proven shape as 0017/0018's rate-limit
--    RPCs.
--
-- 2. handleInboundWhatsAppMessage's (whatsapp-conversation-server.ts)
--    "find or create a lead" logic reads for an open lead, then later
--    creates a new one if none was found — a classic check-then-act race.
--    Two inbound messages for the same (tenant, phone) arriving close
--    together (realistic: the AI round-trip between the read and the
--    eventual write takes a few seconds, long enough for an impatient
--    customer to send a second message) can both read "no open lead" and
--    both create one, producing two leads for what was meant to be one
--    conversation. A plain unique constraint can't express "only one
--    *open* lead, where open means created within a rolling 48h window" —
--    so this uses a short-lived advisory claim instead: a tiny mutex table
--    with one row per (tenant, phone), inserted right before a new lead is
--    created and removed right after. A second concurrent request that
--    can't acquire the claim waits briefly for the first one's lead to
--    appear and appends to it instead of creating a duplicate; if nothing
--    appears within that bound, it proceeds exactly as today (no worse
--    than the pre-fix behavior). `p_stale_seconds` bounds how long a claim
--    can block a *later, genuinely new* conversation if a crash ever left
--    one unreleased.
--
-- Safe to re-run.

create or replace function public.create_lead_with_line_items(
  p_tenant_id uuid,
  p_customer_name text,
  p_phone text,
  p_address text,
  p_channel text,
  p_photo_url text,
  p_problem text,
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
  v_lead_id uuid;
begin
  insert into leads (
    tenant_id, customer_name, phone, address, channel, photo_url,
    problem, diagnosis, confidence, ai_line_items_snapshot,
    status, flag_type, flag_reason
  )
  values (
    p_tenant_id, p_customer_name, p_phone, p_address, p_channel, p_photo_url,
    p_problem, p_diagnosis, p_confidence, p_ai_line_items_snapshot,
    coalesce(p_status, 'new'), p_flag_type, p_flag_reason
  )
  returning id into v_lead_id;

  if p_line_items is not null and jsonb_array_length(p_line_items) > 0 then
    insert into lead_line_items (lead_id, description, qty, unit, rate, sort_order)
    select
      v_lead_id,
      item ->> 'description',
      (item ->> 'qty')::numeric,
      item ->> 'unit',
      (item ->> 'rate')::numeric,
      (ord - 1)::int
    from jsonb_array_elements(p_line_items) with ordinality as t(item, ord);
  end if;

  return v_lead_id;
end;
$$;

revoke all on function public.create_lead_with_line_items(
  uuid, text, text, text, text, text, text, text, text, jsonb, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.create_lead_with_line_items(
  uuid, text, text, text, text, text, text, text, text, jsonb, text, text, text, jsonb
) to service_role;

-- Mirrors finalizeLeadWithQuote's exact semantics: an UPDATE scoped by both
-- id AND tenant_id (the P0 tenant-ownership fix from earlier this session —
-- preserved here, not weakened), returning null when zero rows matched
-- (wrong tenant or nonexistent id) so the caller can keep throwing the same
-- generic "intake unavailable" message it already does. p_status/
-- p_flag_type/p_flag_reason being NULL means "don't touch these columns" —
-- matching the original code's conditional spread, which only ever added
-- flag fields, never explicitly cleared them.
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
    status = coalesce(p_status, status),
    flag_type = case when p_status is not null then p_flag_type else flag_type end,
    flag_reason = case when p_status is not null then p_flag_reason else flag_reason end,
    updated_at = now()
  where id = p_lead_id and tenant_id = p_tenant_id
  returning id into v_updated_id;

  if v_updated_id is null then
    return null;
  end if;

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

-- WhatsApp duplicate-lead race mitigation (see header comment, item 2).
create table if not exists public.whatsapp_lead_claims (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  phone text not null,
  claimed_at timestamptz not null default now(),
  primary key (tenant_id, phone)
);

alter table public.whatsapp_lead_claims enable row level security;
revoke all on public.whatsapp_lead_claims from anon, authenticated;

create or replace function public.claim_whatsapp_lead_slot(
  p_tenant_id uuid,
  p_phone text,
  p_stale_seconds int default 120
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean := false;
begin
  insert into whatsapp_lead_claims (tenant_id, phone, claimed_at)
  values (p_tenant_id, p_phone, now())
  on conflict (tenant_id, phone) do update
    set claimed_at = now()
    where whatsapp_lead_claims.claimed_at < now() - (p_stale_seconds || ' seconds')::interval
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

revoke all on function public.claim_whatsapp_lead_slot(uuid, text, int) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_lead_slot(uuid, text, int) to service_role;

create or replace function public.release_whatsapp_lead_slot(p_tenant_id uuid, p_phone text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from whatsapp_lead_claims where tenant_id = p_tenant_id and phone = p_phone;
end;
$$;

revoke all on function public.release_whatsapp_lead_slot(uuid, text) from public, anon, authenticated;
grant execute on function public.release_whatsapp_lead_slot(uuid, text) to service_role;
