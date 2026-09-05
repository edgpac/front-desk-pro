import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Tenant } from "@/lib/mock-data";

type TenantRow = {
  name: string;
  slug: string;
  trade: string;
  phone: string;
  email: string;
  address: string;
  area: string;
  hours: string;
  currency: "USD" | "MXN" | "CAD";
  tax_rate: number;
  calendar_link: string;
  payment_terms: string;
  warranty_terms: string;
};

function toTenant(row: TenantRow): Tenant {
  return {
    name: row.name,
    slug: row.slug,
    trade: row.trade,
    phone: row.phone,
    email: row.email,
    address: row.address,
    area: row.area,
    hours: row.hours,
    currency: row.currency,
    calendarLink: row.calendar_link,
    paymentTerms: row.payment_terms,
    warrantyTerms: row.warranty_terms,
    taxRate: row.tax_rate,
    brandColor: "#B4531F",
  };
}

// Every signed-in user gets a tenant row automatically (see the
// handle_new_user trigger in supabase/migrations/0001_init.sql), so this
// should always find exactly one row.
export const getMyTenant = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Tenant> => {
    const { data, error } = await context.supabase
      .from("tenants")
      .select("name, slug, trade, phone, email, address, area, hours, currency, tax_rate, calendar_link, payment_terms, warranty_terms")
      .eq("user_id", context.userId)
      .single();
    if (error) throw new Error(`Could not load business settings: ${error.message}`);
    return toTenant(data as TenantRow);
  });

export const updateMyTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      name: string;
      trade: string;
      phone: string;
      email: string;
      address: string;
      area: string;
      hours: string;
      currency: "USD" | "MXN" | "CAD";
      taxRate: number;
      calendarLink: string;
      paymentTerms: string;
      warrantyTerms: string;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("tenants")
      .update({
        name: data.name,
        trade: data.trade,
        phone: data.phone,
        email: data.email,
        address: data.address,
        area: data.area,
        hours: data.hours,
        currency: data.currency,
        tax_rate: data.taxRate,
        calendar_link: data.calendarLink,
        payment_terms: data.paymentTerms,
        warranty_terms: data.warrantyTerms,
      })
      .eq("user_id", context.userId);
    if (error) throw new Error(`Could not save business settings: ${error.message}`);
    return { ok: true as const };
  });
