-- FrontDesk core schema: tenants, price sheet, leads.
-- Run this once in the Supabase SQL editor (or `supabase db push`) on
-- FrontDesk's own project. Safe to re-run — every statement is idempotent.

-- ---------------------------------------------------------------------------
-- tenants: one row per business, owned by the auth.users row that signed up.
-- ---------------------------------------------------------------------------
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  name text not null default 'My Business',
  slug text not null unique,
  trade text not null default '',
  phone text not null default '',
  email text not null default '',
  address text not null default '',
  area text not null default '',
  hours text not null default '',
  currency text not null default 'USD' check (currency in ('USD', 'MXN', 'CAD')),
  tax_rate numeric not null default 0,
  calendar_link text not null default '',
  payment_terms text not null default '',
  warranty_terms text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- price_sheet_items: the ONE price sheet, used both for the dashboard's
-- editable table and as the AI's pricing input (estimate-server.ts). This
-- replaces the two disconnected shapes that used to exist in mock-data.ts /
-- estimate-server.ts.
-- ---------------------------------------------------------------------------
create table if not exists public.price_sheet_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  task text not null,
  category text not null default 'General',
  keywords text[] not null default '{}',
  pricing_type text not null default 'flat' check (pricing_type in ('flat', 'hourly', 'range')),
  price_min numeric not null default 0,
  price_max numeric not null default 0,
  hours numeric not null default 0,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists price_sheet_items_tenant_id_idx on public.price_sheet_items (tenant_id, sort_order);

-- ---------------------------------------------------------------------------
-- leads: one row per customer inquiry.
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  customer_name text not null default '',
  phone text not null default '',
  address text not null default '',
  channel text not null default 'Widget' check (channel in ('Widget', 'Quote link', 'Shared link', 'WhatsApp')),
  status text not null default 'new' check (status in ('new', 'quoted', 'booked', 'won', 'lost')),
  photo_url text,
  problem text not null default '',
  diagnosis text not null default '',
  confidence text check (confidence in ('High', 'Medium', 'Low')),
  -- Snapshot of the line items exactly as the AI first proposed them (set
  -- once, at lead creation, never touched again). Comparing the live
  -- lead_line_items rows against this tells the dashboard "nothing to
  -- correct here" apart from "shop owner edited this" without a separate
  -- audit table or per-row original columns.
  ai_line_items_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists leads_tenant_id_idx on public.leads (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- lead_line_items: the priced work on a lead.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_line_items (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  description text not null default '',
  qty numeric not null default 1,
  unit text not null default 'job',
  rate numeric not null default 0,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lead_line_items_lead_id_idx on public.lead_line_items (lead_id, sort_order);

-- ---------------------------------------------------------------------------
-- lead_messages: the customer-facing thread on a lead.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  role text not null check (role in ('customer', 'assistant')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists lead_messages_lead_id_idx on public.lead_messages (lead_id, created_at);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.tenants;
create trigger set_updated_at before update on public.tenants
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.price_sheet_items;
create trigger set_updated_at before update on public.price_sheet_items
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.leads;
create trigger set_updated_at before update on public.leads
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.lead_line_items;
create trigger set_updated_at before update on public.lead_line_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-create a tenant row the moment someone signs up, so the dashboard has
-- somewhere real to read/write from immediately — without this, every new
-- signup would hit a "no tenant yet" wall before the onboarding wizard
-- (still unbuilt) exists to create one by hand.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  base_slug text;
  final_slug text;
  suffix int := 0;
begin
  base_slug := coalesce(nullif(regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9]+', '-', 'g'), ''), 'business');
  final_slug := base_slug;
  while exists (select 1 from public.tenants where slug = final_slug) loop
    suffix := suffix + 1;
    final_slug := base_slug || '-' || suffix::text;
  end loop;

  insert into public.tenants (user_id, email, slug)
  values (new.id, coalesce(new.email, ''), final_slug);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security: every table is scoped to the signed-in user's own
-- tenant. No cross-tenant reads or writes are possible even if a client bug
-- tried to request someone else's id.
-- ---------------------------------------------------------------------------
alter table public.tenants enable row level security;
alter table public.price_sheet_items enable row level security;
alter table public.leads enable row level security;
alter table public.lead_line_items enable row level security;
alter table public.lead_messages enable row level security;

drop policy if exists "tenants: owner full access" on public.tenants;
create policy "tenants: owner full access" on public.tenants
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "price_sheet_items: owner full access" on public.price_sheet_items;
create policy "price_sheet_items: owner full access" on public.price_sheet_items
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

drop policy if exists "leads: owner full access" on public.leads;
create policy "leads: owner full access" on public.leads
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

drop policy if exists "lead_line_items: owner full access" on public.lead_line_items;
create policy "lead_line_items: owner full access" on public.lead_line_items
  for all using (
    exists (
      select 1 from public.leads l
      join public.tenants t on t.id = l.tenant_id
      where l.id = lead_id and t.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.leads l
      join public.tenants t on t.id = l.tenant_id
      where l.id = lead_id and t.user_id = auth.uid()
    )
  );

drop policy if exists "lead_messages: owner full access" on public.lead_messages;
create policy "lead_messages: owner full access" on public.lead_messages
  for all using (
    exists (
      select 1 from public.leads l
      join public.tenants t on t.id = l.tenant_id
      where l.id = lead_id and t.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.leads l
      join public.tenants t on t.id = l.tenant_id
      where l.id = lead_id and t.user_id = auth.uid()
    )
  );
