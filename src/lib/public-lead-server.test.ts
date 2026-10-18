import { describe, expect, it, vi } from "vitest";

// enforceTenantRateLimit (unmodified, pre-existing) reads the caller's IP
// via getRequest() from TanStack Start's request context, which doesn't
// exist outside a real server-function call. Mocked here only to give that
// existing, unrelated control a deterministic environment to run in — not
// to weaken or bypass it. A real IP hash flows through to the fake admin
// client's rate-limit RPC below exactly as it would in production.
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => ({
    headers: { get: (name: string) => (name === "x-forwarded-for" ? "203.0.113.1" : null) },
  }),
}));

import {
  performCreateClarifyingLead,
  performFinalizeLeadWithQuote,
  type getAdminClient,
} from "./public-lead-server";

const INTAKE_UNAVAILABLE_MESSAGE = "This business's estimate service is currently unavailable.";

type FakeAdminConfig = {
  tenant: { id: string; user_id: string } | null;
  subscriptionActive: boolean;
  leadInsert?: { data: { id: string } | null; error: { message: string } | null };
  updateLead?: { data: string | null; error: { message: string } | null };
};

// Minimal, table-dispatching fake — same spirit as entitlements-server.test.ts's
// fakeAdminClient and reconcile-subscription-metadata.test.ts's FakeSupabase,
// sized to exactly what performCreateClarifyingLead/performFinalizeLeadWithQuote
// (and the real, unmodified hasActiveSubscriptionForOwner/enforceTenantRateLimit
// they call) actually touch. `calls` records every table/RPC reached, so a
// rejection test can assert the write path was never entered, not just that
// the function threw.
function fakeAdmin(config: FakeAdminConfig) {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      if (table === "tenants") {
        calls.push("from:tenants");
        return {
          select: () => ({
            eq: () => ({
              single: async () =>
                config.tenant
                  ? { data: config.tenant, error: null }
                  : { data: null, error: { message: "no rows" } },
            }),
          }),
        };
      }
      if (table === "subscription_state") {
        calls.push("from:subscription_state");
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: config.subscriptionActive
                  ? { plan: "crew", subscription_status: "active" }
                  : null,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "leads") {
        calls.push("from:leads");
        return {
          insert: () => ({
            select: () => ({
              single: async () => config.leadInsert ?? { data: { id: "lead-1" }, error: null },
            }),
          }),
        };
      }
      if (table === "price_sheet_items") {
        // Only reached when lineItems is non-empty — every test below uses
        // an empty lineItems array for finalizeLeadWithQuote specifically to
        // keep this fake scoped to the subscription gate under test, not the
        // separately-tested price-sheet validation logic.
        throw new Error(
          "fakeAdmin: unexpected price_sheet_items query — test should use empty lineItems",
        );
      }
      throw new Error(`fakeAdmin: unexpected table "${table}"`);
    },
    rpc: async (name: string) => {
      calls.push(`rpc:${name}`);
      if (name === "increment_tenant_ip_usage") return { data: 1, error: null };
      if (name === "update_lead_with_line_items")
        return config.updateLead ?? { data: "lead-1", error: null };
      throw new Error(`fakeAdmin: unexpected rpc "${name}"`);
    },
  };
  return { client: client as unknown as ReturnType<typeof getAdminClient>, calls };
}

const baseClarifyingInput = {
  tenantSlug: "acme",
  customerName: "Jane Doe",
  phone: "+15551234567",
  channel: "Widget" as const,
  photoUrl: "",
  problem: "Leaky faucet",
};

const baseFinalizeInput = {
  leadId: "lead-1",
  tenantSlug: "acme",
  customerName: "Jane Doe",
  phone: "+15551234567",
  channel: "Widget" as const,
  problem: "Leaky faucet",
  diagnosis: "Worn washer",
  confidence: "High" as const,
  lineItems: [] as Array<{
    description: string;
    qty: number;
    unit: string;
    rate: number;
    priceSheetItemId?: string | null | undefined;
    hours?: number | undefined;
  }>,
};

