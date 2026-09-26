import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { sendLeadNotificationEmail } from "@/lib/notify-server";
import { hasActiveSubscriptionForOwner } from "@/lib/entitlements-server";
import { lineItemsTotal } from "@/lib/mock-data";
import type { PriceSheetItem } from "@/lib/estimate-server";

// Every function below is anonymous/unauthenticated by design (the public
// quote page and widget). This is the one deliberately generic error they
// all throw whenever the tenant doesn't exist OR its subscription isn't
// active — a visitor must never be able to tell those two cases apart.
const INTAKE_UNAVAILABLE_MESSAGE = "This business's estimate service is currently unavailable.";

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
  serviceCallFeeMode: "fixed" | "negotiated";
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
      .select(
        "id, user_id, name, slug, currency, labor_rate, service_call_fee, service_call_fee_mode, calendar_link",
      )
      .eq("slug", slug)
      .single();
    if (tenantError || !tenant) {
      throw new Error(INTAKE_UNAVAILABLE_MESSAGE);
    }

    // Public intake (this page, the embeddable widget, and the AI/lead
    // calls below) is a subscriber-only feature — a canceled/past_due/
    // unpaid/never-subscribed business's link and widget must stop working,
    // not just have their dashboard buttons hidden. One authoritative check
    // (entitlements-server.ts), no separate rule maintained here.
    if (!(await hasActiveSubscriptionForOwner(admin, tenant["user_id"] as string))) {
      throw new Error(INTAKE_UNAVAILABLE_MESSAGE);
    }

    // The tenant-isolation boundary: price_sheet_items is explicitly
    // scoped to this resolved tenant's id, same pattern as
    // price-sheet-server.ts's listMyPriceSheet — a slug can never see or
    // leak another tenant's prices.
    const { data: items, error: itemsError } = await admin
      .from("price_sheet_items")
      .select(
        "id, task, category, keywords, pricing_type, price_min, price_max, hours, bundleable, materials_policy, diagnosis_pricing_type, diagnosis_fee, ai_notes",
      )
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
      serviceCallFeeMode: tenant.service_call_fee_mode as "fixed" | "negotiated",
      calendarLink: tenant.calendar_link as string,
      priceSheet: (items ?? []).map((item) => ({
        id: item["id"] as string,
        task: item["task"] as string,
        category: item["category"] as string,
        keywords: item["keywords"] as string[],
        pricingType: item["pricing_type"] as "flat" | "hourly" | "range",
        priceMin: item["price_min"] as number,
        priceMax: item["price_max"] as number,
        hours: item["hours"] as number,
        bundleable: item["bundleable"] as boolean,
        materialsPolicy: item["materials_policy"] as "included" | "customer_pays_receipt" | "confirmed_after_inspection",
        diagnosisFee: item["diagnosis_pricing_type"]
          ? {
              pricingType: item["diagnosis_pricing_type"] as "flat" | "hourly",
              amount: item["diagnosis_fee"] as number,
            }
          : null,
        aiNotes: item["ai_notes"] as string | null,
      })),
    };
  });

// Generic across any tenant/service — never mentions a specific business,
// service, or wording. See estimate-server.ts's hasNoPricedWork: true only
// when service_call_fee_mode is "negotiated" and nothing else was matched.
const PENDING_NEGOTIATED_PRICE_REASON =
  "Pricing is deferred for this service — the exact service-call/diagnostic fee needs to be confirmed directly with the customer.";

// P2 mixed-pricing: distinct from PENDING_NEGOTIATED_PRICE_REASON above —
// that one means NOTHING was priced; this means SOMETHING was priced (a
// real, correct line-item total exists) and something else, separately,
// still needs pricing confirmed. Generic across any tenant/service.
const PARTIALLY_PRICED_REASON =
  "Part of this request has a confirmed price; the rest still needs to be priced directly with the customer.";

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
  // True only for estimate-server.ts's hasNoPricedWork — nothing was
  // actually priced (negotiated service-call mode, no other match). Must
  // never be inferred downstream from lineItems.length === 0 or total ===
  // 0 — this is the one authoritative signal for that state, persisted
  // explicitly rather than reconstructed.
  pendingNegotiatedPrice?: boolean;
  // P2 mixed-pricing: true only for estimate-server.ts's
  // hasPartiallyDeferredWork — mutually exclusive with
  // pendingNegotiatedPrice by construction (that requires zero line items,
  // this requires at least one real one). Takes priority when both could
  // theoretically be checked — see the flag_type logic below.
  hasPartiallyDeferredWork?: boolean;
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
      .select("id, user_id, name, email, currency")
      .eq("slug", data.tenantSlug)
      .single();
    if (tenantError || !tenant) {
      throw new Error(INTAKE_UNAVAILABLE_MESSAGE);
    }
    if (!(await hasActiveSubscriptionForOwner(admin, tenant["user_id"] as string))) {
      throw new Error(INTAKE_UNAVAILABLE_MESSAGE);
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
        // P2: mutually exclusive by construction (hasPartiallyDeferredWork
        // requires real line items, pendingNegotiatedPrice requires zero) —
        // checked in this order regardless, so a future caller that somehow
        // set both can never produce the wrong, more-alarming
        // pending_negotiated_price state for a lead that actually has a
        // real, priced portion.
        ...(data.hasPartiallyDeferredWork
          ? { status: "flagged", flag_type: "partially_priced", flag_reason: PARTIALLY_PRICED_REASON }
          : data.pendingNegotiatedPrice
            ? { status: "flagged", flag_type: "pending_negotiated_price", flag_reason: PENDING_NEGOTIATED_PRICE_REASON }
            : {}),
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

    const total = lineItemsTotal(data.lineItems);

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
        ...(data.pendingNegotiatedPrice !== undefined ? { pendingNegotiatedPrice: data.pendingNegotiatedPrice } : {}),
        ...(data.hasPartiallyDeferredWork !== undefined ? { hasPartiallyDeferredWork: data.hasPartiallyDeferredWork } : {}),
      },
      lineItems: data.lineItems.map((item, index) => ({ id: String(index), ...item })),
      total,
    });

    return { id: lead.id as string };
  });

