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
  labor_rate: number;
  service_call_fee: number;
  whatsapp_number: string | null;
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
    laborRate: row.labor_rate,
    serviceCallFee: row.service_call_fee,
    whatsappNumber: row.whatsapp_number ?? "",
    brandColor: "#B4531F",
  };
}

// The WhatsApp webhook (api.whatsapp.webhook.tsx) looks a tenant up by
// `.eq("whatsapp_number", toPhone)` where toPhone is Twilio's "From"/"To"
// with the "whatsapp:" prefix stripped — a bare E.164 number like
// "+15551234567". Normalize whatever the business types into that exact
// shape so the lookup actually matches.
export function normalizeWhatsappNumber(input: string): string {
  const trimmed = input.trim().replace(/^whatsapp:/i, "");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  // A bare 10-digit number is a US/Canada number typed without the country
  // code — everything else (11+ digits, or already had a "+") is assumed to
  // already include one.
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

// E.164 allows 8-15 digits after the leading "+". Anything shorter/longer
// than that after normalization is typo/garbage, not a real number — saving
// it anyway would leave a phantom whatsapp_number that will never match a
// real Twilio "To" and just silently blackholes that tenant's WhatsApp intake.
export function isPlausiblePhoneNumber(normalized: string): boolean {
  return /^\+\d{8,15}$/.test(normalized);
}

// Every signed-in user gets a tenant row automatically (see the
// handle_new_user trigger in supabase/migrations/0001_init.sql), so this
// should always find exactly one row.
export const getMyTenant = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Tenant> => {
    const { data, error } = await context.supabase
      .from("tenants")
      .select(
        "name, slug, trade, phone, email, address, area, hours, currency, tax_rate, calendar_link, payment_terms, warranty_terms, labor_rate, service_call_fee, whatsapp_number",
      )
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
      laborRate: number;
      serviceCallFee: number;
      whatsappNumber: string;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    if (!Number.isFinite(data.laborRate) || data.laborRate < 0) {
      throw new Error("Labor rate must be a number of 0 or more.");
    }
    if (!Number.isFinite(data.serviceCallFee) || data.serviceCallFee < 0) {
      throw new Error("Service call fee must be a number of 0 or more.");
    }

    const normalizedWhatsapp = normalizeWhatsappNumber(data.whatsappNumber);
    if (normalizedWhatsapp && !isPlausiblePhoneNumber(normalizedWhatsapp)) {
      throw new Error("That WhatsApp number doesn't look right — double-check the digits.");
    }

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
        labor_rate: data.laborRate,
        service_call_fee: data.serviceCallFee,
        whatsapp_number: normalizedWhatsapp || null,
      })
      .eq("user_id", context.userId);
    if (error) {
      // Postgres unique_violation — someone else already has this number
      // connected. Surface something a business owner can act on instead of
      // the raw "duplicate key value violates constraint tenants_..." text.
      if (error.code === "23505") {
        throw new Error("That WhatsApp number is already connected to another business.");
      }
      throw new Error(`Could not save business settings: ${error.message}`);
    }
    return { ok: true as const };
  });
