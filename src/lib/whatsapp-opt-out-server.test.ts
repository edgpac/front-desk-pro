import { describe, expect, it } from "vitest";
import { isOptOutKeyword, isOptInKeyword, isOptedOut, OptOutCheckFailed } from "./whatsapp-opt-out-server";

// Keyword matching — the part of this feature most exposed to real
// customer text, and the part the security review specifically asked be
// tested against false positives (an EXACT match on the whole normalized
// message, never "contains" — see normalizeControlMessage's own comment
// for why a substring match would false-positive on ordinary
// conversation like "can you cancel the old quote").
describe("isOptOutKeyword", () => {
  it("matches each English keyword, case-insensitively", () => {
    for (const word of ["stop", "unsubscribe", "cancel", "quit", "end"]) {
      expect(isOptOutKeyword(word)).toBe(true);
      expect(isOptOutKeyword(word.toUpperCase())).toBe(true);
      expect(isOptOutKeyword(word[0]!.toUpperCase() + word.slice(1))).toBe(true);
    }
  });

  it("matches each Spanish keyword, case-insensitively", () => {
    for (const word of ["alto", "cancelar", "basta"]) {
      expect(isOptOutKeyword(word)).toBe(true);
      expect(isOptOutKeyword(word.toUpperCase())).toBe(true);
    }
  });

  it("handles trailing/leading punctuation and whitespace", () => {
    expect(isOptOutKeyword("STOP.")).toBe(true);
    expect(isOptOutKeyword("stop!!")).toBe(true);
    expect(isOptOutKeyword("  Stop  ")).toBe(true);
    expect(isOptOutKeyword("¡Alto!")).toBe(true);
    expect(isOptOutKeyword("\"CANCEL\"")).toBe(true);
    expect(isOptOutKeyword("stop,")).toBe(true);
  });

  it("does NOT match a keyword appearing inside ordinary conversation (false-positive guard)", () => {
    expect(isOptOutKeyword("can you cancel the old quote")).toBe(false);
    expect(isOptOutKeyword("please stop by tomorrow")).toBe(false);
    expect(isOptOutKeyword("when does my subscription end")).toBe(false);
    expect(isOptOutKeyword("quit stalling and send the quote")).toBe(false);
    expect(isOptOutKeyword("no gracias, cancelar por ahora no es lo que quiero decir, sigo interesado")).toBe(false);
  });

  it("does not match an empty or unrelated message", () => {
    expect(isOptOutKeyword("")).toBe(false);
    expect(isOptOutKeyword("hello")).toBe(false);
    expect(isOptOutKeyword("how much for a faucet repair")).toBe(false);
  });
});

describe("isOptInKeyword", () => {
  it("matches START case-insensitively and with punctuation", () => {
    expect(isOptInKeyword("start")).toBe(true);
    expect(isOptInKeyword("START")).toBe(true);
    expect(isOptInKeyword("Start!")).toBe(true);
    expect(isOptInKeyword("  start  ")).toBe(true);
  });

  it("does not match a keyword appearing inside ordinary conversation", () => {
    expect(isOptInKeyword("can we start next week")).toBe(false);
    expect(isOptInKeyword("ready to start the project")).toBe(false);
  });

  it("does not treat an opt-out keyword as an opt-in keyword or vice versa", () => {
    expect(isOptInKeyword("stop")).toBe(false);
    expect(isOptOutKeyword("start")).toBe(false);
  });
});

// isOptedOut's own timestamp-comparison logic (opted_out_at vs resumed_at)
// — the "currently opted out" derivation every enforcement point depends
// on. Tested here directly against a fake admin client rather than only
// indirectly through the RPC-backed functions, since this one has real
// branching logic worth covering on its own.
function fakeAdmin(row: { opted_out_at: string | null; resumed_at: string | null } | null, errorMsg?: string) {
  return {
    from: (table: string) => {
      if (table !== "whatsapp_opt_outs") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () =>
                errorMsg ? { data: null, error: { message: errorMsg } } : { data: row, error: null },
            }),
          }),
        }),
      };
    },
  } as any;
}

describe("isOptedOut", () => {
  it("returns false when no row exists for this (tenant, phone)", async () => {
    expect(await isOptedOut(fakeAdmin(null), "t1", "+15551234567")).toBe(false);
  });

  it("returns true when opted_out_at is set and resumed_at is null", async () => {
    expect(await isOptedOut(fakeAdmin({ opted_out_at: "2026-01-01T00:00:00Z", resumed_at: null }), "t1", "+1")).toBe(
      true,
    );
  });

  it("returns false when resumed_at is AFTER opted_out_at (currently resumed)", async () => {
    expect(
      await isOptedOut(
        fakeAdmin({ opted_out_at: "2026-01-01T00:00:00Z", resumed_at: "2026-01-02T00:00:00Z" }),
        "t1",
        "+1",
      ),
    ).toBe(false);
  });

  it("returns true when opted_out_at is AFTER resumed_at (opted out again after a prior resume)", async () => {
    expect(
      await isOptedOut(
        fakeAdmin({ opted_out_at: "2026-02-01T00:00:00Z", resumed_at: "2026-01-02T00:00:00Z" }),
        "t1",
        "+1",
      ),
    ).toBe(true);
  });

  it("fails CLOSED — throws OptOutCheckFailed rather than returning a boolean — when the read itself errors", async () => {
    await expect(isOptedOut(fakeAdmin(null, "connection refused"), "t1", "+1")).rejects.toThrow(OptOutCheckFailed);
  });
});
