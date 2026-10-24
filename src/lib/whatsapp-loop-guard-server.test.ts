import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeFactSignature,
  computeInboundContentHash,
  normalizePhone,
  evaluateInboundInteraction,
  evaluateOutboundInteraction,
  isLoopGuardTripped,
  claimLoopNotice,
  releaseLoopNoticeClaim,
  markLoopNoticeSent,
  resumeLoopGuardState,
  LoopGuardCheckFailed,
  hasPriorInboundInteraction,
} from "./whatsapp-loop-guard-server";

describe("computeFactSignature — priced", () => {
  it("dedupes and sorts item ids and amounts, so argument order never matters", () => {
    const a = computeFactSignature({
      kind: "priced",
      priceSheetItemIds: ["b", "a", "b"],
      amounts: [20, 10, 20],
    });
    const b = computeFactSignature({
      kind: "priced",
      priceSheetItemIds: ["a", "b"],
      amounts: [10, 20],
    });
    expect(a).toBe(b);
  });

  it("ignores null/undefined ids rather than treating them as a real identity", () => {
    const sig = computeFactSignature({
      kind: "priced",
      priceSheetItemIds: [null, undefined, "x"],
      amounts: [5],
    });
    expect(sig).toBe(
      computeFactSignature({ kind: "priced", priceSheetItemIds: ["x"], amounts: [5] }),
    );
  });

  it("a different amount set produces a different signature — a real price-sheet change is never masked", () => {
    const before = computeFactSignature({
      kind: "priced",
      priceSheetItemIds: ["item-1"],
      amounts: [194],
    });
    const after = computeFactSignature({
      kind: "priced",
      priceSheetItemIds: ["item-1"],
      amounts: [229],
    });
    expect(before).not.toBe(after);
  });

  it("a different item id set produces a different signature even at the same amount", () => {
    const a = computeFactSignature({
      kind: "priced",
      priceSheetItemIds: ["item-1"],
      amounts: [100],
    });
    const b = computeFactSignature({
      kind: "priced",
      priceSheetItemIds: ["item-2"],
      amounts: [100],
    });
    expect(a).not.toBe(b);
  });
});

describe("computeFactSignature — text", () => {
  it("normalizes case, punctuation, and whitespace — a paraphrase-light variant still matches", () => {
    const a = computeFactSignature({ kind: "text", text: "Can you tell me a bit more?" });
    const b = computeFactSignature({ kind: "text", text: "can you tell me a bit more" });
    expect(a).toBe(b);
  });

  it("a genuinely different question produces a different signature", () => {
    const a = computeFactSignature({ kind: "text", text: "What's the issue with the sink?" });
    const b = computeFactSignature({ kind: "text", text: "Is there a leak anywhere else?" });
    expect(a).not.toBe(b);
  });
});

describe("computeFactSignature — priced vs text never collide", () => {
  it("different kinds are namespaced apart even with similar-looking content", () => {
    const priced = computeFactSignature({ kind: "priced", priceSheetItemIds: [], amounts: [] });
    const text = computeFactSignature({ kind: "text", text: "" });
    expect(priced).not.toBe(text);
  });
});

describe("computeInboundContentHash", () => {
  it("hashes normalized text, so a paraphrase-light variant of the same content still matches", () => {
    const a = computeInboundContentHash("Still $194?", undefined);
    const b = computeInboundContentHash("still 194", undefined);
    expect(a).toBe(b);
  });

  it("a genuinely different text produces a different hash", () => {
    const a = computeInboundContentHash("Still $194?", undefined);
    const b = computeInboundContentHash("What time can you come?", undefined);
    expect(a).not.toBe(b);
  });

  it("never returns raw text — the hash reveals nothing about the message content", () => {
    const hash = computeInboundContentHash("some customer's private message", undefined);
    expect(hash).not.toContain("private");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a media-only message hashes the media reference, not a shared sentinel — two different photos never collide", () => {
    const a = computeInboundContentHash("", "media-ref-1");
    const b = computeInboundContentHash("", "media-ref-2");
    expect(a).not.toBe(b);
  });

  it("the same media reference produces the same hash (a genuine redelivery would match)", () => {
    const a = computeInboundContentHash("", "media-ref-1");
    const b = computeInboundContentHash("  ", "media-ref-1");
    expect(a).toBe(b);
  });

  it("no text and no media ref never matches anything, including itself twice", () => {
    const a = computeInboundContentHash("", undefined);
    const b = computeInboundContentHash("", undefined);
    expect(a).not.toBe(b);
  });
});

describe("normalizePhone", () => {
  it("strips spaces, parens, and dashes while preserving a leading +", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("+15551234567");
  });

  it("is a no-op on an already-normalized phone", () => {
    expect(normalizePhone("+15551234567")).toBe("+15551234567");
  });

  it("preserves digits-only input with no leading +", () => {
    expect(normalizePhone("555 123 4567")).toBe("5551234567");
  });
});

