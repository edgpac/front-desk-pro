import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { sendLeadNotificationEmail } from "@/lib/notify-server";
import type { PriceSheetItem } from "@/lib/estimate-server";

// Deliberately separate from leads-server.ts: everything there runs behind
// requireSupabaseAuth (the tenant owner acting on their own account). This
// function is called by an anonymous customer on a public quote page, who
// has no Supabase session at all — it has to use the service role key to
// write on the tenant's behalf, identified by their public slug instead of
// auth.uid(). Same admin-client pattern as api.stripe.webhook.tsx.
export function getAdminClient() {
  const url = process.env["SUPABASE_URL"];
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !serviceRoleKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY on the server.");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type QuoteTenant = {
  name: string;
  slug: string;
  currency: string;
  laborRate: number;
  serviceCallFee: number;
  calendarLink: string;
  priceSheet: PriceSheetItem[];
};

// Public, unauthenticated lookup for the /quote/:slug page — an anonymous
// customer has no session, so this uses the same service-role pattern as
// createLead below, identified by the tenant's public slug. Deliberately an
// explicit field allowlist, never `select("*")`: this returns only what a
// customer needs to get a quote, nothing else off the tenant row (no id,
// no user_id, no email/phone/address). `id` is selected internally only to
// scope the price_sheet_items lookup and is never included in the result.
export const getTenantForQuote = createServerFn({ method: "GET" })
  .validator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<QuoteTenant> => {
    const admin = getAdminClient();

    const { data: tenant, error: tenantError } = await admin
      .from("tenants")
      .select("id, name, slug, currency, labor_rate, service_call_fee, calendar_link")
      .eq("slug", slug)
      .single();
    if (tenantError || !tenant) {
      throw new Error("Business not found.");
    }

    // The tenant-isolation boundary: price_sheet_items is explicitly
    // scoped to this resolved tenant's id, same pattern as
    // price-sheet-server.ts's listMyPriceSheet — a slug can never see or
    // leak another tenant's prices.
    const { data: items, error: itemsError } = await admin
      .from("price_sheet_items")
      .select("task, keywords, price_min, price_max, hours")
      .eq("tenant_id", tenant.id)
      .order("sort_order", { ascending: true });
    if (itemsError) {
      throw new Error(`Could not load price sheet: ${itemsError.message}`);
    }

    return {
      name: tenant.name as string,
      slug: tenant.slug as string,
      currency: tenant.currency as string,
      laborRate: tenant.labor_rate as number,
      serviceCallFee: tenant.service_call_fee as number,
      calendarLink: tenant.calendar_link as string,
      priceSheet: (items ?? []).map((item) => ({
        task: item["task"] as string,
        keywords: item["keywords"] as string[],
        priceMin: item["price_min"] as number,
        priceMax: item["price_max"] as number,
        hours: item["hours"] as number,
      })),
    };
  });

type CreateLeadInput = {
  tenantSlug: string;
  customerName: string;
  phone: string;
  address: string;
  channel: "Widget" | "Quote link" | "Shared link" | "WhatsApp";
  photoUrl?: string;
  problem: string;
  diagnosis: string;
  confidence: "High" | "Medium" | "Low";
  isEmergency?: boolean;
  lineItems: Array<{ description: string; qty: number; unit: string; rate: number }>;
};

// The one real trigger point this whole app was missing: a real customer
// interaction becomes a real, persisted lead — and the business gets
// notified immediately, the same way Cabos Handyman's real site does (an
// email the moment a customer gets a real estimate, not gated behind an
// actual confirmed booking).
export const createLead = createServerFn({ method: "POST" })
  .validator((input: CreateLeadInput) => input)
  .handler(async ({ data }) => {
    const admin = getAdminClient();

    const { data: tenant, error: tenantError } = await admin
      .from("tenants")
      .select("id, name, email, currency")
      .eq("slug", data.tenantSlug)
      .single();
    if (tenantError || !tenant) {
      throw new Error("Business not found.");
    }

    const { data: lead, error: leadError } = await admin
      .from("leads")
      .insert({
        tenant_id: tenant.id,
        customer_name: data.customerName,
        phone: data.phone,
        address: data.address,
        channel: data.channel,
        photo_url: data.photoUrl ?? null,
        problem: data.problem,
        diagnosis: data.diagnosis,
        confidence: data.confidence,
        ai_line_items_snapshot: data.lineItems,
      })
      .select("id")
      .single();
    if (leadError || !lead) {
      throw new Error(`Could not save lead: ${leadError?.message ?? "unknown error"}`);
    }

    if (data.lineItems.length > 0) {
      const { error: itemsError } = await admin.from("lead_line_items").insert(
        data.lineItems.map((item, index) => ({
          lead_id: lead.id,
          description: item.description,
          qty: item.qty,
          unit: item.unit,
          rate: item.rate,
          sort_order: index,
        })),
      );
      if (itemsError) {
        throw new Error(`Could not save line items: ${itemsError.message}`);
      }
    }

    const total = data.lineItems.reduce((sum, item) => sum + item.qty * item.rate, 0);

    // Notify, but never let a broken inbox block the lead from being saved —
    // same fire-and-forget-with-logging shape as the proven Cabos pattern.
    void sendLeadNotificationEmail({
      tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
      lead: {
        customer: data.customerName,
        phone: data.phone,
        address: data.address,
        channel: data.channel,
        problem: data.problem,
        diagnosis: data.diagnosis,
        confidence: data.confidence,
        ...(data.isEmergency !== undefined ? { isEmergency: data.isEmergency } : {}),
      },
      lineItems: data.lineItems.map((item, index) => ({ id: String(index), ...item })),
      total,
    });

    return { id: lead.id as string };
  });

