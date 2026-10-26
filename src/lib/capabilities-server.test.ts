import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getActiveCapabilitiesForTenant, type Capability } from "./capabilities-server";

// getActiveCapabilitiesForTenant is the service-role-path equivalent of
// listMyCapabilities (a bare createServerFn, untestable in this harness
// for the same reason documented elsewhere in this codebase) — this one
// is a plain function specifically so it's directly testable, since it's
// the actual read whatsapp-conversation-server.ts and the widget flow
// (via public-lead-server.ts) rely on for exclusion enforcement.

function fakeAdmin(config: {
  rows?: Capability[];
  error?: { message: string };
}): { client: Pick<SupabaseClient, "from">; calls: Array<{ tenantId: unknown; active: unknown }> } {
  const calls: Array<{ tenantId: unknown; active: unknown }> = [];
  const client = {
    from: (table: string) => {
      if (table !== "tenant_capabilities") throw new Error(`unexpected table "${table}"`);
      return {
        select: () => ({
          eq: (col: string, tenantId: unknown) => ({
            eq: (col2: string, active: unknown) => {
              calls.push({ tenantId, active });
              return {
                order: async () =>
                  config.error ? { data: null, error: config.error } : { data: config.rows ?? [], error: null },
              };
            },
          }),
        }),
      };
    },
  };
  return { client: client as unknown as Pick<SupabaseClient, "from">, calls };
}

describe("getActiveCapabilitiesForTenant", () => {
  it("returns the tenant's active capabilities, scoped by tenant_id and filtered to active = true", async () => {
    const rows: Capability[] = [
      { id: "cap-1", type: "exclusion", label: "Gas line installation", notes: null, active: true },
    ];
    const { client, calls } = fakeAdmin({ rows });
    const result = await getActiveCapabilitiesForTenant(client, "tenant-A");
    expect(result).toEqual(rows);
    expect(calls).toEqual([{ tenantId: "tenant-A", active: true }]);
  });

  it("returns an empty array, never throws, on a read error — a capabilities read failure must never block a quote", async () => {
    const { client } = fakeAdmin({ error: { message: "connection reset" } });
    await expect(getActiveCapabilitiesForTenant(client, "tenant-A")).resolves.toEqual([]);
  });

  it("returns an empty array for a tenant with nothing configured", async () => {
    const { client } = fakeAdmin({ rows: [] });
    await expect(getActiveCapabilitiesForTenant(client, "tenant-B")).resolves.toEqual([]);
  });
});