describe("performCreateClarifyingLead — subscription gate (Task B)", () => {
  it("rejects a canceled/unsubscribed tenant and never writes a lead", async () => {
    const { client, calls } = fakeAdmin({
      tenant: { id: "tenant-1", user_id: "owner-1" },
      subscriptionActive: false,
    });
    await expect(performCreateClarifyingLead(client, baseClarifyingInput)).rejects.toThrow(
      INTAKE_UNAVAILABLE_MESSAGE,
    );
    expect(calls).not.toContain("from:leads");
  });

  it("gives the exact same rejection message for a nonexistent tenant slug — callers cannot distinguish the two cases", async () => {
    const { client: missingTenantClient } = fakeAdmin({ tenant: null, subscriptionActive: false });
    const { client: inactiveClient } = fakeAdmin({
      tenant: { id: "tenant-1", user_id: "owner-1" },
      subscriptionActive: false,
    });
    const [missingErr, inactiveErr] = await Promise.all([
      performCreateClarifyingLead(missingTenantClient, baseClarifyingInput).catch(
        (e: Error) => e.message,
      ),
      performCreateClarifyingLead(inactiveClient, baseClarifyingInput).catch(
        (e: Error) => e.message,
      ),
    ]);
    expect(missingErr).toBe(INTAKE_UNAVAILABLE_MESSAGE);
    expect(inactiveErr).toBe(INTAKE_UNAVAILABLE_MESSAGE);
  });

  it("an active-subscription tenant's legitimate request still creates the lead", async () => {
    const { client, calls } = fakeAdmin({
      tenant: { id: "tenant-1", user_id: "owner-1" },
      subscriptionActive: true,
      leadInsert: { data: { id: "lead-42" }, error: null },
    });
    const result = await performCreateClarifyingLead(client, baseClarifyingInput);
    expect(result).toEqual({ id: "lead-42" });
    expect(calls).toContain("from:leads");
  });
});

describe("performFinalizeLeadWithQuote — subscription gate (Task B)", () => {
  it("rejects a canceled/unsubscribed tenant and never finalizes the lead", async () => {
    const { client, calls } = fakeAdmin({
      tenant: { id: "tenant-1", user_id: "owner-1" },
      subscriptionActive: false,
    });
    await expect(performFinalizeLeadWithQuote(client, baseFinalizeInput)).rejects.toThrow(
      INTAKE_UNAVAILABLE_MESSAGE,
    );
    expect(calls).not.toContain("rpc:update_lead_with_line_items");
  });

  it("gives the exact same rejection message for a nonexistent tenant slug — callers cannot distinguish the two cases", async () => {
    const { client: missingTenantClient } = fakeAdmin({ tenant: null, subscriptionActive: false });
    const { client: inactiveClient } = fakeAdmin({
      tenant: { id: "tenant-1", user_id: "owner-1" },
      subscriptionActive: false,
    });
    const [missingErr, inactiveErr] = await Promise.all([
      performFinalizeLeadWithQuote(missingTenantClient, baseFinalizeInput).catch(
        (e: Error) => e.message,
      ),
      performFinalizeLeadWithQuote(inactiveClient, baseFinalizeInput).catch(
        (e: Error) => e.message,
      ),
    ]);
    expect(missingErr).toBe(INTAKE_UNAVAILABLE_MESSAGE);
    expect(inactiveErr).toBe(INTAKE_UNAVAILABLE_MESSAGE);
  });

  it("an active-subscription tenant's legitimate request still finalizes the lead", async () => {
    const { client, calls } = fakeAdmin({
      tenant: { id: "tenant-1", user_id: "owner-1" },
      subscriptionActive: true,
      updateLead: { data: "lead-1", error: null },
    });
    const result = await performFinalizeLeadWithQuote(client, baseFinalizeInput);
    expect(result).toEqual({ id: "lead-1", total: 0 });
    expect(calls).toContain("rpc:update_lead_with_line_items");
  });
});