type CreateFlaggedLeadInput = {
  tenantSlug: string;
  customerName: string;
  phone: string;
  channel: "Widget" | "Quote link" | "Shared link" | "WhatsApp";
  photoUrl: string | null;
  problem: string;
  flagType: "conflicting_information" | "needs_human_review" | "outside_service_scope";
  flagReason: string;
};

// Minimal flagged-leads slice (see ROADMAP.md Phase 1.5) — sibling to
// createClarifyingLead above, same shape, but for the case where the AI
// shouldn't attempt a price at all (right now: nothing on the price sheet
// covers the request) rather than needing more information to price it.
export const createFlaggedLead = createServerFn({ method: "POST" })
  .validator((input: CreateFlaggedLeadInput) => input)
  .handler(async ({ data }) => {
    const admin = getAdminClient();

    const { data: tenant, error: tenantError } = await admin
      .from("tenants")
      .select("id, user_id")
      .eq("slug", data.tenantSlug)
      .single();
    if (tenantError || !tenant) {
      throw new Error(INTAKE_UNAVAILABLE_MESSAGE);
    }
    if (!(await hasActiveSubscriptionForOwner(admin, tenant["user_id"] as string))) {
      throw new Error(INTAKE_UNAVAILABLE_MESSAGE);
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
        status: "flagged",
        flag_type: data.flagType,
        flag_reason: data.flagReason,
      })
      .select("id")
      .single();
    if (leadError || !lead) {
      throw new Error(`Could not save lead: ${leadError?.message ?? "unknown error"}`);
    }

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
  // Resolved server-side, same as createLead/createClarifyingLead — not
  // trusted from the caller. WhatsApp already has this data in hand but
  // looks it up fresh anyway (cheap, and one less shape to keep in sync);
  // the widget (P1-D) never had it available as a prop at all, so this is
  // required, not just a simplification.
  tenantSlug: string;
  customerName: string;
  phone: string;
  channel: "Widget" | "Quote link" | "Shared link" | "WhatsApp";
  problem: string;
  diagnosis: string;
  confidence: "High" | "Medium" | "Low";
  isEmergency?: boolean;
  lineItems: Array<{ description: string; qty: number; unit: string; rate: number }>;
  // Same meaning/authority as CreateLeadInput.pendingNegotiatedPrice above.
  pendingNegotiatedPrice?: boolean;
  // Same meaning/authority as CreateLeadInput.hasPartiallyDeferredWork above.
  hasPartiallyDeferredWork?: boolean;
};

