-- Widens tenants.currency from the original 3-value set (USD, MXN, CAD)
-- to the shared list in src/lib/mock-data.ts's SUPPORTED_CURRENCIES.
-- Owners can already pick any of these from the Business Settings
-- dropdown once this is applied; the price-formatting code
-- (money()/formatPrice() in mock-data.ts) is already currency-agnostic
-- (Intl.NumberFormat with a currency code, not a hardcoded "$"), and a
-- repo-wide search before writing this confirmed nothing else branches
-- on a specific currency literal — so this is a pure allow-list widen,
-- not a behavior change anywhere else.
--
-- The original CHECK was an unnamed, column-level constraint in
-- 0001_init.sql, so Postgres auto-generated its name. Rather than
-- assume that name, this looks it up from pg_constraint by table and
-- column before dropping it — safe to re-run (if it's already been
-- widened, the lookup finds the new constraint, whose definition
-- already matches, and re-adding a constraint with the same name and
-- definition is a safe no-op caught by the exception handler below).
--
-- Not applied by this phase of work — prepared for review only.

do $$
declare
  v_constraint_name text;
begin
  select con.conname into v_constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_attribute att on att.attrelid = rel.oid and att.attnum = any (con.conkey)
  where rel.relname = 'tenants'
    and con.contype = 'c'
    and att.attname = 'currency'
  limit 1;

  if v_constraint_name is not null then
    execute format('alter table public.tenants drop constraint %I', v_constraint_name);
  end if;

  alter table public.tenants
    add constraint tenants_currency_check
    check (currency in ('USD', 'MXN', 'CAD', 'EUR', 'GBP', 'AUD', 'BRL', 'COP'));
exception
  when duplicate_object then null;
end $$;
