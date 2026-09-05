import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PriceSheetRow, PricingType } from "@/lib/mock-data";

type PriceSheetItemRow = {
  id: string;
  task: string;
  category: string;
  keywords: string[];
  pricing_type: PricingType;
  price_min: number;
  price_max: number;
  hours: number;
};

function toRow(item: PriceSheetItemRow): PriceSheetRow {
  return {
    id: item.id,
    task: item.task,
    category: item.category,
    keywords: item.keywords,
    pricingType: item.pricing_type,
    priceMin: item.price_min,
    priceMax: item.price_max,
    hours: item.hours,
  };
}

export const listMyPriceSheet = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PriceSheetRow[]> => {
    const { data: tenant, error: tenantError } = await context.supabase
      .from("tenants")
      .select("id")
      .eq("user_id", context.userId)
      .single();
    if (tenantError) throw new Error(`Could not load your business: ${tenantError.message}`);

    const { data, error } = await context.supabase
      .from("price_sheet_items")
      .select("id, task, category, keywords, pricing_type, price_min, price_max, hours")
      .eq("tenant_id", tenant.id)
      .order("sort_order", { ascending: true });
    if (error) throw new Error(`Could not load price sheet: ${error.message}`);
    return (data as PriceSheetItemRow[]).map(toRow);
  });

// Full replace: the price sheet is small and edited rarely, so swapping the
// whole set is simpler and safer than diffing inserts/updates/deletes.
export const saveMyPriceSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      items: Array<{
        task: string;
        category: string;
        keywords: string[];
        pricingType: PricingType;
        priceMin: number;
        priceMax: number;
        hours: number;
      }>;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const { data: tenant, error: tenantError } = await context.supabase
      .from("tenants")
      .select("id")
      .eq("user_id", context.userId)
      .single();
    if (tenantError) throw new Error(`Could not load your business: ${tenantError.message}`);

    const { error: deleteError } = await context.supabase
      .from("price_sheet_items")
      .delete()
      .eq("tenant_id", tenant.id);
    if (deleteError) throw new Error(`Could not save price sheet: ${deleteError.message}`);

    if (data.items.length === 0) return { ok: true as const };

    const { error: insertError } = await context.supabase.from("price_sheet_items").insert(
      data.items.map((item, index) => ({
        tenant_id: tenant.id,
        task: item.task,
        category: item.category,
        keywords: item.keywords,
        pricing_type: item.pricingType,
        price_min: item.priceMin,
        price_max: item.priceMax,
        hours: item.hours,
        sort_order: index,
      })),
    );
    if (insertError) throw new Error(`Could not save price sheet: ${insertError.message}`);
    return { ok: true as const };
  });
