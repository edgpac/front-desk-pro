-- Tenant-level mode for the generic service-call/diagnostic fee. Additive
-- only: existing tenants default to 'fixed' (today's behavior, unchanged).
-- service_call_fee itself is untouched — still required and used when mode
-- is 'fixed'; simply irrelevant to the AI when mode is 'negotiated'.

alter table public.tenants
  add column if not exists service_call_fee_mode text
    not null default 'fixed'
    check (service_call_fee_mode in ('fixed', 'negotiated'));