// Completes a lead that createClarifyingLead started earlier in the same
// conversation — updates the existing row rather than inserting a second
// one, so a WhatsApp thread that needed clarification ends up as exactly one
// lead, same as a thread that didn't.
export const finalizeLeadWithQuote = createServerFn({ method: "POST" })
  .validator((input: FinalizeLeadInput) => input)
  .handler(async ({ data }) => {
    const admin = getAdminClient();

    const { data: tenant, error: tenantError } = await admin
      .from("tenants")
      .select("name, email, currency")
      .eq("slug", data.tenantSlug)
      .single();
    if (tenantError || !tenant) {
      throw new Error(INTAKE_UNAVAILABLE_MESSAGE);
    }

    const { error: updateError } = await admin
      .from("leads")
      .update({
        // Writing customer_name/phone here too (not just diagnosis/quote
        // fields) is required for the widget (P1-D): unlike WhatsApp, which
        // already has a real phone/profile name the moment
        // createClarifyingLead runs, the widget only collects contact info
        // at the very end of the flow, after any clarification rounds — so
        // the row created earlier still has empty placeholders that need
        // to be filled in here. A no-op for WhatsApp, which already wrote
        // the same values at createClarifyingLead time.
        customer_name: data.customerName,
        phone: data.phone,
        diagnosis: data.diagnosis,
        confidence: data.confidence,
        ai_line_items_snapshot: data.lineItems,
        // P2: same priority ordering as createLead above.
        ...(data.hasPartiallyDeferredWork
          ? { status: "flagged", flag_type: "partially_priced", flag_reason: PARTIALLY_PRICED_REASON }
          : data.pendingNegotiatedPrice
            ? { status: "flagged", flag_type: "pending_negotiated_price", flag_reason: PENDING_NEGOTIATED_PRICE_REASON }
            : {}),
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

    const total = lineItemsTotal(data.lineItems);

    void sendLeadNotificationEmail({
      tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
      lead: {
        customer: data.customerName,
        phone: data.phone,
        address: "",
        channel: data.channel,
        problem: data.problem,
        diagnosis: data.diagnosis,
        confidence: data.confidence,
        ...(data.isEmergency !== undefined ? { isEmergency: data.isEmergency } : {}),
        ...(data.pendingNegotiatedPrice !== undefined ? { pendingNegotiatedPrice: data.pendingNegotiatedPrice } : {}),
        ...(data.hasPartiallyDeferredWork !== undefined ? { hasPartiallyDeferredWork: data.hasPartiallyDeferredWork } : {}),
      },
      lineItems: data.lineItems.map((item, index) => ({ id: String(index), ...item })),
      total,
    });

    return { id: data.leadId, total };
  });

// P1-D: generic "append messages to a lead's thread" — used by the widget
// (QuoteFlow.tsx) to persist clarification Q&A as it happens, the same
// lead_messages table WhatsApp already reads/writes for the identical
// purpose (see whatsapp-conversation-server.ts's deterministic pairing).
// Deliberately generic rather than "saveClarificationRound" or similar —
// the caller decides what belongs in the transcript and in what order;
// this just persists it. Same anonymous-write trust model as createLead/
// finalizeLeadWithQuote above: the leadId is an opaque id the calling
// widget session already legitimately holds, not a new security boundary.
export const saveClarificationMessages = createServerFn({ method: "POST" })
  .validator((input: { leadId: string; messages: Array<{ role: "customer" | "assistant"; body: string }> }) => input)
  .handler(async ({ data }) => {
    if (data.messages.length === 0) return { ok: true as const };
    const admin = getAdminClient();
    const { error } = await admin
      .from("lead_messages")
      .insert(data.messages.map((m) => ({ lead_id: data.leadId, role: m.role, body: m.body })));
    if (error) throw new Error(`Could not save messages: ${error.message}`);
    return { ok: true as const };
  });

type FinalizeAsOutOfScopeInput = {
  leadId: string;
  customerName: string;
  phone: string;
  flagReason: string;
};

// P1-D's other necessary half: once createClarifyingLead has started a
// widget lead, a later "actually this is out of scope" outcome must
// complete that same row (same reasoning as finalizeLeadWithQuote above),
// not insert a second lead via createFlaggedLead — that would silently
// duplicate every clarified-then-out-of-scope request. Same shape as the
// WhatsApp equivalent (whatsapp-conversation-server.ts's inline update in
// its own out-of-scope branch), exposed here as a public function since
// the widget has no admin-client access of its own.
export const finalizeLeadAsOutOfScope = createServerFn({ method: "POST" })
  .validator((input: FinalizeAsOutOfScopeInput) => input)
  .handler(async ({ data }) => {
    const admin = getAdminClient();
    const { error } = await admin
      .from("leads")
      .update({
        customer_name: data.customerName,
        phone: data.phone,
        status: "flagged",
        flag_type: "outside_service_scope",
        flag_reason: data.flagReason,
      })
      .eq("id", data.leadId);
    if (error) throw new Error(`Could not update lead: ${error.message}`);
    return { id: data.leadId };
  });

type FinalizeAsNeedsReviewInput = {
  leadId: string;
  customerName: string;
  phone: string;
};

// Widget equivalent of the WhatsApp needs_human_review handling (P2): a
// clarifying lead already exists when getQuoteEstimate exhausts its retry
// on the finalize attempt. The widget never collects contact info until
// after a successful quote, so without this the customer hit a dead-end
// error screen having never been asked for a name/phone, and the lead sat
// in the dashboard looking like a normal, silently-incomplete "new" lead
// with no way for the business to actually reach them. Same pattern as
// finalizeLeadAsOutOfScope: complete the existing row, don't insert a
// second one.
export const finalizeLeadAsNeedsReview = createServerFn({ method: "POST" })
  .validator((input: FinalizeAsNeedsReviewInput) => input)
  .handler(async ({ data }) => {
    const admin = getAdminClient();
    const { error } = await admin
      .from("leads")
      .update({
        customer_name: data.customerName,
        phone: data.phone,
        status: "flagged",
        flag_type: "needs_human_review",
        flag_reason: "AI couldn't finalize this quote automatically after clarification.",
      })
      .eq("id", data.leadId);
    if (error) throw new Error(`Could not update lead: ${error.message}`);
    return { id: data.leadId };
  });
