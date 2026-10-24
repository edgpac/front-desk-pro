import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  performUpdateMyGreetingSettings,
  MAX_CUSTOM_GREETING_LENGTH,
  type GreetingSettingsInput,
} from "./tenant-server";

// performUpdateMyGreetingSettings is extracted into a plain function
// specifically so it's testable at all — see its own comment in
// tenant-server.ts: a bare createServerFn throws ("No Start context found
// in AsyncLocalStorage") when called directly in this test environment,
// the same empirically-confirmed limitation price-sheet-server.test.ts's
// header comment documents for saveMyPriceSheet. updateMyTenant/getMyTenant
// remain untested for the same reason — out of scope for this change.

type UpdateCall = { table: string; patch: Record<string, unknown>; column: string; value: unknown };

// Minimal fake Supabase client: records exactly what table/patch/eq-column/
// eq-value performUpdateMyGreetingSettings actually sent, so the tenant-
// scoping guarantee (always userId, never anything from `data`) is a
// provable assertion, not an inspection.
function fakeTenantsClient(opts: { error?: { message: string } } = {}) {
  const calls: UpdateCall[] = [];
  const client = {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (column: string, value: unknown) => {
          calls.push({ table, patch, column, value });
          return { error: opts.error ?? null };
        },
      }),
    }),
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const VALID_INPUT: GreetingSettingsInput = {
  greetingMode: "custom",
  customGreetingEn: "Hey there! Thanks for messaging {business_name}.",
  customGreetingEs: "¡Hola! Gracias por escribir a {business_name}.",
};

describe("performUpdateMyGreetingSettings — CRUD + persistence", () => {
  it("saves a custom greeting for both languages, scoped to the given tenant's user_id", async () => {
    const { client, calls } = fakeTenantsClient();
    const result = await performUpdateMyGreetingSettings(client, "user-A", VALID_INPUT);

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe("tenants");
    expect(calls[0]!.column).toBe("user_id");
    expect(calls[0]!.value).toBe("user-A");
    expect(calls[0]!.patch).toEqual({
      greeting_mode: "custom",
      custom_greeting_en: VALID_INPUT.customGreetingEn,
      custom_greeting_es: VALID_INPUT.customGreetingEs,
    });
  });

  it("saves recommended mode with both custom fields cleared", async () => {
    const { client, calls } = fakeTenantsClient();
    await performUpdateMyGreetingSettings(client, "user-A", {
      greetingMode: "recommended",
      customGreetingEn: "",
      customGreetingEs: "",
    });

    expect(calls[0]!.patch).toEqual({
      greeting_mode: "recommended",
      custom_greeting_en: null,
      custom_greeting_es: null,
    });
  });

  it("propagates a database error as a clear thrown Error, never swallowed", async () => {
    const { client } = fakeTenantsClient({ error: { message: "connection reset" } });
    await expect(performUpdateMyGreetingSettings(client, "user-A", VALID_INPUT)).rejects.toThrow(
      /Could not save greeting settings: connection reset/,
    );
  });
});

describe("performUpdateMyGreetingSettings — trim and empty/deleted-greeting handling", () => {
  it("trims leading/trailing whitespace before storing", async () => {
    const { client, calls } = fakeTenantsClient();
    await performUpdateMyGreetingSettings(client, "user-A", {
      greetingMode: "custom",
      customGreetingEn: "  Hi there!  ",
      customGreetingEs: "  ¡Hola!  ",
    });

    expect(calls[0]!.patch["custom_greeting_en"]).toBe("Hi there!");
    expect(calls[0]!.patch["custom_greeting_es"]).toBe("¡Hola!");
  });

  it("stores a whitespace-only custom greeting as null (deleted), not as the whitespace itself", async () => {
    const { client, calls } = fakeTenantsClient();
    await performUpdateMyGreetingSettings(client, "user-A", {
      greetingMode: "custom",
      customGreetingEn: "   ",
      customGreetingEs: "",
    });

    expect(calls[0]!.patch["custom_greeting_en"]).toBeNull();
    expect(calls[0]!.patch["custom_greeting_es"]).toBeNull();
  });
});

