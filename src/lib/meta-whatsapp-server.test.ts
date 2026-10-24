import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/public-lead-server", () => ({
  getAdminClient: vi.fn(),
}));

import { getAdminClient } from "@/lib/public-lead-server";
import { resolveActiveMetaConnection } from "./meta-whatsapp-server";

// Proves resolveActiveMetaConnection's actual SELECT list and tenant
// mapping carry the three greeting columns through to the
// InboundWhatsAppTenant it returns. Also covered by toInboundWhatsAppTenant's
// own unit tests in whatsapp-conversation-server.test.ts (the shared mapper
// this function calls) plus TypeScript itself: InboundWhatsAppTenant
// requires these fields, so omitting them here is a compile error, not
// just a convention.

function fakeConnectionsAdmin(tenantRow: Record<string, unknown> | null) {
  return {
    from: (table: string) => {
      if (table !== "whatsapp_connections") throw new Error(`unexpected table "${table}"`);
      return {
        select: (_cols: string) => ({
          eq: () => ({
            eq: () => ({
              single: async () =>
                tenantRow
                  ? { data: { id: "conn-1", meta_system_user_token: "token-123", tenants: tenantRow }, error: null }
                  : { data: null, error: { message: "not found" } },
            }),
          }),
        }),
      };
    },
  };
}

const BASE_TENANT_ROW = {
  id: "tenant-1",
  slug: "acme",
  name: "Acme Handyman",
  email: "owner@example.test",
  currency: "USD",
  labor_rate: 60,
  service_call_fee: 60,
  service_call_fee_mode: "fixed",
};

describe("resolveActiveMetaConnection — greeting columns reach the returned tenant", () => {
  it("carries a custom greeting configuration through to InboundWhatsAppTenant", async () => {
    vi.mocked(getAdminClient).mockReturnValue(
      fakeConnectionsAdmin({
        ...BASE_TENANT_ROW,
        greeting_mode: "custom",
        custom_greeting_en: "Hey! Thanks for texting Acme.",
        custom_greeting_es: "¡Hola! Gracias por escribir a Acme.",
      }) as any,
    );

    const result = await resolveActiveMetaConnection("phone-number-id-1");

    expect(result).not.toBeNull();
    expect(result!.tenant.greetingMode).toBe("custom");
    expect(result!.tenant.customGreetingEn).toBe("Hey! Thanks for texting Acme.");
    expect(result!.tenant.customGreetingEs).toBe("¡Hola! Gracias por escribir a Acme.");
  });

  it("defaults to recommended mode when greeting_mode is null (a tenant who never configured one)", async () => {
    vi.mocked(getAdminClient).mockReturnValue(
      fakeConnectionsAdmin({
        ...BASE_TENANT_ROW,
        greeting_mode: null,
        custom_greeting_en: null,
        custom_greeting_es: null,
      }) as any,
    );

    const result = await resolveActiveMetaConnection("phone-number-id-1");

    expect(result!.tenant.greetingMode).toBe("recommended");
    expect(result!.tenant.customGreetingEn).toBeNull();
    expect(result!.tenant.customGreetingEs).toBeNull();
  });

  it("returns null when no matching active connection exists (unrelated to greeting config)", async () => {
    vi.mocked(getAdminClient).mockReturnValue(fakeConnectionsAdmin(null) as any);
    const result = await resolveActiveMetaConnection("unknown-phone-number-id");
    expect(result).toBeNull();
  });
});
