import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasActiveSubscriptionForOwner } from "@/lib/entitlements-server";
import { getAdminClient } from "@/lib/public-lead-server";
import type { PricingType } from "@/lib/mock-data";

export type PublicMenuService = {
  task: string;
  category: string;
  pricingType: PricingType;
  priceMin: number;
  priceMax: number;
};

export type PublicServiceMenu = {
  name: string;
  phone: string;
  email: string;
  currency: string;
  services: PublicMenuService[];
};

// Same deliberately-generic, can't-tell-the-difference error as
// public-lead-server.ts's INTAKE_UNAVAILABLE_MESSAGE, for the same reason —
// a visitor must never be able to tell "no business at this slug" apart
// from "this business's subscription lapsed" apart from "nothing here is
// priced yet".
const MENU_UNAVAILABLE_MESSAGE = "This business's service menu is currently unavailable.";

// Extracted into a plain, directly-callable function — same reasoning and
// pattern as tenant-server.ts's performUpdateMyGreetingSettings and
// public-lead-server.ts's performCreateClarifyingLead/
// performFinalizeLeadWithQuote: a bare createServerFn cannot be invoked
// directly in a test environment at all (throws "No Start context found in
// AsyncLocalStorage"). Taking a plain client + slug instead of TanStack's
// {data} shape makes the tenant-isolation, the internal-field exclusion,
// and the "never show an unpriced $0" behavior all directly
// regression-testable with a fake client, no server runtime needed.
//
// Deliberately a NARROWER field allowlist than getTenantForQuote's own
// price_sheet_items query (public-lead-server.ts): this is a page a
// CUSTOMER reads, never the AI's own pricing context, so keywords,
// bundleable, materials_policy, diagnosis_fee, and ai_notes (every
// internal-only field on a price_sheet_items row) are never selected here
// at all — not just hidden by the UI. Only rows with a real configured
// price are returned: the schema has no explicit "unpriced" sentinel, so
// price_min <= 0 is indistinguishable from "the owner hasn't priced this
// yet" and must never be shown to a customer as a real $0 price.
//
// Entirely read-only — every call here is a .select(), never an
// .insert()/.update()/.delete() on any table, so generating or viewing the
// menu can never modify the underlying Price Sheet.
export async function performGetPublicServiceMenu(
  admin: Pick<SupabaseClient, "from">,
  slug: string,
): Promise<PublicServiceMenu> {
  const { data: tenant, error: tenantError } = await admin
    .from("tenants")
    .select("id, user_id, name, phone, email, currency")
    .eq("slug", slug)
    .single();
  if (tenantError || !tenant) {
    throw new Error(MENU_UNAVAILABLE_MESSAGE);
  }

  // Same subscriber-only gate as the public quote page/widget
  // (getTenantForQuote) — a canceled/past_due/unpaid/never-subscribed
  // business's menu link must stop working too, not just its quote flow.
  if (!(await hasActiveSubscriptionForOwner(admin as SupabaseClient, tenant["user_id"] as string))) {
    throw new Error(MENU_UNAVAILABLE_MESSAGE);
  }

  // The tenant-isolation boundary: price_sheet_items is explicitly scoped
  // to this resolved tenant's id, same pattern as getTenantForQuote and
  // price-sheet-server.ts's listMyPriceSheet — a slug can never see or
  // leak another tenant's prices.
  const { data: items, error: itemsError } = await admin
    .from("price_sheet_items")
    .select("task, category, pricing_type, price_min, price_max")
    .eq("tenant_id", tenant.id)
    .gt("price_min", 0)
    .order("sort_order", { ascending: true });
  if (itemsError) {
    throw new Error(`Could not load the service menu: ${itemsError.message}`);
  }

  return {
    name: tenant.name as string,
    phone: tenant.phone as string,
    email: tenant.email as string,
    currency: tenant.currency as string,
    services: (items ?? []).map((row) => ({
      task: row.task as string,
      category: row.category as string,
      pricingType: row.pricing_type as PricingType,
      priceMin: row.price_min as number,
      priceMax: row.price_max as number,
    })),
  };
}

// Public, unauthenticated lookup for the /menu/:slug page — same
// service-role-by-slug pattern as getTenantForQuote
// (public-lead-server.ts). All real behavior lives in
// performGetPublicServiceMenu above.
export const getPublicServiceMenu = createServerFn({ method: "GET" })
  .validator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<PublicServiceMenu> => performGetPublicServiceMenu(getAdminClient(), slug));
