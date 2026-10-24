import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  service_call_fee_mode: "fixed" | "negotiated";
  greeting_mode: string | null;
  custom_greeting_en: string | null;
  custom_greeting_es: string | null;
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
    serviceCallFeeMode: row.service_call_fee_mode,
    brandColor: "#B4531F",
    greetingMode: row.greeting_mode === "custom" ? "custom" : "recommended",
    customGreetingEn: row.custom_greeting_en,
    customGreetingEs: row.custom_greeting_es,
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
      .select(
        "name, slug, trade, phone, email, address, area, hours, currency, tax_rate, calendar_link, payment_terms, warranty_terms, labor_rate, service_call_fee, service_call_fee_mode, greeting_mode, custom_greeting_en, custom_greeting_es",
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
      serviceCallFeeMode: "fixed" | "negotiated";
    }) => input,
  )
  .handler(async ({ context, data }) => {
    if (!Number.isFinite(data.laborRate) || data.laborRate < 0) {
      throw new Error("Labor rate must be a number of 0 or more.");
    }
    if (!Number.isFinite(data.serviceCallFee) || data.serviceCallFee < 0) {
      throw new Error("Service call fee must be a number of 0 or more.");
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
        service_call_fee_mode: data.serviceCallFeeMode,
      })
      .eq("user_id", context.userId);
    if (error) {
      throw new Error(`Could not save business settings: ${error.message}`);
    }
    return { ok: true as const };
  });

// Server-side authority for greeting length — the dashboard's own input may
// add a character counter, but this is the one place that actually decides
// what gets persisted, same reasoning as validatePriceSheetItem in
// price-sheet-server.ts. Oversized text is REJECTED, never silently
// truncated, so the owner always knows exactly what's saved.
export const MAX_CUSTOM_GREETING_LENGTH = 300;

export type GreetingSettingsInput = {
  greetingMode: "recommended" | "custom";
  customGreetingEn: string;
  customGreetingEs: string;
};

// Extracted into a plain, directly-callable function — same reasoning and
// pattern as public-lead-server.ts's performCreateClarifyingLead/
// performFinalizeLeadWithQuote: a bare createServerFn cannot be invoked
// directly in this test environment at all (confirmed, see
// price-sheet-server.test.ts's header comment — it throws "No Start
// context found in AsyncLocalStorage"). Taking a plain client + userId
// instead of TanStack's {context, data} shape makes the validation AND the
// tenant-scoping (`.eq("user_id", userId)`, using the parameter — never
// anything from `data`, which has no userId/tenantId field to begin with)
// both directly regression-testable with a fake client, no server runtime
// needed.
export async function performUpdateMyGreetingSettings(
  supabase: Pick<SupabaseClient, "from">,
  userId: string,
  data: GreetingSettingsInput,
): Promise<{ ok: true }> {
  if (data.greetingMode !== "recommended" && data.greetingMode !== "custom") {
    throw new Error('Greeting mode must be "recommended" or "custom".');
  }
  if (typeof data.customGreetingEn !== "string" || typeof data.customGreetingEs !== "string") {
    throw new Error("Custom greeting text must be text.");
  }

  // Trimmed before validating AND before storing — a whitespace-only
  // value is treated as empty (falls back to the recommended default at
  // send time, see resolveFirstContactGreeting), never saved as a
  // misleadingly "set" value that's actually blank.
  const customGreetingEn = data.customGreetingEn.trim();
  const customGreetingEs = data.customGreetingEs.trim();
  if (customGreetingEn.length > MAX_CUSTOM_GREETING_LENGTH) {
    throw new Error(`English greeting is too long (max ${MAX_CUSTOM_GREETING_LENGTH} characters).`);
  }
  if (customGreetingEs.length > MAX_CUSTOM_GREETING_LENGTH) {
    throw new Error(`Spanish greeting is too long (max ${MAX_CUSTOM_GREETING_LENGTH} characters).`);
  }

  const { error } = await supabase
    .from("tenants")
    .update({
      greeting_mode: data.greetingMode,
      custom_greeting_en: customGreetingEn || null,
      custom_greeting_es: customGreetingEs || null,
    })
    .eq("user_id", userId);
  if (error) throw new Error(`Could not save greeting settings: ${error.message}`);
  return { ok: true as const };
}

// Deliberately separate from updateMyTenant rather than folded into it:
// updateMyTenant's validator requires every business-settings field in one
// call, and the Price Sheet page (where the AI Greeting section lives)
// doesn't carry that whole form's state — reusing updateMyTenant here would
// mean either resending stale/guessed values for unrelated settings (risking
// overwriting a concurrent edit on the Business Settings page) or widening
// updateMyTenant's validator to make every field optional, which would also
// let a future caller silently omit a field it meant to send. A narrow
// function that only ever touches these three columns can't do either.
export const updateMyGreetingSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: GreetingSettingsInput) => input)
  .handler(async ({ context, data }) => performUpdateMyGreetingSettings(context.supabase, context.userId, data));
