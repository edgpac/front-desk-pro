import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { myPlanHasFeature } from "@/lib/entitlements-server";
import { lineItemAmount, type Lead, type LeadStatus, type LineItem } from "@/lib/mock-data";

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
  flag_reason: string | null;
  flag_type: "conflicting_information" | "needs_human_review" | "outside_service_scope" | "pending_negotiated_price" | null;
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
      .select("id, customer_name, phone, address, channel, status, photo_url, problem, diagnosis, confidence, ai_line_items_snapshot, created_at, flag_reason, flag_type")
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
      // || not ?? — a text-only WhatsApp lead stores photo_url as "" (see
      // whatsapp-conversation-server.ts), which must fall back to the
      // placeholder the same as null/undefined would.
      photo: row.photo_url || NO_PHOTO,
      problem: row.problem,
      diagnosis: row.diagnosis,
      confidence: row.confidence ?? "Medium",
      lineItems: itemsByLead.get(row.id) ?? [],
      followUps: [],
      createdAt: row.created_at,
      flagReason: row.flag_reason,
      flagType: row.flag_type,
    }));
  });

export const getMyLead = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data: id }): Promise<Lead & { aiLineItemsSnapshot: LineItem[] | null }> => {
    const tenantId = await getTenantId(context.supabase, context.userId);

    const { data: row, error } = await context.supabase
      .from("leads")
      .select("id, customer_name, phone, address, channel, status, photo_url, problem, diagnosis, confidence, ai_line_items_snapshot, created_at, flag_reason, flag_type")
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
      photo: lead.photo_url || NO_PHOTO,
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
      flagReason: lead.flag_reason,
      flagType: lead.flag_type,
    };
  });

// CSV escaping — wrap in quotes if the value contains a comma, quote, or
// newline; double any internal quotes. Minimal but correct for the plain
// text fields leads actually have (no formulas/injection-relevant content).
function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// Crew-only (see entitlements-server.ts). Enforced here, server-side, on
// every call — the UI hiding the button for Solo is a courtesy, not the
// actual protection. Same tenant-scoped query shape as listMyLeads above,
// not a new pattern: context.supabase (RLS-scoped to the caller's own
// session) plus an explicit tenant_id filter as defense-in-depth.
export const exportMyLeadsCsv = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<string> => {
    const allowed = await myPlanHasFeature(context.supabase, "csvExport");
    if (!allowed) {
      throw new Error("CSV export is available on the Crew plan — upgrade to export your leads.");
    }

    const tenantId = await getTenantId(context.supabase, context.userId);
    const { data: leads, error } = await context.supabase
      .from("leads")
      .select("id, customer_name, phone, address, channel, problem, status, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Could not load leads: ${error.message}`);

    const leadRows = (leads ?? []) as Array<{
      id: string;
      customer_name: string;
      phone: string;
      address: string;
      channel: string;
      problem: string;
      status: string;
      created_at: string;
    }>;
    if (leadRows.length === 0) {
      return "Name,Phone,Address,Channel,Problem,Estimate,Status,Created\n";
    }

    const { data: items, error: itemsError } = await context.supabase
      .from("lead_line_items")
      .select("lead_id, qty, rate")
      .in(
        "lead_id",
        leadRows.map((l) => l.id),
      );
    if (itemsError) throw new Error(`Could not load line items: ${itemsError.message}`);

    const totalByLead = new Map<string, number>();
    for (const item of (items ?? []) as Array<{ lead_id: string; qty: number; rate: number }>) {
      totalByLead.set(item.lead_id, (totalByLead.get(item.lead_id) ?? 0) + lineItemAmount(item));
    }

    const header = ["Name", "Phone", "Address", "Channel", "Problem", "Estimate", "Status", "Created"];
    const rows = leadRows.map((l) =>
      [
        l.customer_name,
        l.phone,
        l.address,
        l.channel,
        l.problem,
        (totalByLead.get(l.id) ?? 0).toFixed(2),
        l.status,
        l.created_at,
      ]
        .map((v) => csvField(String(v)))
        .join(","),
    );

    return [header.join(","), ...rows].join("\n");
  });

// Pre-existing bug fixed here, discovered while wiring up
// "pending_negotiated_price": leads_flag_type_requires_flagged_status
// (0008_flagged_leads.sql) requires flag_type to be null on any lead not
// in 'flagged' status. Moving a flagged lead to any other status without
// also clearing flag_type/flag_reason violates that constraint and fails
// silently into the UI's catch block (the local "Marked X" toast fires
// optimistically before the DB call, masking the failure) — meaning
// "Mark reviewed" never actually worked for any flag type, not just the
// new one. Generic fix, not specific to pending_negotiated_price.
export const updateLeadStatus = createServerFn({ method: "POST" })
  .validator((input: { id: string; status: LeadStatus }) => input)
  .middleware([requireSupabaseAuth])
  .handler(async ({ context, data }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("leads")
      .update(
        data.status === "flagged"
          ? { status: data.status }
          : { status: data.status, flag_type: null, flag_reason: null },
      )
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