// Minimal fake — only the exact call shapes evaluateInboundInteraction/
// evaluateOutboundInteraction/isLoopGuardTripped/claimLoopNotice/
// releaseLoopNoticeClaim/markLoopNoticeSent/resumeLoopGuardState use,
// matching this codebase's existing fake-admin-client test style.
function fakeAdmin(config: {
  rpcResults?: Record<string, { data: unknown; error: { message: string } | null }>;
  selectResult?: { data: { tripped_at?: string | null } | null; error: { message: string } | null };
}): SupabaseClient {
  return {
    rpc: async (name: string) =>
      config.rpcResults?.[name] ?? { data: null, error: { message: `not configured: ${name}` } },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => config.selectResult ?? { data: null, error: null },
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("evaluateInboundInteraction / evaluateOutboundInteraction", () => {
  it("parses a successful RPC row into the typed evaluation", async () => {
    const admin = fakeAdmin({
      rpcResults: {
        record_whatsapp_interaction: {
          data: [
            {
              tripped: true,
              just_tripped: true,
              trip_reason: "repeat_pattern",
              is_duplicate_content: false,
              duplicate_content_count: 0,
              repeat_count: 5,
              recent_event_count: 7,
            },
          ],
          error: null,
        },
      },
    });
    const result = await evaluateOutboundInteraction(admin, "tenant-1", "+15551234567", {
      signature: { kind: "priced", priceSheetItemIds: ["item-1"], amounts: [194] },
      leadId: "lead-1",
    });
    expect(result).toEqual({
      tripped: true,
      justTripped: true,
      tripReason: "repeat_pattern",
      isDuplicateContent: false,
      duplicateContentCount: 0,
      repeatCount: 5,
      recentEventCount: 7,
    });
  });

  it("parses a duplicate-content trip for an inbound evaluation", async () => {
    const admin = fakeAdmin({
      rpcResults: {
        record_whatsapp_interaction: {
          data: [
            {
              tripped: true,
              just_tripped: true,
              trip_reason: "duplicate_content",
              is_duplicate_content: true,
              duplicate_content_count: 2,
              repeat_count: 0,
              recent_event_count: 2,
            },
          ],
          error: null,
        },
      },
    });
    const result = await evaluateInboundInteraction(admin, "tenant-1", "+15551234567", {
      body: "same text",
      mediaRef: undefined,
      providerMessageId: "wamid.NEW",
      leadId: null,
    });
    expect(result.tripped).toBe(true);
    expect(result.tripReason).toBe("duplicate_content");
    expect(result.isDuplicateContent).toBe(true);
  });

  it("throws LoopGuardCheckFailed on an RPC error — never silently proceeds", async () => {
    const admin = fakeAdmin({
      rpcResults: { record_whatsapp_interaction: { data: null, error: { message: "connection reset" } } },
    });
    await expect(
      evaluateOutboundInteraction(admin, "tenant-1", "+15551234567", {
        signature: { kind: "text", text: "hi" },
        leadId: null,
      }),
    ).rejects.toThrow(LoopGuardCheckFailed);
  });

  it("throws LoopGuardCheckFailed when the RPC returns no row at all", async () => {
    const admin = fakeAdmin({ rpcResults: { record_whatsapp_interaction: { data: [], error: null } } });
    await expect(
      evaluateInboundInteraction(admin, "tenant-1", "+15551234567", {
        body: "hi",
        mediaRef: undefined,
        providerMessageId: undefined,
        leadId: null,
      }),
    ).rejects.toThrow(LoopGuardCheckFailed);
  });
});

describe("isLoopGuardTripped", () => {
  it("is false when no row exists for this (tenant, phone) yet", async () => {
    const admin = fakeAdmin({ selectResult: { data: null, error: null } });
    expect(await isLoopGuardTripped(admin, "tenant-1", "+15551234567")).toBe(false);
  });

  it("is false when a row exists but tripped_at is null", async () => {
    const admin = fakeAdmin({ selectResult: { data: { tripped_at: null }, error: null } });
    expect(await isLoopGuardTripped(admin, "tenant-1", "+15551234567")).toBe(false);
  });

  it("is true when tripped_at is set", async () => {
    const admin = fakeAdmin({
      selectResult: { data: { tripped_at: "2026-01-01T00:00:00Z" }, error: null },
    });
    expect(await isLoopGuardTripped(admin, "tenant-1", "+15551234567")).toBe(true);
  });

  it("throws LoopGuardCheckFailed on a read error — the caller must fail closed on this", async () => {
    const admin = fakeAdmin({ selectResult: { data: null, error: { message: "timeout" } } });
    await expect(isLoopGuardTripped(admin, "tenant-1", "+15551234567")).rejects.toThrow(
      LoopGuardCheckFailed,
    );
  });
});

describe("claimLoopNotice / releaseLoopNoticeClaim / markLoopNoticeSent / resumeLoopGuardState — never throw, log and return false on error", () => {
  it("claimLoopNotice returns true on a successful claim", async () => {
    const admin = fakeAdmin({ rpcResults: { claim_whatsapp_loop_notice: { data: true, error: null } } });
    expect(await claimLoopNotice(admin, "tenant-1", "+15551234567")).toBe(true);
  });

  it("claimLoopNotice returns false when no row was claimed (already sent, or already held)", async () => {
    const admin = fakeAdmin({ rpcResults: { claim_whatsapp_loop_notice: { data: false, error: null } } });
    expect(await claimLoopNotice(admin, "tenant-1", "+15551234567")).toBe(false);
  });

  it("claimLoopNotice returns false (not a throw) when the RPC errors", async () => {
    const admin = fakeAdmin({ rpcResults: { claim_whatsapp_loop_notice: { data: null, error: { message: "db down" } } } });
    await expect(claimLoopNotice(admin, "tenant-1", "+15551234567")).resolves.toBe(false);
  });

  it("releaseLoopNoticeClaim returns true on a successful release", async () => {
    const admin = fakeAdmin({ rpcResults: { release_whatsapp_loop_notice_claim: { data: true, error: null } } });
    expect(await releaseLoopNoticeClaim(admin, "tenant-1", "+15551234567")).toBe(true);
  });

  it("markLoopNoticeSent returns true on a successful claim", async () => {
    const admin = fakeAdmin({ rpcResults: { mark_whatsapp_loop_notice_sent: { data: true, error: null } } });
    expect(await markLoopNoticeSent(admin, "tenant-1", "+15551234567")).toBe(true);
  });

  it("markLoopNoticeSent returns false (not a throw) when the RPC errors", async () => {
    const admin = fakeAdmin({ rpcResults: { mark_whatsapp_loop_notice_sent: { data: null, error: { message: "db down" } } } });
    await expect(markLoopNoticeSent(admin, "tenant-1", "+15551234567")).resolves.toBe(false);
  });

  it("resumeLoopGuardState returns true on a successful resume, passing through the resumedBy reason", async () => {
    const admin = fakeAdmin({ rpcResults: { resume_whatsapp_loop_guard: { data: true, error: null } } });
    expect(await resumeLoopGuardState(admin, "tenant-1", "+15551234567", "dashboard_action")).toBe(true);
  });

  it("resumeLoopGuardState returns false (not a throw) when the RPC errors", async () => {
    const admin = fakeAdmin({ rpcResults: { resume_whatsapp_loop_guard: { data: null, error: { message: "db down" } } } });
    await expect(resumeLoopGuardState(admin, "tenant-1", "+15551234567", "operator_reply")).resolves.toBe(
      false,
    );
  });
});

// Records the exact table/select/eq/gte/limit calls hasPriorInboundInteraction
// makes, so the query SHAPE itself — not just a mocked true/false return —
// is a provable assertion. This is the signal whatsapp-conversation-server.ts
// combines with open-lead existence to compute isFirstContact; a wrong
// column, a wrong direction filter, or a window wider/narrower than 48
// hours would silently change who gets greeted without any test catching
// it if only the return value were checked.
function fakeInteractionEventsAdmin(row: { id: string } | null) {
  const calls = {
    table: "",
    selectCols: "",
    eqCalls: [] as Array<[string, unknown]>,
    gte: null as [string, unknown] | null,
    limit: null as number | null,
  };
  const admin = {
    from: (table: string) => {
      calls.table = table;
      return {
        select: (cols: string) => {
          calls.selectCols = cols;
          const chain = {
            eq: (col: string, val: unknown) => {
              calls.eqCalls.push([col, val]);
              return chain;
            },
            gte: (col: string, val: unknown) => {
              calls.gte = [col, val];
              return chain;
            },
            limit: (n: number) => {
              calls.limit = n;
              return chain;
            },
            maybeSingle: async () => ({ data: row, error: null }),
          };
          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

describe("hasPriorInboundInteraction", () => {
  it("queries whatsapp_interaction_events scoped to this exact tenant+phone, inbound direction only, within a 48-hour window, limited to 1 row", async () => {
    const { admin, calls } = fakeInteractionEventsAdmin(null);
    await hasPriorInboundInteraction(admin, "tenant-1", "+15551234567");

    expect(calls.table).toBe("whatsapp_interaction_events");
    expect(calls.eqCalls).toEqual([
      ["tenant_id", "tenant-1"],
      ["phone", "+15551234567"],
      ["direction", "inbound"],
    ]);
    expect(calls.gte?.[0]).toBe("occurred_at");
    // Within a few seconds of exactly 48 hours ago — not exactly equal,
    // since real time ticks between the call and this assertion.
    const gteMs = new Date(calls.gte![1] as string).getTime();
    const expectedMs = Date.now() - 48 * 60 * 60 * 1000;
    expect(Math.abs(gteMs - expectedMs)).toBeLessThan(5000);
    expect(calls.limit).toBe(1);
  });

  it("returns true when a prior inbound event exists in the window", async () => {
    const { admin } = fakeInteractionEventsAdmin({ id: "evt-1" });
    expect(await hasPriorInboundInteraction(admin, "tenant-1", "+15551234567")).toBe(true);
  });

  it("returns false when no prior inbound event exists in the window", async () => {
    const { admin } = fakeInteractionEventsAdmin(null);
    expect(await hasPriorInboundInteraction(admin, "tenant-1", "+15551234567")).toBe(false);
  });
});
