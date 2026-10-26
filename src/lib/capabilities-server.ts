import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Mirrors tenant_capabilities exactly (0004_business_capabilities.sql).
// Kept local to this file rather than re-exported from mock-data.ts for now
// — that file stays untouched until/unless the Qualifications page's
// sample-mode preview is asked to share it.
export type CapabilityType = "certification" | "specialty" | "equipment" | "exclusion";

export type Capability = {
  id: string;
  type: CapabilityType;
  label: string;
  notes: string | null;
  active: boolean;
};

type CapabilityRow = {
  id: string;
  type: CapabilityType;
  label: string;
  notes: string | null;
  active: boolean;
};

// tenant_capabilities has a real owner-scoped RLS policy (not a secrets
// table like whatsapp_connections), so this reads/writes through the
// caller's own RLS-scoped client — same as leads-server.ts/
// price-sheet-server.ts — rather than the admin client.
async function getTenantId(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await supabase.from("tenants").select("id").eq("user_id", userId).single();
  if (error) throw new Error(`Could not load your business: ${error.message}`);
  return data.id as string;
}

export const listMyCapabilities = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Capability[]> => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("tenant_capabilities")
      .select("id, type, label, notes, active")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`Could not load capabilities: ${error.message}`);
    return data as CapabilityRow[];
  });

export type AddCapabilityInput = { type: CapabilityType; label: string; notes?: string };

export const addCapability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: AddCapabilityInput) => input)
  .handler(async ({ context, data }): Promise<{ id: string }> => {
    const label = data.label.trim();
    if (!label) {
      throw new Error("Enter a name for this before adding it.");
    }
    const tenantId = await getTenantId(context.supabase, context.userId);
    const { data: row, error } = await context.supabase
      .from("tenant_capabilities")
      .insert({
        tenant_id: tenantId,
        type: data.type,
        label,
        notes: data.notes?.trim() || null,
      })
      .select("id")
      .single();
    if (error) {
      // Postgres unique_violation on (tenant_id, type, lower(trim(label))) —
      // the same capability was already added.
      if (error.code === "23505") {
        throw new Error("You've already added that.");
      }
      throw new Error(`Could not save: ${error.message}`);
    }
    return { id: row.id as string };
  });

export const removeCapability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((id: string) => id)
  .handler(async ({ context, data: id }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    const { error } = await context.supabase
      .from("tenant_capabilities")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", id);
    if (error) throw new Error(`Could not remove: ${error.message}`);
    return { ok: true as const };
  });

// The service-role-path equivalent of listMyCapabilities — called from
// whatsapp-conversation-server.ts and QuoteFlow.tsx's widget flow (via
// public-lead-server.ts's getTenantForQuote), both of which use the admin
// client (no authenticated owner session to scope an RLS-backed query
// through) and already know the tenant's id directly, having already
// resolved it the same way they resolve the price sheet. A plain function,
// not a createServerFn — these callers are server-side code calling it
// directly, not a client-facing RPC endpoint of its own, and this shape
// makes it directly unit-testable with a fake admin client.
export async function getActiveCapabilitiesForTenant(
  admin: Pick<SupabaseClient, "from">,
  tenantId: string,
): Promise<Capability[]> {
  const { data, error } = await admin
    .from("tenant_capabilities")
    .select("id, type, label, notes, active")
    .eq("tenant_id", tenantId)
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) {
    console.error(`Could not load capabilities for tenant ${tenantId}:`, error.message);
    // Fails toward "no exclusions known" rather than throwing — a read
    // failure here must never block a quote outright (that would be a
    // worse outcome than this feature not existing at all), but it must
    // also never silently treat a failed read as "this request isn't
    // excluded" without saying so loudly first.
    return [];
  }
  return (data ?? []) as Capability[];
}
