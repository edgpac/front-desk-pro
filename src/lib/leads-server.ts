import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Lead, LeadStatus, LineItem } from "@/lib/mock-data";

const NO_PHOTO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='225' viewBox='0 0 400 225'%3E%3Crect width='400' height='225' fill='%23e5e1da'/%3E%3Ctext x='200' y='118' font-family='sans-serif' font-size='14' fill='%23918a7c' text-anchor='middle'%3ENo photo%3C/text%3E%3C/svg%3E";

type LeadRow = {
  id: string;
  customer_name: string;
  phone: string;
  address: string;
  channel: Lead["channel"];
  status: LeadStatus;
  photo_url: string | null;
  problem: string;
  diagnosis: string;
  confidence: Lead["confidence"] | null;
  ai_line_items_snapshot: LineItem[] | null;
  created_at: string;
};

type LineItemRow = { id: string; description: string; qty: number; unit: string; rate: number };
type MessageRow = { role: "customer" | "assistant"; body: string };

function formatRequested(createdAt: string) {
  const date = new Date(createdAt);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function getTenantId(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase.from("tenants").select("id").eq("user_id", userId).single();
  if (error) throw new Error(`Could not load your business: ${error.message}`);
  return data.id as string;
}

export const listMyLeads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Lead[]> => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    const { data: leads, error } = await context.supabase
      .from("leads")
      .select("id, customer_name, phone, address, channel, status, photo_url, problem, diagnosis, confidence, ai_line_items_snapshot, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Could not load leads: ${error.message}`);

    const leadRows = leads as LeadRow[];
    if (leadRows.length === 0) return [];

    const { data: items, error: itemsError } = await context.supabase
      .from("lead_line_items")
      .select("id, lead_id, description, qty, unit, rate")
      .in(
        "lead_id",
        leadRows.map((l) => l.id),
      );
    if (itemsError) throw new Error(`Could not load line items: ${itemsError.message}`);

    const itemsByLead = new Map<string, LineItem[]>();
    for (const item of items as Array<LineItemRow & { lead_id: string }>) {
      const list = itemsByLead.get(item.lead_id) ?? [];
      list.push({ id: item.id, description: item.description, qty: item.qty, unit: item.unit, rate: item.rate });
      itemsByLead.set(item.lead_id, list);
    }

    return leadRows.map((row) => ({
      id: row.id,
      customer: row.customer_name,
      phone: row.phone,
      address: row.address,
      requested: formatRequested(row.created_at),
      channel: row.channel,
      status: row.status,
      photo: row.photo_url ?? NO_PHOTO,
      problem: row.problem,
      diagnosis: row.diagnosis,
      confidence: row.confidence ?? "Medium",
      lineItems: itemsByLead.get(row.id) ?? [],
      followUps: [],
    }));
  });

export const getMyLead = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data: id }): Promise<Lead & { aiLineItemsSnapshot: LineItem[] | null }> => {
    const tenantId = await getTenantId(context.supabase, context.userId);

    const { data: row, error } = await context.supabase
      .from("leads")
      .select("id, customer_name, phone, address, channel, status, photo_url, problem, diagnosis, confidence, ai_line_items_snapshot, created_at")
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .single();
    if (error) throw new Error(`Lead not found: ${error.message}`);
    const lead = row as LeadRow;

    const { data: items, error: itemsError } = await context.supabase
      .from("lead_line_items")
      .select("id, description, qty, unit, rate")
      .eq("lead_id", id)
      .order("sort_order", { ascending: true });
    if (itemsError) throw new Error(`Could not load line items: ${itemsError.message}`);

    const { data: messages, error: messagesError } = await context.supabase
      .from("lead_messages")
      .select("role, body")
      .eq("lead_id", id)
      .order("created_at", { ascending: true });
    if (messagesError) throw new Error(`Could not load messages: ${messagesError.message}`);

    return {
      id: lead.id,
      customer: lead.customer_name,
      phone: lead.phone,
      address: lead.address,
      requested: formatRequested(lead.created_at),
      channel: lead.channel,
      status: lead.status,
      photo: lead.photo_url ?? NO_PHOTO,
      problem: lead.problem,
      diagnosis: lead.diagnosis,
      confidence: lead.confidence ?? "Medium",
      lineItems: (items as LineItemRow[]).map((i) => ({
        id: i.id,
        description: i.description,
        qty: i.qty,
        unit: i.unit,
        rate: i.rate,
      })),
      followUps: (messages as MessageRow[]).map((m) => ({ role: m.role, text: m.body })),
      aiLineItemsSnapshot: lead.ai_line_items_snapshot,
    };
  });

export const updateLeadStatus = createServerFn({ method: "POST" })
  .validator((input: { id: string; status: LeadStatus }) => input)
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("leads")
      .update({ status: data.status })
      .eq("tenant_id", tenantId)
      .eq("id", data.id);
    if (error) throw new Error(`Could not update lead: ${error.message}`);
    return { ok: true as const };
  });

export const updateLeadDiagnosis = createServerFn({ method: "POST" })
  .validator((input: { id: string; diagnosis: string }) => input)
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("leads")
      .update({ diagnosis: data.diagnosis })
      .eq("tenant_id", tenantId)
      .eq("id", data.id);
    if (error) throw new Error(`Could not save diagnosis: ${error.message}`);
    return { ok: true as const };
  });

export const updateLeadContact = createServerFn({ method: "POST" })
  .validator((input: { id: string; customerName: string; phone: string; address: string }) => input)
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("leads")
      .update({ customer_name: data.customerName, phone: data.phone, address: data.address })
      .eq("tenant_id", tenantId)
      .eq("id", data.id);
    if (error) throw new Error(`Could not save contact info: ${error.message}`);
    return { ok: true as const };
  });

// Full replace, scoped to this one lead — the AI snapshot lives on the lead
// row itself, not per line item, so this can't accidentally lose it.
export const saveLeadLineItems = createServerFn({ method: "POST" })
  .validator(
    (input: { leadId: string; items: Array<{ description: string; qty: number; unit: string; rate: number }> }) =>
      input,
  )
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    await getTenantId(context.supabase, context.userId); // confirms this user has a tenant at all

    const { error: deleteError } = await context.supabase
      .from("lead_line_items")
      .delete()
      .eq("lead_id", data.leadId);
    if (deleteError) throw new Error(`Could not save line items: ${deleteError.message}`);

    if (data.items.length === 0) return { ok: true as const };

    const { error: insertError } = await context.supabase.from("lead_line_items").insert(
      data.items.map((item, index) => ({
        lead_id: data.leadId,
        description: item.description,
        qty: item.qty,
        unit: item.unit,
        rate: item.rate,
        sort_order: index,
      })),
    );
    if (insertError) throw new Error(`Could not save line items: ${insertError.message}`);
    return { ok: true as const };
  });

export const addLeadMessage = createServerFn({ method: "POST" })
  .validator((input: { leadId: string; body: string }) => input)
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("lead_messages")
      .insert({ lead_id: data.leadId, role: "assistant", body: data.body });
    if (error) throw new Error(`Could not send message: ${error.message}`);
    return { ok: true as const };
  });