type CreateClarifyingLeadInput = {
  tenantSlug: string;
  customerName: string;
  phone: string;
  channel: "Widget" | "Quote link" | "Shared link" | "WhatsApp";
  photoUrl: string;
  problem: string;
};

// The other half of the WhatsApp clarification fix: a lead now gets created
// the moment the AI needs to ask a follow-up question, not just once a full
// quote exists. Deliberately omits diagnosis/confidence/ai_line_items_snapshot
// — leaving confidence NULL is what marks this lead as still-in-progress for
// api.whatsapp.webhook.tsx's lookup, since createLead (above) always sets a
// concrete confidence for a finished quote and nothing else in this codebase
// ever writes a leads row at all. No new column or status value needed.
export const createClarifyingLead = createServerFn({ method: "POST" })
  .validator((input: CreateClarifyingLeadInput) => input)
  .handler(async ({ data }) => {
    const admin = getAdminClient();

    const { data: tenant, error: tenantError } = await admin
      .from("tenants")
      .select("id")
      .eq("slug", data.tenantSlug)
      .single();
    if (tenantError || !tenant) {
      throw new Error("Business not found.");
    }

    const { data: lead, error: leadError } = await admin
      .from("leads")
      .insert({
        tenant_id: tenant.id,
        customer_name: data.customerName,
        phone: data.phone,
        channel: data.channel,
        photo_url: data.photoUrl,
        problem: data.problem,
      })
      .select("id")
      .single();
    if (leadError || !lead) {
      throw new Error(`Could not save lead: ${leadError?.message ?? "unknown error"}`);
    }

    return { id: lead.id as string };
  });

type FinalizeLeadInput = {
  leadId: string;
  tenant: { name: string; email: string; currency: string };
  customerName: string;
  phone: string;
  channel: "Widget" | "Quote link" | "Shared link" | "WhatsApp";
  problem: string;
  diagnosis: string;
  confidence: "High" | "Medium" | "Low";
  isEmergency?: boolean;
  lineItems: Array<{ description: string; qty: number; unit: string; rate: number }>;
};

// Completes a lead that createClarifyingLead started earlier in the same
// conversation — updates the existing row rather than inserting a second
// one, so a WhatsApp thread that needed clarification ends up as exactly one
// lead, same as a thread that didn't.
export const finalizeLeadWithQuote = createServerFn({ method: "POST" })
  .validator((input: FinalizeLeadInput) => input)
  .handler(async ({ data }) => {
    const admin = getAdminClient();

    const { error: updateError } = await admin
      .from("leads")
      .update({
        diagnosis: data.diagnosis,
        confidence: data.confidence,
        ai_line_items_snapshot: data.lineItems,
      })
      .eq("id", data.leadId);
    if (updateError) {
      throw new Error(`Could not update lead: ${updateError.message}`);
    }

    if (data.lineItems.length > 0) {
      const { error: itemsError } = await admin.from("lead_line_items").insert(
        data.lineItems.map((item, index) => ({
          lead_id: data.leadId,
          description: item.description,
          qty: item.qty,
          unit: item.unit,
          rate: item.rate,
          sort_order: index,
        })),
      );
      if (itemsError) {
        throw new Error(`Could not save line items: ${itemsError.message}`);
      }
    }

    const total = data.lineItems.reduce((sum, item) => sum + item.qty * item.rate, 0);

    void sendLeadNotificationEmail({
      tenant: data.tenant,
      lead: {
        customer: data.customerName,
        phone: data.phone,
        address: "",
        channel: data.channel,
        problem: data.problem,
        diagnosis: data.diagnosis,
        confidence: data.confidence,
        ...(data.isEmergency !== undefined ? { isEmergency: data.isEmergency } : {}),
      },
      lineItems: data.lineItems.map((item, index) => ({ id: String(index), ...item })),
      total,
    });

    return { id: data.leadId, total };
  });
