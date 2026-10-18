import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Mocked ONLY for the "claim-loss must still notify the owner" integration
// tests near the bottom of this file (handleInboundWhatsAppMessage). Every
// other describe block in this file tests smaller, already-exported units
// directly and does not depend on these mocks. getAdminClient is mocked so
// handleInboundWhatsAppMessage's own internal `getAdminClient()` call
// returns a fake admin we control per test, instead of a real Supabase
// client. getQuoteEstimate/getFollowUpAnswer are mocked purely so a test
// can assert they're never called when a lead-slot claim is lost — the
// actual bug this fix addresses is entirely about what happens WITHOUT
// ever reaching the AI pipeline.
vi.mock("@/lib/public-lead-server", () => ({
  getAdminClient: vi.fn(),
  createLead: vi.fn(),
  createClarifyingLead: vi.fn(),
  createFlaggedLead: vi.fn(),
  finalizeLeadWithQuote: vi.fn(),
}));
vi.mock("@/lib/estimate-server", () => ({
  getQuoteEstimate: vi.fn(),
  getFollowUpAnswer: vi.fn(),
  classifyFollowUpIntent: vi.fn(),
  NO_DESCRIPTION_PLACEHOLDER: "no description provided",
  UNSUPPORTED_IMAGE_MESSAGE: "unsupported image message",
}));
vi.mock("@/lib/notify-server", () => ({
  sendFollowUpNotificationEmail: vi.fn(),
}));

import {
  decideLeadRoute,
  sendGuardedReply,
  handleLoopGuardPause,
  handleInboundWhatsAppMessage,
  withLeadProcessingClaim,
  LOOP_PAUSE_MESSAGE,
  type ChannelAdapter,
  type InboundWhatsAppTenant,
} from "./whatsapp-conversation-server";
import { claimLoopNotice } from "./whatsapp-loop-guard-server";
import { getAdminClient } from "@/lib/public-lead-server";
import { getQuoteEstimate, classifyFollowUpIntent, getFollowUpAnswer } from "@/lib/estimate-server";
import { sendFollowUpNotificationEmail } from "@/lib/notify-server";

