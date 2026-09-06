import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { sendLeadNotificationEmail } from "@/lib/notify-server";

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