describe("performUpdateMyGreetingSettings — validation (empty, malformed, over-length)", () => {
  it("rejects an invalid greetingMode value", async () => {
    const { client, calls } = fakeTenantsClient();
    await expect(
      performUpdateMyGreetingSettings(client, "user-A", {
        greetingMode: "something-else" as GreetingSettingsInput["greetingMode"],
        customGreetingEn: "",
        customGreetingEs: "",
      }),
    ).rejects.toThrow(/Greeting mode must be "recommended" or "custom"/);
    expect(calls).toHaveLength(0); // rejected before ever touching the client
  });

  it("rejects non-string greeting text (malformed input bypassing the TS type)", async () => {
    const { client, calls } = fakeTenantsClient();
    await expect(
      performUpdateMyGreetingSettings(client, "user-A", {
        greetingMode: "custom",
        customGreetingEn: 12345 as unknown as string,
        customGreetingEs: "",
      }),
    ).rejects.toThrow(/Custom greeting text must be text/);
    expect(calls).toHaveLength(0);
  });

  it("rejects an over-length English greeting", async () => {
    const { client, calls } = fakeTenantsClient();
    const tooLong = "x".repeat(MAX_CUSTOM_GREETING_LENGTH + 1);
    await expect(
      performUpdateMyGreetingSettings(client, "user-A", {
        greetingMode: "custom",
        customGreetingEn: tooLong,
        customGreetingEs: "",
      }),
    ).rejects.toThrow(/English greeting is too long/);
    expect(calls).toHaveLength(0);
  });

  it("rejects an over-length Spanish greeting", async () => {
    const { client, calls } = fakeTenantsClient();
    const tooLong = "x".repeat(MAX_CUSTOM_GREETING_LENGTH + 1);
    await expect(
      performUpdateMyGreetingSettings(client, "user-A", {
        greetingMode: "custom",
        customGreetingEn: "",
        customGreetingEs: tooLong,
      }),
    ).rejects.toThrow(/Spanish greeting is too long/);
    expect(calls).toHaveLength(0);
  });

  it("accepts a greeting exactly at the length limit (boundary, not off-by-one)", async () => {
    const { client, calls } = fakeTenantsClient();
    const exact = "x".repeat(MAX_CUSTOM_GREETING_LENGTH);
    await performUpdateMyGreetingSettings(client, "user-A", {
      greetingMode: "custom",
      customGreetingEn: exact,
      customGreetingEs: "",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.patch["custom_greeting_en"]).toBe(exact);
  });
});

describe("performUpdateMyGreetingSettings — tenant isolation", () => {
  it("Tenant B's call can never write Tenant A's row: the eq(\"user_id\", ...) value is always the caller's OWN userId parameter, never anything from `data`", async () => {
    // GreetingSettingsInput has no userId/tenantId field at all — there is
    // structurally nothing in `data` that could redirect the write, even
    // if a caller tried. This test proves the runtime behavior matches
    // that structural guarantee: the eq() call is scoped by the function's
    // own userId argument, which the caller (updateMyGreetingSettings's
    // createServerFn handler) always derives from the authenticated
        // session's context.userId — never from client-supplied data.
    const { client: clientA, calls: callsA } = fakeTenantsClient();
    const { client: clientB, calls: callsB } = fakeTenantsClient();

    await performUpdateMyGreetingSettings(clientA, "user-A", VALID_INPUT);
    await performUpdateMyGreetingSettings(clientB, "user-B", VALID_INPUT);

    expect(callsA[0]!.value).toBe("user-A");
    expect(callsB[0]!.value).toBe("user-B");
    expect(callsA[0]!.value).not.toBe(callsB[0]!.value);
  });

  it("a malicious/mistaken extra field on the input object is simply ignored — only the declared greeting fields are ever written", async () => {
    const { client, calls } = fakeTenantsClient();
    const dataWithExtraField = {
      ...VALID_INPUT,
      userId: "user-B", // not a real field of GreetingSettingsInput
      tenant_id: "some-other-tenant",
    } as GreetingSettingsInput;

    await performUpdateMyGreetingSettings(client, "user-A", dataWithExtraField);

    expect(calls[0]!.value).toBe("user-A"); // still the function's own parameter
    expect(calls[0]!.patch).toEqual({
      greeting_mode: "custom",
      custom_greeting_en: VALID_INPUT.customGreetingEn,
      custom_greeting_es: VALID_INPUT.customGreetingEs,
    });
    expect(calls[0]!.patch).not.toHaveProperty("userId");
    expect(calls[0]!.patch).not.toHaveProperty("tenant_id");
  });
});