// Structural regression guard for "every automated outbound path must go
// through the guard" (the central finding of a prior adversarial review:
// most send sites bypassed the guard entirely). Rather than hand-write an
// integration test per branch — expensive to maintain and easy to miss a
// NEW branch added later — this asserts directly against the source that
// there are exactly two raw adapter.sendMessage(...) call sites left in
// the whole file: the one inside handleLoopGuardPause itself (the actual
// pause-notice send, gated by the atomic notice claim) and the one inside
// sendGuardedReply itself (the actual guarded send, reached only after the
// guard check passes). Every other outbound message in this file — the
// clarifying question, the final quote, the follow-up answer, the
// pre-lead greeting, every error/unsupported-image/out-of-scope fallback
// — must call sendGuardedReply instead. Adding a new direct
// adapter.sendMessage(...) call anywhere else in this file will fail this
// test immediately.
describe("every outbound WhatsApp send goes through the guard (structural check)", () => {
  it("has exactly two raw adapter.sendMessage(...) call sites — both inside the guard's own chokepoints", () => {
    const sourcePath = fileURLToPath(new URL("./whatsapp-conversation-server.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf-8");
    const matches = source.match(/adapter\.sendMessage\(/g) ?? [];
    expect(matches).toHaveLength(2);
  });
});

// decideLeadRoute's own doc comment documents a specific, previously
// live-confirmed defect this ordering fixes: needs_human_review once had
// its own permanently-sticky routing for every later message in the same
// 48h window, including an unrelated new request. These cases lock in the
// corrected behavior.
describe("decideLeadRoute", () => {
  it("routes to fresh_quote when there's no open lead at all", () => {
    expect(decideLeadRoute(null)).toBe("fresh_quote");
    expect(decideLeadRoute(undefined)).toBe("fresh_quote");
  });

  it("routes to continue_clarification for a lead with no confidence and no flag", () => {
    expect(decideLeadRoute({ confidence: null, flag_type: null })).toBe("continue_clarification");
  });

  it("routes to quoted_follow_up once a lead has a real confidence value", () => {
    expect(decideLeadRoute({ confidence: "High", flag_type: null })).toBe("quoted_follow_up");
  });

  it("routes a flagged, never-quoted lead (outside_service_scope) to fresh_quote", () => {
    expect(decideLeadRoute({ confidence: null, flag_type: "outside_service_scope" })).toBe(
      "fresh_quote",
    );
  });

  it("routes a flagged, never-quoted lead (needs_human_review) to fresh_quote — not a sticky permanent state", () => {
    expect(decideLeadRoute({ confidence: null, flag_type: "needs_human_review" })).toBe(
      "fresh_quote",
    );
  });

  it("confidence takes priority over flag_type: a quoted-but-flagged lead (pending_negotiated_price) still routes to quoted_follow_up", () => {
    expect(decideLeadRoute({ confidence: "High", flag_type: "pending_negotiated_price" })).toBe(
      "quoted_follow_up",
    );
  });

  it("confidence takes priority over flag_type even for an unrelated flag combination", () => {
    expect(decideLeadRoute({ confidence: "Low", flag_type: "needs_human_review" })).toBe(
      "quoted_follow_up",
    );
  });
});

// ---------------------------------------------------------------------
// WhatsApp loop guard orchestration (Task: AI-to-AI / non-progressing-
// answer loop prevention). Simulated here with a stateful fake admin
// client — real-PostgreSQL concurrency/crash-simulation coverage for the
// underlying atomic RPCs themselves lives in
// scripts/pg-whatsapp-loop-guard-check.sh, not here.
// ---------------------------------------------------------------------

const TEST_TENANT: InboundWhatsAppTenant = {
  id: "tenant-1",
  slug: "acme",
  name: "Acme Handyman",
  email: "owner@example.test",
  currency: "USD",
  laborRate: 60,
  serviceCallFee: 60,
  serviceCallFeeMode: "fixed",
};
const TEST_PHONE = "+15551234567";

type FakeLeadState = { flag_type: string | null };
type FakeGuardState = { notice_status: "pending" | "sending" | "sent" | null };

function fakeLoopGuardAdmin(config: {
  evaluateResult?: {
    tripped: boolean;
    just_tripped: boolean;
    trip_reason: string | null;
    is_duplicate_content: boolean;
    duplicate_content_count: number;
    repeat_count: number;
    recent_event_count: number;
  };
  evaluateError?: { message: string };
  lead?: FakeLeadState;
  guard?: FakeGuardState;
  // How many of the FIRST mark-sent attempts fail (RPC error, not a
  // throw — matching markLoopNoticeSent's own never-throws contract)
  // before one finally succeeds. Infinity = never succeeds, for testing
  // the "retries exhausted" path.
  markSentFailTimes?: number;
}) {
  const leadState: FakeLeadState = config.lead ?? { flag_type: null };
  const guardState: FakeGuardState = config.guard ?? { notice_status: null };
  const markSentFailTimes = config.markSentFailTimes ?? 0;
  const calls = {
    leadFlagUpdateAttempted: 0,
    leadFlagUpdateApplied: 0,
    markSent: 0,
    markSentAttempts: 0,
    claimAttempted: 0,
    released: 0,
  };

  const admin = {
    rpc: async (name: string) => {
      if (name === "record_whatsapp_interaction") {
        if (config.evaluateError) return { data: null, error: config.evaluateError };
        const r = config.evaluateResult ?? {
          tripped: false,
          just_tripped: false,
          trip_reason: null,
          is_duplicate_content: false,
          duplicate_content_count: 0,
          repeat_count: 1,
          recent_event_count: 1,
        };
        return { data: [r], error: null };
      }
      if (name === "claim_whatsapp_loop_notice") {
        calls.claimAttempted++;
        // Only a 'pending' (or, in the real RPC, a stale 'sending')
        // notice can be claimed — a null or already-'sent' state claims
        // nothing, same as the real guarded UPDATE...WHERE clause.
        if (guardState.notice_status === "pending") {
          guardState.notice_status = "sending";
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      if (name === "release_whatsapp_loop_notice_claim") {
        calls.released++;
        if (guardState.notice_status === "sending") {
          guardState.notice_status = "pending";
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      if (name === "mark_whatsapp_loop_notice_sent") {
        calls.markSentAttempts++;
        if (calls.markSentAttempts <= markSentFailTimes) {
          return { data: null, error: { message: "simulated transient db error" } };
        }
        calls.markSent++;
        guardState.notice_status = "sent";
        return { data: true, error: null };
      }
      throw new Error(`fakeLoopGuardAdmin: unexpected rpc "${name}"`);
    },
    from: (table: string) => {
      if (table === "leads") {
        return {
          update: () => ({
            eq: () => ({
              // Simulates `.is("flag_type", null)` — only "applies" (and
              // only counts as applied) when the lead's current flag_type
              // really is null, exactly like the real WHERE clause.
              is: async () => {
                calls.leadFlagUpdateAttempted++;
                if (leadState.flag_type === null) {
                  leadState.flag_type = "loop_suspected";
                  calls.leadFlagUpdateApplied++;
                }
                return { error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`fakeLoopGuardAdmin: unexpected table "${table}"`);
    },
  };
  return { admin: admin as unknown as SupabaseClient, leadState, guardState, calls };
}

function fakeAdapter() {
  const sent: Array<{ to: string; body: string }> = [];
  const adapter: ChannelAdapter = {
    sendMessage: async (to, body) => {
      sent.push({ to, body });
    },
    fetchMedia: async () => ({ base64: "", mediaType: "image/jpeg" }),
  };
  return { adapter, sent };
}

describe("sendGuardedReply", () => {
  it("sends the real message and calls onSent when the guard is not tripped", async () => {
    const { admin } = fakeLoopGuardAdmin({
      evaluateResult: {
        tripped: false,
        just_tripped: false,
        trip_reason: null,
        is_duplicate_content: false,
        duplicate_content_count: 0,
        repeat_count: 1,
        recent_event_count: 1,
      },
    });
    const { adapter, sent } = fakeAdapter();
    const onSent = vi.fn(async () => {});
    const result = await sendGuardedReply({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      leadId: "lead-1",
      signature: { kind: "text", text: "hello" },
      messageText: "This estimate is $194.",
      onSent,
    });
    expect(result).toEqual({ sent: true });
    expect(sent).toEqual([{ to: TEST_PHONE, body: "This estimate is $194." }]);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("suppresses the real message and never calls onSent when the guard is tripped", async () => {
    const { admin, guardState } = fakeLoopGuardAdmin({
      evaluateResult: {
        tripped: true,
        just_tripped: true,
        trip_reason: "repeat_pattern",
        is_duplicate_content: false,
        duplicate_content_count: 0,
        repeat_count: 5,
        recent_event_count: 1,
      },
      guard: { notice_status: "pending" },
    });
    const { adapter, sent } = fakeAdapter();
    const onSent = vi.fn(async () => {});
    const result = await sendGuardedReply({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      leadId: "lead-1",
      signature: { kind: "text", text: "hello" },
      messageText: "This estimate is $194.",
      onSent,
    });
    expect(result).toEqual({ sent: false });
    expect(onSent).not.toHaveBeenCalled();
    // The real priced reply was never sent — only the generic pause notice.
    expect(sent).toEqual([{ to: TEST_PHONE, body: LOOP_PAUSE_MESSAGE }]);
    expect(guardState.notice_status).toBe("sent");
  });

  it("fails CLOSED (no automated reply) when the guard check itself errors", async () => {
    const { admin } = fakeLoopGuardAdmin({
      evaluateError: { message: "connection reset" },
      guard: { notice_status: "pending" },
    });
    const { adapter, sent } = fakeAdapter();
    const onSent = vi.fn(async () => {});
    const result = await sendGuardedReply({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      leadId: "lead-1",
      signature: { kind: "text", text: "hello" },
      messageText: "This estimate is $194.",
      onSent,
    });
    expect(result).toEqual({ sent: false });
    expect(onSent).not.toHaveBeenCalled();
    expect(sent).toEqual([{ to: TEST_PHONE, body: LOOP_PAUSE_MESSAGE }]);
  });
});

describe("handleLoopGuardPause", () => {
  it("flags a lead with no existing flag as loop_suspected", async () => {
    const { admin, leadState, calls } = fakeLoopGuardAdmin({
      lead: { flag_type: null },
      guard: { notice_status: null },
    });
    const { adapter } = fakeAdapter();
    await handleLoopGuardPause({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      leadId: "lead-1",
    });
    expect(leadState.flag_type).toBe("loop_suspected");
    expect(calls.leadFlagUpdateApplied).toBe(1);
  });

  it("never overwrites an unrelated existing flag", async () => {
    const { admin, leadState, calls } = fakeLoopGuardAdmin({
      lead: { flag_type: "needs_human_review" },
      guard: { notice_status: "pending" },
    });
    const { adapter, sent } = fakeAdapter();
    await handleLoopGuardPause({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      leadId: "lead-1",
    });
    expect(leadState.flag_type).toBe("needs_human_review"); // untouched
    expect(calls.leadFlagUpdateApplied).toBe(0); // the WHERE clause correctly prevented it
    // The phone-level pause notice still fires regardless — functional
    // safety doesn't depend on the lead-level label succeeding.
    expect(sent).toEqual([{ to: TEST_PHONE, body: LOOP_PAUSE_MESSAGE }]);
  });

  it("sends the notice once when pending, and marks it sent", async () => {
    const { admin, guardState, calls } = fakeLoopGuardAdmin({
      guard: { notice_status: "pending" },
    });
    const { adapter, sent } = fakeAdapter();
    await handleLoopGuardPause({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      leadId: null,
    });
    expect(sent).toEqual([{ to: TEST_PHONE, body: LOOP_PAUSE_MESSAGE }]);
    expect(calls.markSent).toBe(1);
    expect(guardState.notice_status).toBe("sent");
  });

  it("does not resend a notice that's already confirmed sent — the already-flagged, repeated-message case", async () => {
    const { admin, calls } = fakeLoopGuardAdmin({ guard: { notice_status: "sent" } });
    const { adapter, sent } = fakeAdapter();
    await handleLoopGuardPause({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      leadId: null,
    });
    expect(sent).toEqual([]);
    expect(calls.markSent).toBe(0);
  });

  it("concurrent notice claims: only one of two simultaneous callers actually sends — the race a prior review found", async () => {
    const { admin, calls } = fakeLoopGuardAdmin({ guard: { notice_status: "pending" } });
    const { adapter, sent } = fakeAdapter();
    // Not awaited individually — both start before either finishes, the
    // same shape as two near-simultaneous inbound messages both reaching
    // handleLoopGuardPause for the same (tenant, phone).
    const p1 = handleLoopGuardPause({ admin, tenant: TEST_TENANT, fromPhone: TEST_PHONE, adapter, leadId: null });
    const p2 = handleLoopGuardPause({ admin, tenant: TEST_TENANT, fromPhone: TEST_PHONE, adapter, leadId: null });
    await Promise.all([p1, p2]);
    expect(calls.claimAttempted).toBe(2);
    expect(sent).toHaveLength(1); // the loser never sent at all
    expect(calls.markSent).toBe(1);
  });

  it("leaves notice_status pending (for retry) when the send itself fails — at-least-once, not falsely marked sent", async () => {
    const { admin, guardState, calls } = fakeLoopGuardAdmin({
      guard: { notice_status: "pending" },
    });
    const failingAdapter: ChannelAdapter = {
      sendMessage: async () => {
        throw new Error("provider timeout");
      },
      fetchMedia: async () => ({ base64: "", mediaType: "image/jpeg" }),
    };
    await handleLoopGuardPause({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter: failingAdapter,
      leadId: null,
    });
    expect(calls.markSent).toBe(0);
    expect(calls.released).toBe(1); // claim explicitly released, not left stuck in 'sending'
    expect(guardState.notice_status).toBe("pending"); // never falsely marked sent
  });

  it("retries confirming a successful send after a transient DB error, and succeeds on a later attempt", async () => {
    const { admin, guardState, calls } = fakeLoopGuardAdmin({
      guard: { notice_status: "pending" },
      markSentFailTimes: 2, // fails the first 2 attempts, succeeds on the 3rd
    });
    const { adapter, sent } = fakeAdapter();
    await handleLoopGuardPause({ admin, tenant: TEST_TENANT, fromPhone: TEST_PHONE, adapter, leadId: null });
    expect(sent).toEqual([{ to: TEST_PHONE, body: LOOP_PAUSE_MESSAGE }]); // sent exactly once
    expect(calls.markSentAttempts).toBe(3);
    expect(calls.markSent).toBe(1);
    expect(guardState.notice_status).toBe("sent"); // eventually confirmed
    expect(calls.released).toBe(0); // never released — the retries succeeded, no need
  });

  it("a prior review found this failure silently ignored: when mark-sent fails every retry after a CONFIRMED send, the claim is left in 'sending' — never released, never re-sent immediately", async () => {
    const { admin, guardState, calls } = fakeLoopGuardAdmin({
      guard: { notice_status: "pending" },
      markSentFailTimes: Infinity, // never succeeds
    });
    const { adapter, sent } = fakeAdapter();
    await handleLoopGuardPause({ admin, tenant: TEST_TENANT, fromPhone: TEST_PHONE, adapter, leadId: null });
    // The message was sent exactly once — this is the crux of the fix:
    // the uncertain DB-confirmation failure must never cause ANOTHER
    // immediate send of the identical notice.
    expect(sent).toEqual([{ to: TEST_PHONE, body: LOOP_PAUSE_MESSAGE }]);
    expect(calls.markSent).toBe(0);
    expect(calls.released).toBe(0); // deliberately NOT released back to 'pending'
    expect(guardState.notice_status).toBe("sending"); // left exactly here, not 'pending' (would resend) or 'sent' (would be a lie)

    // A second inbound message arriving immediately afterward must NOT
    // be able to claim and resend right away — recovery is only via the
    // existing staleness window, never an immediate retry of an
    // uncertain-but-likely-already-delivered notice.
    const immediateReclaim = await claimLoopNotice(admin, TEST_TENANT.id, TEST_PHONE);
    expect(immediateReclaim).toBe(false);
  });
});

// ---------------------------------------------------------------------
// withLeadProcessingClaim — reuses 0019_lead_write_atomicity.sql's
// existing (tenant, phone) mutex (claim_whatsapp_lead_slot /
// release_whatsapp_lead_slot, previously only used to prevent duplicate
// brand-new leads) to also prevent two near-simultaneous messages from
// concurrently processing the SAME existing lead's clarification round
// or same-job follow-up answer — a prior review found this path had no
// protection at all, risking duplicate lead_line_items inserts (not
// idempotent) and inflated loop-guard evidence. Real-PostgreSQL
// concurrency coverage for the underlying claim/release RPCs themselves
// lives in scripts/pg-migration-verification.sh, not here — this suite
// covers the TypeScript orchestration built on top of them.
// ---------------------------------------------------------------------

function fakeLeadSlotAdmin(config: { claimSucceeds?: boolean } = {}) {
  let available = config.claimSucceeds ?? true;
  const calls = { claimAttempts: 0, releaseAttempts: 0, runCount: 0 };
  const admin = {
    rpc: async (name: string) => {
      if (name === "claim_whatsapp_lead_slot") {
        calls.claimAttempts++;
        if (available) {
          available = false;
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      if (name === "release_whatsapp_lead_slot") {
        calls.releaseAttempts++;
        available = true;
        return { data: null, error: null };
      }
      throw new Error(`fakeLeadSlotAdmin: unexpected rpc "${name}"`);
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

describe("withLeadProcessingClaim", () => {
  it("runs the callback exactly once and releases the claim when the claim succeeds", async () => {
    const { admin, calls } = fakeLeadSlotAdmin();
    const ran = await withLeadProcessingClaim(admin, TEST_TENANT.id, TEST_PHONE, async () => {
      calls.runCount++;
    });
    expect(ran).toBe(true);
    expect(calls.runCount).toBe(1);
    expect(calls.claimAttempts).toBe(1);
    expect(calls.releaseAttempts).toBe(1);
  });

  it("never runs the callback when the claim is not acquired — the smallest safe response to a lost race", async () => {
    const { admin, calls } = fakeLeadSlotAdmin({ claimSucceeds: false });
    const ran = await withLeadProcessingClaim(admin, TEST_TENANT.id, TEST_PHONE, async () => {
      calls.runCount++;
    });
    expect(ran).toBe(false);
    expect(calls.runCount).toBe(0);
    expect(calls.releaseAttempts).toBe(0); // nothing was claimed, nothing to release
  });

  it("releases the claim even if the callback throws, and still propagates the error", async () => {
    const { admin, calls } = fakeLeadSlotAdmin();
    await expect(
      withLeadProcessingClaim(admin, TEST_TENANT.id, TEST_PHONE, async () => {
        throw new Error("getQuoteEstimate blew up");
      }),
    ).rejects.toThrow("getQuoteEstimate blew up");
    expect(calls.releaseAttempts).toBe(1);
  });

  it("of two concurrent attempts for the same (tenant, phone), exactly one runs its callback — preventing duplicate processing of the same round", async () => {
    const { admin, calls } = fakeLeadSlotAdmin();
    // Not awaited individually — mirrors two near-simultaneous messages
    // for the same lead both reaching this code at once.
    const p1 = withLeadProcessingClaim(admin, TEST_TENANT.id, TEST_PHONE, async () => {
      calls.runCount++;
    });
    const p2 = withLeadProcessingClaim(admin, TEST_TENANT.id, TEST_PHONE, async () => {
      calls.runCount++;
    });
    const [ran1, ran2] = await Promise.all([p1, p2]);
    expect(calls.runCount).toBe(1); // never both — no duplicate processing, no duplicate reply, no inflated guard evidence
    expect([ran1, ran2].filter(Boolean)).toHaveLength(1);
    expect([ran1, ran2].filter((r) => r === false)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------
// handleInboundWhatsAppMessage — regression coverage for the fix to a
// real regression the lead-slot-claim change introduced: the owner
// notification (and, for continue_clarification's out-of-scope case,
// the lead flag update) must fire even when the lead-slot claim is
// lost, not just when it's won. Scoped narrowly to the two affected
// branches. For every "claim lost" test, getQuoteEstimate/
// getFollowUpAnswer are asserted NEVER called — withLeadProcessingClaim
// means the AI-pipeline callback simply never runs when the claim
// fails, so there is nothing AI-related to mock or exercise in those
// cases at all.
// ---------------------------------------------------------------------

type FakeOpenLead = {
  id: string;
  customer_name: string | null;
  photo_url: string | null;
  problem: string;
  confidence: string | null;
  diagnosis: string | null;
  flag_type: string | null;
};

function chainableRead(resolved: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {
    eq: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => resolved,
  };
  return chain;
}

function fakeInboundAdmin(config: {
  openLead: FakeOpenLead;
  leadSlotClaimSucceeds: boolean;
  // The flag_type a GUARDED write should see at write time, if different
  // from openLead.flag_type at routing time — simulates a concurrent
  // write (e.g. the winning claim-holder's own processing) landing in
  // between decideLeadRoute's initial read and this call's own later
  // guarded update. Defaults to openLead.flag_type (no race).
  flagTypeAtWriteTime?: string | null;
}) {
  // Deliberately NOT the same object decideLeadRoute's initial read
  // returns — see flagTypeAtWriteTime's own comment above.
  const writeTimeState = { flag_type: config.flagTypeAtWriteTime ?? config.openLead.flag_type };
  const leadState: FakeOpenLead = { ...config.openLead };
  const calls = {
    leadMessageInserts: [] as Array<{ lead_id: string; role: string; body: string }>,
    leadUpdateAttempts: 0,
    leadUpdateApplied: 0,
    lastLeadUpdatePatch: null as Record<string, unknown> | null,
    claimAttempts: 0,
    releaseAttempts: 0,
  };

  const admin = {
    rpc: async (name: string) => {
      if (name === "record_whatsapp_interaction") {
        // Never trips in these tests — the point is to observe routing
        // and claim behavior, not loop-guard tripping (covered
        // exhaustively elsewhere in this file and in the real-Postgres
        // suite).
        return {
          data: [
            {
              tripped: false,
              just_tripped: false,
              trip_reason: null,
              is_duplicate_content: false,
              duplicate_content_count: 0,
              repeat_count: 0,
              recent_event_count: 0,
            },
          ],
          error: null,
        };
      }
      if (name === "claim_whatsapp_lead_slot") {
        calls.claimAttempts++;
        return { data: config.leadSlotClaimSucceeds, error: null };
      }
      if (name === "release_whatsapp_lead_slot") {
        calls.releaseAttempts++;
        return { data: null, error: null };
      }
      throw new Error(`fakeInboundAdmin: unexpected rpc "${name}"`);
    },
    from: (table: string) => {
      if (table === "leads") {
        return {
          select: () => chainableRead({ data: { ...leadState }, error: null }),
          update: (patch: Record<string, unknown>) => ({
            eq: () => {
              // Thenable with an attached `.is(...)`: awaiting the plain
              // `.eq(...)` result applies the update unconditionally
              // (matches the real unguarded outside_service_scope
              // update); calling `.is(col, val)` on it instead applies
              // it only when that column currently matches — same
              // never-overwrite-an-existing-flag semantics as the real
              // `WHERE flag_type IS NULL` guard, and neither path runs
              // unless actually invoked (no eager/background mutation).
              return {
                then: (resolve: (v: { error: null }) => void) => {
                  calls.leadUpdateAttempts++;
                  calls.lastLeadUpdatePatch = patch;
                  Object.assign(leadState, patch);
                  Object.assign(writeTimeState, patch);
                  calls.leadUpdateApplied++; // unconditional — always applies when reached
                  resolve({ error: null });
                },
                is: async (col: string, val: unknown) => {
                  calls.leadUpdateAttempts++;
                  calls.lastLeadUpdatePatch = patch;
                  // Checked against writeTimeState, not the routing-time
                  // leadState snapshot — see fakeInboundAdmin's own
                  // comment on flagTypeAtWriteTime for why these must be
                  // independent.
                  if ((writeTimeState as unknown as Record<string, unknown>)[col] === val) {
                    Object.assign(leadState, patch);
                    Object.assign(writeTimeState, patch);
                    calls.leadUpdateApplied++;
                  }
                  return { error: null };
                },
              };
            },
          }),
        };
      }
      if (table === "lead_messages") {
        return {
          insert: async (row: { lead_id: string; role: string; body: string }) => {
            calls.leadMessageInserts.push(row);
            return { error: null };
          },
          select: () => ({
            eq: () => ({
              order: async () => ({ data: [], error: null }),
            }),
          }),
        };
      }
      if (table === "lead_line_items") {
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      }
      if (table === "price_sheet_items") {
        // Read before every getQuoteEstimate call (claim-won path only)
        // to build its price-sheet argument — content is irrelevant
        // here since getQuoteEstimate itself is mocked.
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      }
      throw new Error(`fakeInboundAdmin: unexpected table "${table}"`);
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls, leadState };
}

describe("handleInboundWhatsAppMessage — a lost lead-slot claim must not silently suppress the owner notification", () => {
  it("continue_clarification: claim lost — owner still notified, lead flagged needs_human_review, AI pipeline never touched", async () => {
    const { admin, calls } = fakeInboundAdmin({
      openLead: {
        id: "lead-1",
        customer_name: "Jo",
        photo_url: null,
        problem: "leaky faucet",
        confidence: null,
        diagnosis: null,
        flag_type: null,
      },
      leadSlotClaimSucceeds: false,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(sendFollowUpNotificationEmail).mockClear();
    vi.mocked(getQuoteEstimate).mockClear();
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "actually also my sink is clogged",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getQuoteEstimate).not.toHaveBeenCalled(); // the claim-protected callback never ran at all
    expect(sent).toEqual([]); // no automated reply — the accepted, approved trade-off
    expect(sendFollowUpNotificationEmail).toHaveBeenCalledTimes(1);
    const emailArg = vi.mocked(sendFollowUpNotificationEmail).mock.calls[0]![0] as { body: string };
    expect(emailArg.body).toContain("actually also my sink is clogged");
    expect(calls.leadUpdateAttempts).toBe(1);
    expect(calls.leadUpdateApplied).toBe(1);
    expect(calls.lastLeadUpdatePatch?.["flag_type"]).toBe("needs_human_review");
  });

  it("continue_clarification: claim lost, AND a concurrent write already flagged the lead in the meantime — the flag update is correctly skipped, but the notification still fires", async () => {
    // flag_type is null at ROUTING time (required for decideLeadRoute to
    // reach continue_clarification at all — a lead already flagged with
    // a non-null flag_type and null confidence routes to fresh_quote
    // instead, per decideLeadRoute's own rules, so "already flagged on
    // entry" is not a reachable precondition for this specific branch).
    // flagTypeAtWriteTime simulates the realistic race this guard
    // actually protects against: the WINNING claim-holder's own
    // processing (e.g. a finalize failure elsewhere) flags this exact
    // lead in between this call's routing decision and its own later,
    // guarded write.
    const { admin, calls } = fakeInboundAdmin({
      openLead: {
        id: "lead-1",
        customer_name: "Jo",
        photo_url: null,
        problem: "leaky faucet",
        confidence: null,
        diagnosis: null,
        flag_type: null,
      },
      leadSlotClaimSucceeds: false,
      flagTypeAtWriteTime: "needs_human_review",
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(sendFollowUpNotificationEmail).mockClear();
    const { adapter } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "another message",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sendFollowUpNotificationEmail).toHaveBeenCalledTimes(1); // never suppressed
    expect(calls.leadUpdateAttempts).toBe(1); // the guarded write is still attempted...
    expect(calls.leadUpdateApplied).toBe(0); // ...but never overwrites the existing flag
  });

  it("quoted_follow_up/sameJob: claim lost — owner still notified with the customer's own message, AI pipeline never touched", async () => {
    const { admin, calls } = fakeInboundAdmin({
      openLead: {
        id: "lead-2",
        customer_name: "Sam",
        photo_url: null,
        problem: "install a ceiling fan",
        confidence: "High", // already quoted
        diagnosis: "Ceiling fan installation",
        flag_type: null,
      },
      leadSlotClaimSucceeds: false,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(sendFollowUpNotificationEmail).mockClear();
    vi.mocked(classifyFollowUpIntent).mockClear();
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ sameJob: true } as any);
    vi.mocked(getFollowUpAnswer).mockClear();
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "is that price still good?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getFollowUpAnswer).not.toHaveBeenCalled(); // the claim-protected callback never ran at all
    expect(sent).toEqual([]);
    expect(sendFollowUpNotificationEmail).toHaveBeenCalledTimes(1);
    const emailArg = vi.mocked(sendFollowUpNotificationEmail).mock.calls[0]![0] as { body: string };
    // Unlike the clarification case above, this notification was never
    // classification-dependent — it reports the customer's raw message,
    // unprefixed, exactly as it always has, claim outcome notwithstanding.
    expect(emailArg.body).toBe("is that price still good?");
    expect(calls.leadUpdateAttempts).toBe(0); // sameJob never flags a lead, claim lost or not
  });

  it("continue_clarification: claim WON and out-of-scope — flag update, reply, and notification all still fire exactly once (no regression from the fix)", async () => {
    const { admin, calls } = fakeInboundAdmin({
      openLead: {
        id: "lead-3",
        customer_name: "Pat",
        photo_url: null,
        problem: "paint a mural",
        confidence: null,
        diagnosis: null,
        flag_type: null,
      },
      leadSlotClaimSucceeds: true,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(sendFollowUpNotificationEmail).mockClear();
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(getQuoteEstimate).mockResolvedValue({ needsClarification: false, outOfScope: true } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "paint my whole house",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getQuoteEstimate).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ to: TEST_PHONE, body: "I'll pass your message along to our team." }]);
    expect(sendFollowUpNotificationEmail).toHaveBeenCalledTimes(1); // exactly once, not duplicated
    expect(calls.leadUpdateAttempts).toBe(1);
    expect(calls.leadUpdateApplied).toBe(1);
    expect(calls.lastLeadUpdatePatch?.["flag_type"]).toBe("outside_service_scope");
    expect(calls.releaseAttempts).toBe(1); // claim released after the callback completes
  });

  it("quoted_follow_up/sameJob: claim WON — notification fires exactly once (not duplicated now that it lives outside the claimed callback)", async () => {
    const { admin, calls } = fakeInboundAdmin({
      openLead: {
        id: "lead-4",
        customer_name: "Lee",
        photo_url: null,
        problem: "install a ceiling fan",
        confidence: "High",
        diagnosis: "Ceiling fan installation",
        flag_type: null,
      },
      leadSlotClaimSucceeds: true,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(sendFollowUpNotificationEmail).mockClear();
    vi.mocked(classifyFollowUpIntent).mockClear();
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ sameJob: true } as any);
    vi.mocked(getFollowUpAnswer).mockClear();
    vi.mocked(getFollowUpAnswer).mockResolvedValue("Yes, still the same price.");
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "is that price still good?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getFollowUpAnswer).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ to: TEST_PHONE, body: "Yes, still the same price." }]);
    expect(sendFollowUpNotificationEmail).toHaveBeenCalledTimes(1); // exactly once, not duplicated
    expect(calls.releaseAttempts).toBe(1);
  });
});
