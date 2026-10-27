import { describe, expect, it } from "vitest";
import { performGetPublicServiceMenu, type PublicServiceMenu } from "@/lib/service-menu-server";

type FakeTenantRow = {
  id: string;
  user_id: string;
  name: string;
  phone: string;
  email: string;
  currency: string;
};

type FakePriceSheetRow = Record<string, unknown> & { task: string; category: string };

function fakeMenuAdmin(config: {
  tenant: FakeTenantRow | null;
  subscriptionActive?: boolean;
  priceSheetRowsByTenantId?: Record<string, FakePriceSheetRow[]>;
}) {
  const calls = {
    tenantIdsQueried: [] as string[],
    priceSheetGtArgs: [] as unknown[],
    writesAttempted: 0,
  };
  const admin = {
    from: (table: string) => {
      if (table === "tenants") {
        return {
          select: () => ({
            eq: (_col: string, slug: string) => ({
              single: async () =>
                config.tenant
                  ? { data: config.tenant, error: null }
                  : { data: null, error: { message: `no tenant for slug ${slug}` } },
            }),
          }),
          insert: () => {
            calls.writesAttempted++;
            throw new Error("performGetPublicServiceMenu must never write to tenants");
          },
          update: () => {
            calls.writesAttempted++;
            throw new Error("performGetPublicServiceMenu must never write to tenants");
          },
        };
      }
      if (table === "subscription_state") {
        return {
          select: () => ({
            eq: (_col: string, userId: string) => ({
              maybeSingle: async () => ({
                data:
                  config.subscriptionActive === false
                    ? null
                    : { plan: "crew", subscription_status: "active", user_id: userId },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "price_sheet_items") {
        return {
          select: () => ({
            eq: (_col: string, tenantId: string) => {
              calls.tenantIdsQueried.push(tenantId);
              return {
                gt: (_gtCol: string, value: number) => {
                  calls.priceSheetGtArgs.push(value);
                  return {
                    order: async () => ({
                      data: config.priceSheetRowsByTenantId?.[tenantId] ?? [],
                      error: null,
                    }),
                  };
                },
              };
            },
          }),
          insert: () => {
            calls.writesAttempted++;
            throw new Error("performGetPublicServiceMenu must never write to price_sheet_items");
          },
          update: () => {
            calls.writesAttempted++;
            throw new Error("performGetPublicServiceMenu must never write to price_sheet_items");
          },
        };
      }
      throw new Error(`fakeMenuAdmin: unexpected table "${table}"`);
    },
  };
  return { admin: admin as unknown as Parameters<typeof performGetPublicServiceMenu>[0], calls };
}

const TENANT_A: FakeTenantRow = {
  id: "tenant-a",
  user_id: "owner-a",
  name: "Hale & Sons Plumbing",
  phone: "(512) 555-0110",
  email: "office@haleandsonsplumbing.com",
  currency: "USD",
};

const TENANT_B: FakeTenantRow = {
  id: "tenant-b",
  user_id: "owner-b",
  name: "Cabos Handyman",
  phone: "+52 612 169 8328",
  email: "caboshandymanservice@gmail.com",
  currency: "MXN",
};

const FULL_ROW_WITH_INTERNAL_FIELDS: FakePriceSheetRow = {
  task: "Ceiling fan install",
  category: "Electrical",
  pricing_type: "flat",
  price_min: 150,
  price_max: 150,
  // Internal-only fields a real `select("*")` (or a careless copy of
  // getTenantForQuote's own allowlist) would also return — present here to
  // prove the mapping below never surfaces them, even though the real
  // query never selects them in the first place.
  keywords: ["ceiling fan", "install"],
  bundleable: false,
  materials_policy: "included",
  diagnosis_pricing_type: "flat",
  diagnosis_fee: 50,
  ai_notes: "Never quote without confirming attic access.",
};

describe("performGetPublicServiceMenu", () => {
  it("returns only customer-safe fields — internal-only fields never appear on the mapped service, even when present on the raw row", async () => {
    const { admin } = fakeMenuAdmin({
      tenant: TENANT_A,
      priceSheetRowsByTenantId: { [TENANT_A.id]: [FULL_ROW_WITH_INTERNAL_FIELDS] },
    });

    const menu = await performGetPublicServiceMenu(admin, "hale-and-sons");

    expect(menu.services).toEqual([
      { task: "Ceiling fan install", category: "Electrical", pricingType: "flat", priceMin: 150, priceMax: 150 },
    ]);
    const keys = Object.keys(menu.services[0]!);
    expect(keys).not.toContain("keywords");
    expect(keys).not.toContain("bundleable");
    expect(keys).not.toContain("materialsPolicy");
    expect(keys).not.toContain("diagnosisFee");
    expect(keys).not.toContain("aiNotes");
  });

  it("never fabricates a price: a row with price_min <= 0 is excluded via the query itself (price_min > 0), never shown as a real $0 price", async () => {
    const { admin, calls } = fakeMenuAdmin({
      tenant: TENANT_A,
      priceSheetRowsByTenantId: {
        // The fake's own "gt" stub doesn't filter — it just records the
        // threshold the real query would have used. This test's job is to
        // confirm performGetPublicServiceMenu actually requests that
        // filter (price_min > 0), not to re-implement Postgres's own
        // filtering in the fake.
        [TENANT_A.id]: [FULL_ROW_WITH_INTERNAL_FIELDS],
      },
    });

    await performGetPublicServiceMenu(admin, "hale-and-sons");

    expect(calls.priceSheetGtArgs).toEqual([0]);
  });

  it("tenant isolation: tenant A's slug only ever queries price_sheet_items scoped to tenant A's own id, never tenant B's", async () => {
    const { admin, calls } = fakeMenuAdmin({
      tenant: TENANT_A,
      priceSheetRowsByTenantId: {
        [TENANT_A.id]: [{ task: "A's service", category: "General", pricing_type: "flat", price_min: 100, price_max: 100 }],
        [TENANT_B.id]: [{ task: "B's service", category: "General", pricing_type: "flat", price_min: 999, price_max: 999 }],
      },
    });

    const menu = await performGetPublicServiceMenu(admin, "hale-and-sons");

    expect(calls.tenantIdsQueried).toEqual([TENANT_A.id]);
    expect(menu.services.map((s) => s.task)).toEqual(["A's service"]);
    expect(menu.services.map((s) => s.task)).not.toContain("B's service");
  });

  it("generation is entirely read-only — no insert/update is ever attempted on tenants or price_sheet_items", async () => {
    const { admin, calls } = fakeMenuAdmin({
      tenant: TENANT_A,
      priceSheetRowsByTenantId: { [TENANT_A.id]: [FULL_ROW_WITH_INTERNAL_FIELDS] },
    });

    await performGetPublicServiceMenu(admin, "hale-and-sons");

    expect(calls.writesAttempted).toBe(0);
  });

  it("an unknown slug and a known slug with no active subscription both throw the exact same generic message — a visitor can never tell the difference", async () => {
    const { admin: adminNoTenant } = fakeMenuAdmin({ tenant: null });
    const { admin: adminInactive } = fakeMenuAdmin({ tenant: TENANT_A, subscriptionActive: false });

    let messageForUnknownSlug = "";
    try {
      await performGetPublicServiceMenu(adminNoTenant, "does-not-exist");
    } catch (err) {
      messageForUnknownSlug = err instanceof Error ? err.message : String(err);
    }

    let messageForInactiveSubscription = "";
    try {
      await performGetPublicServiceMenu(adminInactive, "hale-and-sons");
    } catch (err) {
      messageForInactiveSubscription = err instanceof Error ? err.message : String(err);
    }

    expect(messageForUnknownSlug).toBe(messageForInactiveSubscription);
    expect(messageForUnknownSlug).toBe("This business's service menu is currently unavailable.");
  });

  it("a tenant with an active subscription but zero priced services returns an empty, honest menu — never a fabricated placeholder", async () => {
    const { admin } = fakeMenuAdmin({ tenant: TENANT_A, priceSheetRowsByTenantId: { [TENANT_A.id]: [] } });

    const menu: PublicServiceMenu = await performGetPublicServiceMenu(admin, "hale-and-sons");

    expect(menu.services).toEqual([]);
    expect(menu.name).toBe(TENANT_A.name);
  });
});
