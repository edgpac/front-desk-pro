import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";
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
vi.mock("@/lib/estimate-server", async (importOriginal) => {
  // detectLanguage is real, not mocked — it's a pure, deterministic
  // pattern-matcher (see estimate-server.ts), and the whatsapp-conversation-
  // server.ts localization tests below depend on its actual Spanish-
  // detection behavior to verify real language-routing, not a fake return
  // value that would prove nothing about the real code path.
  const actual = await importOriginal<typeof import("@/lib/estimate-server")>();
  return {
    getQuoteEstimate: vi.fn(),
    getFollowUpAnswer: vi.fn(),
    classifyFollowUpIntent: vi.fn(),
    classifyFollowUpPhotoIntent: vi.fn(),
    isSupportedImageBase64: vi.fn(() => true),
    detectLanguage: actual.detectLanguage,
    NO_DESCRIPTION_PLACEHOLDER: "no description provided",
    UNSUPPORTED_IMAGE_MESSAGE: "unsupported image message",
  };
});
vi.mock("@/lib/notify-server", () => ({
  sendFollowUpNotificationEmail: vi.fn(),
}));

import {
  decideLeadRoute,
  sendGuardedReply,
  handleLoopGuardPause,
  handleInboundWhatsAppMessage,
  withLeadProcessingClaim,
  toInboundWhatsAppTenant,
  LOOP_PAUSE_MESSAGE,
  MAX_AUTOMATED_REPLIES_PER_CONVERSATION,
  type ChannelAdapter,
  type InboundWhatsAppTenant,
  type RawTenantRowForWhatsApp,
} from "./whatsapp-conversation-server";
import { claimLoopNotice } from "./whatsapp-loop-guard-server";
import { isOptedOut, normalizePhone } from "./whatsapp-opt-out-server";
import {
  getAdminClient,
  createLead,
  createFlaggedLead,
  createClarifyingLead,
  finalizeLeadWithQuote,
} from "@/lib/public-lead-server";
import {
  getQuoteEstimate,
  classifyFollowUpIntent,
  classifyFollowUpPhotoIntent,
  isSupportedImageBase64,
  getFollowUpAnswer,
} from "@/lib/estimate-server";
import { sendFollowUpNotificationEmail } from "@/lib/notify-server";

// Structural regression guard for "every automated outbound path must go
// through the guard" (the central finding of a prior adversarial review:
// most send sites bypassed the guard entirely). Rather than hand-write an
// integration test per branch — expensive to maintain and easy to miss a
// NEW branch added later — this asserts directly against the source that
// there are exactly four raw adapter.sendMessage(...) call sites left in
// the whole file, each inside its own atomically-gated chokepoint:
// handleLoopGuardPause (the pause-notice send, gated by the atomic notice
// claim), sendGuardedReply (the actual guarded send, reached only after
// the loop-guard check passes), handleOptOutConfirmation (the opt-out
// confirmation, gated by the atomic confirmation claim), and
// sendOptInConfirmation (the opt-in confirmation, reached only after
// resumeOptOut succeeds). Every other outbound message in this file — the
// clarifying question, the final quote, the follow-up answer, the
// pre-lead greeting, every error/unsupported-image/out-of-scope fallback
// — must call sendGuardedReply instead. Adding a new direct
// adapter.sendMessage(...) call anywhere else in this file will fail this
// test immediately.
describe("every outbound WhatsApp send goes through the guard (structural check)", () => {
  it("has exactly four raw adapter.sendMessage(...) call sites — all inside their own atomically-gated chokepoints", () => {
    const sourcePath = fileURLToPath(new URL("./whatsapp-conversation-server.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf-8");
    const matches = source.match(/adapter\.sendMessage\(/g) ?? [];
    expect(matches).toHaveLength(4);
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

// toInboundWhatsAppTenant is the shared mapping meta-whatsapp-server.ts's
// resolveActiveMetaConnection calls to build the tenant object passed into
// handleInboundWhatsAppMessage. Pure and DB-free, so no fakes/mocks needed.
describe("toInboundWhatsAppTenant", () => {
  const BASE_ROW: RawTenantRowForWhatsApp = {
    id: "tenant-1",
    slug: "acme",
    name: "Acme Handyman",
    email: "owner@example.test",
    currency: "USD",
    labor_rate: 60,
    service_call_fee: 60,
    service_call_fee_mode: "fixed",
    greeting_mode: "custom",
    custom_greeting_en: "Hey! Thanks for texting Acme.",
    custom_greeting_es: "¡Hola! Gracias por escribir a Acme.",
  };

  it("carries every field through, including the greeting configuration", () => {
    expect(toInboundWhatsAppTenant(BASE_ROW)).toEqual({
      id: "tenant-1",
      slug: "acme",
      name: "Acme Handyman",
      email: "owner@example.test",
      currency: "USD",
      laborRate: 60,
      serviceCallFee: 60,
      serviceCallFeeMode: "fixed",
      greetingMode: "custom",
      customGreetingEn: "Hey! Thanks for texting Acme.",
      customGreetingEs: "¡Hola! Gracias por escribir a Acme.",
    });
  });

  it('defaults greetingMode to "recommended" for any value other than exactly "custom" (null, unset, or corrupted)', () => {
    expect(toInboundWhatsAppTenant({ ...BASE_ROW, greeting_mode: null }).greetingMode).toBe("recommended");
    expect(toInboundWhatsAppTenant({ ...BASE_ROW, greeting_mode: "" }).greetingMode).toBe("recommended");
    expect(toInboundWhatsAppTenant({ ...BASE_ROW, greeting_mode: "garbage" }).greetingMode).toBe(
      "recommended",
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
  greetingMode: "recommended",
  customGreetingEn: null,
  customGreetingEs: null,
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
  // Only used by the leadId: null path (handleLoopGuardPause's own
  // by-phone lookup, matching the top-of-handleInboundWhatsAppMessage call
  // site). Defaults to "no lead found" — the overwhelming majority of
  // existing tests pass a real leadId directly and never exercise this
  // lookup at all.
  leadForPhoneLookup?: { id: string; flag_type: string | null } | null;
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
      // Opt-out is a separate concern from this file's own loop-guard
      // tests — none of them send an opt-out keyword, so this is never
      // expected to actually fire, just present so isOptedOut's read
      // doesn't throw "unexpected table" below for an unrelated feature.
      if (name === "record_whatsapp_opt_out") {
        return { data: [{ just_opted_out: true }], error: null };
      }
      throw new Error(`fakeLoopGuardAdmin: unexpected rpc "${name}"`);
    },
    from: (table: string) => {
      if (table === "whatsapp_opt_outs") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          }),
        };
      }
      if (table === "leads") {
        return {
          // Covers both read shapes handleLoopGuardPause now uses: the
          // leadId-provided path (.select("flag_type").eq("id", ...)) and
          // the leadId: null, by-phone lookup path (.select("id,
          // flag_type").eq(...).eq(...).gte(...).order(...).limit(...)) —
          // both resolve through the same chainable object, terminating
          // at maybeSingle(), same pattern as chainableRead elsewhere in
          // this file.
          select: () => {
            const chain: Record<string, unknown> = {
              eq: () => chain,
              gte: () => chain,
              order: () => chain,
              limit: () => chain,
              maybeSingle: async () => ({
                data:
                  config.leadForPhoneLookup !== undefined
                    ? config.leadForPhoneLookup
                    : { flag_type: leadState.flag_type },
                error: null,
              }),
            };
            return chain;
          },
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

  it("never overwrites an unrelated existing flag, and the pause notice still fires for a flag that doesn't mean 'already handed off'", async () => {
    // pending_negotiated_price — not one of the "customer was already sent
    // a real handoff message" flags (see ALREADY_HANDED_OFF_FLAG_TYPES),
    // so suppression must not apply here. needs_human_review is covered by
    // its own dedicated suppression test below instead — that flag DOES
    // suppress the notice now, which this test previously (incorrectly,
    // per the production regression that prompted the fix) asserted it
    // didn't.
    const { admin, leadState, calls } = fakeLoopGuardAdmin({
      lead: { flag_type: "pending_negotiated_price" },
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
    expect(leadState.flag_type).toBe("pending_negotiated_price"); // untouched
    expect(calls.leadFlagUpdateApplied).toBe(0); // the WHERE clause correctly prevented it
    // The phone-level pause notice still fires regardless — functional
    // safety doesn't depend on the lead-level label succeeding.
    expect(sent).toEqual([{ to: TEST_PHONE, body: LOOP_PAUSE_MESSAGE }]);
  });

  // PRODUCTION REGRESSION: a real conversation showed "I'll pass your
  // message along to our team." (outOfScope handoff) immediately followed,
  // on the customer's very next message, by this same generic pause
  // notice — redundant, since they were just told exactly that. The trip
  // state itself (and the resulting pause on future automated replies)
  // lives entirely in whatsapp_loop_guards, untouched by this — only the
  // repeat customer-facing text is suppressed.
  it("suppresses the pause notice when the lead was already flagged outside_service_scope (handoff already communicated)", async () => {
    const { admin, calls } = fakeLoopGuardAdmin({
      lead: { flag_type: "outside_service_scope" },
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
    expect(sent).toEqual([]);
    expect(calls.claimAttempted).toBe(0); // never even attempts to claim the notice slot
    expect(calls.markSent).toBe(0);
  });

  it("suppresses the pause notice when the lead was already flagged needs_human_review (handoff already communicated)", async () => {
    const { admin, calls } = fakeLoopGuardAdmin({
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
    expect(sent).toEqual([]);
    expect(calls.claimAttempted).toBe(0);
    expect(calls.markSent).toBe(0);
  });

  // Exercises the leadId: null path specifically (the real top-of-
  // handleInboundWhatsAppMessage call site, which never has a lead id in
  // hand) — confirms the by-phone lookup correctly finds the open lead and
  // still suppresses when it's already flagged outside_service_scope.
  it("suppresses the pause notice via the by-phone lookup when called with leadId: null and an open, already-flagged lead exists", async () => {
    const { admin, calls } = fakeLoopGuardAdmin({
      guard: { notice_status: "pending" },
      leadForPhoneLookup: { id: "lead-found-by-phone", flag_type: "outside_service_scope" },
    });
    const { adapter, sent } = fakeAdapter();
    await handleLoopGuardPause({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      leadId: null,
    });
    expect(sent).toEqual([]);
    expect(calls.claimAttempted).toBe(0);
  });

  it("still sends the pause notice via the by-phone lookup when called with leadId: null and no open lead exists at all", async () => {
    const { admin, calls } = fakeLoopGuardAdmin({
      guard: { notice_status: "pending" },
      leadForPhoneLookup: null,
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
    expect(calls.claimAttempted).toBe(1);
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
    const p1 = handleLoopGuardPause({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      leadId: null,
    });
    const p2 = handleLoopGuardPause({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      leadId: null,
    });
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
    await handleLoopGuardPause({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      leadId: null,
    });
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
    await handleLoopGuardPause({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      leadId: null,
    });
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

// Supports two different real call shapes against the same fake data:
// a single-row read ending in `.maybeSingle()` (resolves to `resolved`
// as-is), and a list read that's awaited directly off `.limit()` with no
// `.maybeSingle()` call at all (countRecentOutboundInteractions's shape) —
// made thenable so `await chain` resolves to `{data: [...], error}`,
// treating `resolved.data` as "one row" when truthy and "zero rows"
// when null, which is all any existing caller of this helper needs: every
// current use of a null/single-object `resolved` only ever needs to prove
// "fewer than the cap" to this file's own MAX_AUTOMATED_REPLIES_PER_CONVERSATION
// check, not a specific exact count.
function chainableRead(resolved: { data: unknown; error: unknown }) {
  const listResolved = {
    data: resolved.data ? [resolved.data] : [],
    error: resolved.error,
  };
  const chain: Record<string, unknown> = {
    eq: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => resolved,
    then: (resolvePromise: (v: typeof listResolved) => void) => resolvePromise(listResolved),
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
  // Photo-intelligence Priority 2: the existing lead's already-priced line
  // items, read by handleQuotedFollowUpPhoto to decide whether a
  // reassessment is materially different. Defaults to [] (no existing
  // priced work) — every pre-existing test that doesn't pass this gets
  // identical behavior to before this field existed.
  existingLineItems?: Array<{ description: string; rate: number; qty: number }>;
  // Proves the loop guard still gates every reply this new photo-handling
  // code produces, same as every other branch in this file. Defaults to
  // false (not tripped) — identical to every pre-existing test's implicit
  // behavior before this field existed.
  loopGuardTripped?: boolean;
  // How many prior automated replies countRecentOutboundInteractions
  // should report for this (tenant, phone) — defaults to 1, same "present,
  // below MAX_AUTOMATED_REPLIES_PER_CONVERSATION" value every pre-existing
  // test already implicitly relied on. Set to 2+ to exercise the
  // automated-reply cap itself.
  outboundInteractionCount?: number;
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
        // Only trips when a test explicitly asks it to (loopGuardTripped) —
        // otherwise the point is to observe routing and claim behavior,
        // not loop-guard tripping (covered exhaustively elsewhere in this
        // file and in the real-Postgres suite).
        return {
          data: [
            {
              tripped: Boolean(config.loopGuardTripped),
              just_tripped: Boolean(config.loopGuardTripped),
              trip_reason: config.loopGuardTripped ? "repeat_pattern" : null,
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
      // Opt-out is a separate concern from this file's own lead-routing
      // tests — none of them send an opt-out keyword, so this is never
      // expected to actually fire, just present so isOptedOut's read
      // doesn't throw "unexpected table" below for an unrelated feature.
      if (name === "record_whatsapp_opt_out") {
        return { data: [{ just_opted_out: true }], error: null };
      }
      // Minimal stubs for the loop-guard-pause path, reached only when a
      // test sets loopGuardTripped — real state-tracking for these lives
      // in fakeLoopGuardAdmin above; here they just need to not throw.
      if (name === "claim_whatsapp_loop_notice") {
        return { data: true, error: null };
      }
      if (
        name === "release_whatsapp_loop_notice_claim" ||
        name === "mark_whatsapp_loop_notice_sent"
      ) {
        return { data: true, error: null };
      }
      throw new Error(`fakeInboundAdmin: unexpected rpc "${name}"`);
    },
    from: (table: string) => {
      if (table === "whatsapp_opt_outs") {
        return { select: () => chainableRead({ data: null, error: null }) };
      }
      if (table === "whatsapp_interaction_events") {
        // Single-row (.maybeSingle()) shape: value is irrelevant — every
        // test using this fixture always configures a real openLead, so
        // isFirstContact is already false from that alone. List shape
        // (awaited directly off .limit()): countRecentOutboundInteractions'
        // own call — outboundInteractionCount controls how many rows come
        // back, capped to whatever `n` the real code asked for.
        const outboundCount = config.outboundInteractionCount ?? 1;
        const chain: Record<string, unknown> = {
          eq: () => chain,
          gte: () => chain,
          limit: (n: number) => ({
            ...chain,
            then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
              resolve({ data: Array(Math.min(outboundCount, n)).fill({ id: "evt-1" }), error: null }),
          }),
          maybeSingle: async () => ({ data: { id: "evt-1" }, error: null }),
        };
        return { select: () => chain };
      }
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
        return {
          select: () => ({
            eq: async () => ({ data: config.existingLineItems ?? [], error: null }),
          }),
        };
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
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "same_job" } as any);
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
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: true,
    } as any);
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

  // PRODUCTION REGRESSION: a real customer said "Not cooling and needs a
  // clean" about an air conditioner the business doesn't service. The
  // out-of-scope decision itself was correct (confirmed against the real
  // tenant's price sheet — no AC/HVAC item exists), but the handoff reply
  // was a cold, generic "I'll pass your message along to our team." with
  // no acknowledgment of what was actually said. getQuoteEstimate now
  // returns an optional "acknowledgment" alongside outOfScope: true; this
  // confirms it's actually used when present, in the customer's own
  // detected language, and that its absence still falls back to the exact
  // same message as before (no regression for a model response that omits
  // it).
  it('out-of-scope handoff includes the AI-generated "acknowledgment" of what the customer described, when present', async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-ac",
        customer_name: "Susana",
        photo_url: null,
        problem: "air conditioner question",
        confidence: null,
        diagnosis: null,
        flag_type: null,
      },
      leadSlotClaimSucceeds: true,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: true,
      acknowledgment: "Got it — AC maintenance and cleaning.",
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Not cooling and needs a clean",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toEqual([
      {
        to: TEST_PHONE,
        body: "Got it — AC maintenance and cleaning. I'll pass your message along to our team.",
      },
    ]);
  });

  it("out-of-scope handoff falls back to the plain hand-off message when the model omits acknowledgment", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-ac-2",
        customer_name: "Susana",
        photo_url: null,
        problem: "air conditioner question",
        confidence: null,
        diagnosis: null,
        flag_type: null,
      },
      leadSlotClaimSucceeds: true,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: true,
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Not cooling and needs a clean",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toEqual([{ to: TEST_PHONE, body: "I'll pass your message along to our team." }]);
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
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "same_job" } as any);
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

// ---------------------------------------------------------------------
// PRODUCTION REGRESSION (reported via screenshot): an existing, already-
// quoted kitchen-faucet lead ($120, diagnosis "Standard kitchen faucet
// replacement") received a follow-up text about a water heater ("Check
// for water heater at Home Depot") — topically unrelated to the open
// lead. classifyFollowUpIntent's old sameJob:boolean shape had no way to
// express "I can't tell" for a terse, unrelated reply like this, so it
// got forced into "same job," and getFollowUpAnswer answered using the
// faucet's own diagnosis and $120 estimate — a long, confident-sounding
// answer about completely the wrong job. These tests drive the real
// classification outcomes a corrected classifier call should produce for
// this situation and confirm the orchestration code never lets the old
// job's diagnosis, line items, or price leak into the new topic.
// ---------------------------------------------------------------------

const QUOTED_FAUCET_LEAD: FakeOpenLead = {
  id: "lead-faucet-1",
  customer_name: "Jordan",
  photo_url: null,
  problem: "kitchen faucet is leaking",
  confidence: "High",
  diagnosis: "Standard kitchen faucet replacement",
  flag_type: null,
};

describe("quoted_follow_up text classification — three-way (same_job / different_job / ambiguous)", () => {
  beforeEach(() => {
    vi.mocked(getFollowUpAnswer).mockClear();
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(classifyFollowUpIntent).mockClear();
    vi.mocked(createLead).mockClear();
  });

  it('classification="different_job": a message about an unrelated appliance gets its own fresh quote, never the faucet\'s diagnosis or $120', async () => {
    const { admin } = fakeInboundAdmin({ openLead: QUOTED_FAUCET_LEAD, leadSlotClaimSucceeds: true });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "different_job" } as any);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "Plumbing",
      severity: "Low",
      confidence: "High",
      diagnosis: "Water heater replacement.",
      isDiagnosisOnly: false,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        {
          description: "Water heater replacement",
          detail: "",
          amount: 850,
          priceSheetItemId: "ps-water-heater",
          hours: undefined,
        },
      ],
      totalLow: 850,
      totalHigh: 850,
    } as any);
    vi.mocked(createLead).mockResolvedValue({ id: "new-water-heater-lead" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Check for water heater at Home Depot",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    // The whole point: getFollowUpAnswer (which answers USING the old
    // lead's diagnosis/line items) must never run for a different job.
    expect(getFollowUpAnswer).not.toHaveBeenCalled();
    expect(getQuoteEstimate).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body).toContain("Water heater replacement");
    expect(body).not.toContain("faucet");
    expect(body).not.toContain("120");
    expect(body).toContain("850");
  });

  it('classification="ambiguous": asks one short clarifying question instead of quoting the old job — no lead created, no AI pricing call made', async () => {
    const { admin } = fakeInboundAdmin({ openLead: QUOTED_FAUCET_LEAD, leadSlotClaimSucceeds: true });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "ambiguous" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Check for water heater at Home Depot",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getFollowUpAnswer).not.toHaveBeenCalled();
    expect(getQuoteEstimate).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body).toBe("Is this about the job I already quoted, or something different you'd like priced?");
    expect(body).not.toContain("faucet");
    expect(body).not.toContain("120");
  });

  it('classification="ambiguous" in Spanish: the clarifying question is localized, never defaults to English', async () => {
    const { admin } = fakeInboundAdmin({
      openLead: { ...QUOTED_FAUCET_LEAD, problem: "tengo una fuga en la llave de la cocina" },
      leadSlotClaimSucceeds: true,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "ambiguous" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "¿Puede revisar el calentador de agua en Home Depot?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe(
      "¿Esto es sobre el trabajo que ya cotizamos, o es algo diferente que le gustaría que cotizáramos?",
    );
  });

  it('classification="same_job" (regression guard): a genuine follow-up on the SAME job still answers normally, unaffected by the new ambiguous branch', async () => {
    const { admin } = fakeInboundAdmin({ openLead: QUOTED_FAUCET_LEAD, leadSlotClaimSucceeds: true });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "same_job" } as any);
    vi.mocked(getFollowUpAnswer).mockResolvedValue("Yes, still $120 for the faucet.");
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
    expect(getQuoteEstimate).not.toHaveBeenCalled();
    expect(sent).toEqual([{ to: TEST_PHONE, body: "Yes, still $120 for the faucet." }]);
  });
});

// ---------------------------------------------------------------------
// Photo-intelligence Priority 2 (2026-10-19): a photo attached to an
// already-quoted lead's follow-up used to be treated unconditionally as
// proof of a brand-new job. These tests cover the replacement behavior —
// classify using the photo itself plus the prior job's context, and only
// ever reassess (or ask) rather than assume. Real-image vision-input
// coverage (does the photo actually reach the model) lives in
// estimate-server.test.ts; these tests exercise the TypeScript-level
// orchestration against a stateful fake admin/adapter, with
// classifyFollowUpPhotoIntent/getQuoteEstimate/finalizeLeadWithQuote
// mocked so each test drives one specific classification outcome.
// ---------------------------------------------------------------------

// PRODUCTION REGRESSION (2026-10-24): a real conversation (Spanish,
// multiple issues) got flagged needs_human_review after clarification
// failed, then kept spinning up brand-new, context-free leads on every
// short follow-up — decideLeadRoute routes a flagged lead's next message
// to fresh_quote, which has no memory of anything. Two compounding
// symptoms: the reply language flipped to English (a captionless photo/
// one-word reply has no Spanish signal of its own), and the same
// disambiguating question got asked over and over (each round was fed
// only that one short message, nothing else). The customer explicitly
// said the AI put them through "too much work" and gave up. These tests
// cover the fix: a hard, lead-agnostic cap on automated replies.
describe("handleInboundWhatsAppMessage — strict automated-reply cap", () => {
  it("hands off with the fixed message, in the conversation's actual language, instead of engaging further once the cap is reached — regardless of lead/route state", async () => {
    const { admin, calls } = fakeInboundAdmin({
      openLead: {
        id: "lead-1",
        customer_name: "Julie",
        photo_url: null,
        problem: "varias cosas. triturador de basura roto.",
        confidence: null,
        diagnosis: null,
        flag_type: "needs_human_review",
      },
      leadSlotClaimSucceeds: true,
      outboundInteractionCount: MAX_AUTOMATED_REPLIES_PER_CONVERSATION,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockClear();
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Fixed",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getQuoteEstimate).not.toHaveBeenCalled(); // never reaches the AI pipeline at all
    expect(sent).toEqual([
      { to: TEST_PHONE, body: "Mensaje recibido — alguien de nuestro equipo se pondrá en contacto." },
    ]);
    expect(calls.leadUpdateApplied).toBe(1);
    expect(calls.lastLeadUpdatePatch?.["flag_type"]).toBe("needs_human_review");
  });

  it("replies in English when the conversation's own history is English, not Spanish by default", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-2",
        customer_name: "Sam",
        photo_url: null,
        problem: "the dryer stopped heating",
        confidence: null,
        diagnosis: null,
        flag_type: "needs_human_review",
      },
      leadSlotClaimSucceeds: true,
      outboundInteractionCount: MAX_AUTOMATED_REPLIES_PER_CONVERSATION,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "ok",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toEqual([{ to: TEST_PHONE, body: "Message received — someone from our team will reach out." }]);
  });

  it("still engages normally (reaches the AI pipeline) when fewer than the cap have been sent", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-1",
        customer_name: "Jo",
        photo_url: null,
        problem: "leaky faucet",
        confidence: null,
        diagnosis: null,
        flag_type: null,
      },
      leadSlotClaimSucceeds: true,
      outboundInteractionCount: MAX_AUTOMATED_REPLIES_PER_CONVERSATION - 1,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: true,
      questions: [{ question: "Which one?", options: ["A", "B"] }],
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "another detail",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getQuoteEstimate).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });
});

// PRODUCTION REGRESSION companion tests (same incident as the cap tests
// above, a round BEFORE the cap trips): language must not reset to English
// mid-conversation. Two distinct code paths both detected language from
// the current message alone before this fix — the thin-description
// short-circuit (any reply ≤10 chars with no media, e.g. "Fixed") and
// handleFreshQuote's main body (anything longer, e.g. "Thanks anywaya" —
// the exact text that produced lead 5's English outside_service_scope
// classification in the real incident). Both are covered here.
describe("language stays pinned to prior context, never silently resets to English", () => {
  it("thin-description short-circuit: a short, English-looking reply ('Fixed') after Spanish prior context still greets in Spanish", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-1",
        customer_name: "Julie",
        photo_url: null,
        problem: "varias cosas. triturador de basura roto.",
        confidence: null,
        diagnosis: null,
        flag_type: "needs_human_review",
      },
      leadSlotClaimSucceeds: true,
      outboundInteractionCount: MAX_AUTOMATED_REPLIES_PER_CONVERSATION - 1,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Fixed",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("¡Gracias por contactar a Acme Handyman!");
  });

  it("handleFreshQuote main body: a longer English reply ('Thanks anywaya') after Spanish prior context still replies in Spanish", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-1",
        customer_name: "Julie",
        photo_url: null,
        problem: "varias cosas. triturador de basura roto.",
        confidence: null,
        diagnosis: null,
        flag_type: "needs_human_review",
      },
      leadSlotClaimSucceeds: true,
      outboundInteractionCount: MAX_AUTOMATED_REPLIES_PER_CONVERSATION - 1,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: true,
    } as any);
    vi.mocked(createFlaggedLead).mockResolvedValue({ id: "new-lead-2" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Thanks anywaya",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("Voy a pasar su mensaje a nuestro equipo.");
  });

  it("without any prior context (genuinely first contact), a context-free English word still falls back to English — unchanged, pre-existing behavior", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Fixed",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Hi! 👋 Thanks for reaching out to");
  });
});

describe("handleInboundWhatsAppMessage — quoted_follow_up with a photo (Priority 2 photo intelligence)", () => {
  const QUOTED_LEAD: FakeOpenLead = {
    id: "lead-photo-1",
    customer_name: "Riley",
    photo_url: null,
    problem: "Kitchen faucet needs replacing.",
    confidence: "High", // already quoted
    diagnosis: "Standard kitchen faucet replacement.",
    flag_type: null,
  };

  beforeEach(() => {
    vi.mocked(classifyFollowUpPhotoIntent).mockClear();
    vi.mocked(classifyFollowUpIntent).mockClear();
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(finalizeLeadWithQuote).mockClear();
    vi.mocked(createFlaggedLead).mockClear();
    vi.mocked(sendFollowUpNotificationEmail).mockClear();
    vi.mocked(isSupportedImageBase64).mockReturnValue(true);
  });

  // Scenario: a later photo that clearly relates to a DIFFERENT job.
  it("classification=different_job: falls through to the fresh-quote flow, never reassesses the existing lead", async () => {
    const { admin } = fakeInboundAdmin({ openLead: QUOTED_LEAD, leadSlotClaimSucceeds: true });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpPhotoIntent).mockResolvedValue({
      classification: "different_job",
    } as any);
    // Fresh-quote path, shortest branch: out of scope — proves fallthrough
    // reached handleFreshQuote's own getQuoteEstimate call (with the photo)
    // without needing to exercise its full downstream lead-creation logic.
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: true,
    } as any);
    vi.mocked(createFlaggedLead).mockResolvedValue({ id: "new-unrelated-lead" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "",
      mediaRef: "media-ref-1",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(classifyFollowUpPhotoIntent).toHaveBeenCalledTimes(1);
    expect(classifyFollowUpPhotoIntent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        priorProblem: QUOTED_LEAD.problem,
        priorDiagnosis: QUOTED_LEAD.diagnosis,
      }),
    });
    expect(finalizeLeadWithQuote).not.toHaveBeenCalled(); // never treated as the same job
    expect(getQuoteEstimate).toHaveBeenCalledTimes(1); // the fresh-quote path genuinely ran
    expect(createFlaggedLead).toHaveBeenCalledTimes(1); // a NEW lead, not an update to the old one
    expect(sent).toEqual([{ to: TEST_PHONE, body: "I'll pass your message along to our team." }]);
  });

  // Scenario: an ambiguous photo that requires clarification.
  it("classification=ambiguous: asks a clarifying question, creates no new lead, never reassesses", async () => {
    const { admin, calls } = fakeInboundAdmin({
      openLead: QUOTED_LEAD,
      leadSlotClaimSucceeds: true,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpPhotoIntent).mockResolvedValue({
      classification: "ambiguous",
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "",
      mediaRef: "media-ref-2",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getQuoteEstimate).not.toHaveBeenCalled();
    expect(finalizeLeadWithQuote).not.toHaveBeenCalled();
    expect(createFlaggedLead).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Is this photo about the job I already quoted");
    // The disambiguation question is recorded against the EXISTING lead,
    // never a new one.
    expect(
      calls.leadMessageInserts.some((m) => m.lead_id === QUOTED_LEAD.id && m.role === "assistant"),
    ).toBe(true);
    expect(sendFollowUpNotificationEmail).toHaveBeenCalledTimes(1);
  });

  // Verifies what actually happens after the ambiguous question, across two
  // real turns of handleInboundWhatsAppMessage — not just the first reply.
  // Documented limitation (not a bug): there is no persistent "awaiting
  // disambiguation" state (no new migration/column) — the customer's next
  // message is independently reclassified from scratch, using only the
  // photo it carries plus the lead's own problem/diagnosis. This is
  // deliberate: WhatsApp media references aren't reliably re-fetchable
  // after a delay, and this codebase has no job queue to hold conversation
  // state between separate serverless invocations. The practical
  // consequence, proven here: a customer who resends a photo after being
  // asked behaves exactly like any other same_job photo follow-up — no
  // special memory of having just been asked, but also no stuck/dead-end
  // state. A second genuinely ambiguous photo in a row would ask again
  // rather than silently guessing, which is the safe failure mode.
  it("ambiguous question, then customer resends a photo: the second turn reassesses normally, with no memory of the first turn required", async () => {
    const { admin, calls } = fakeInboundAdmin({
      openLead: QUOTED_LEAD,
      leadSlotClaimSucceeds: true,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    // Turn 1: ambiguous photo.
    vi.mocked(classifyFollowUpPhotoIntent).mockResolvedValueOnce({
      classification: "ambiguous",
    } as any);
    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "",
      mediaRef: "media-ref-amb-1",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Is this photo about the job I already quoted");
    expect(finalizeLeadWithQuote).not.toHaveBeenCalled();

    // Turn 2: customer resends a photo in response. No special state was
    // set up for this — it's classified fresh, exactly like any other
    // incoming photo on this lead.
    vi.mocked(classifyFollowUpPhotoIntent).mockResolvedValueOnce({
      classification: "same_job",
    } as any);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "Plumbing",
      severity: "Medium",
      confidence: "High",
      diagnosis: "Corroded shut-off valves found.",
      isDiagnosisOnly: false,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        {
          description: "Kitchen faucet replacement",
          detail: "Corroded valves",
          amount: 185,
          priceSheetItemId: "ps-1",
          hours: undefined,
        },
      ],
      totalLow: 185,
      totalHigh: 185,
    } as any);
    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "here it is",
      mediaRef: "media-ref-amb-2",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(classifyFollowUpPhotoIntent).toHaveBeenCalledTimes(2); // independently reclassified, not skipped
    // The second turn's material change completes the reassessment via the
    // now-fixed finalizeLeadWithQuote path (0028_fix_lead_reassessment_atomicity.sql).
    expect(finalizeLeadWithQuote).toHaveBeenCalledTimes(1);
    const finalizeArg = vi.mocked(finalizeLeadWithQuote).mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(finalizeArg.data["leadId"]).toBe(QUOTED_LEAD.id); // same lead throughout, never a new one
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toContain("updated your estimate");
    // Both turns' assistant messages are recorded against the SAME lead.
    expect(
      calls.leadMessageInserts.filter((m) => m.lead_id === QUOTED_LEAD.id && m.role === "assistant")
        .length,
    ).toBe(2);
  });

  // Scenario: a later photo providing evidence for the SAME job, with a
  // materially changed estimate — must update the EXISTING lead (never a
  // new one) and explain what changed. Re-enabled 2026-10-19
  // (0028_fix_lead_reassessment_atomicity.sql): a real-Postgres-proven bug
  // in update_lead_with_line_items (it only ever INSERTed line items,
  // never deleted the lead's existing ones first) previously forced this
  // path to flag for manual review instead of persisting anything — see
  // SECURITY_REMEDIATION_TRACKER.md and scripts/pg-lead-reassessment-check.sh
  // (35/35 checks, including the exact red/green reproduction of this bug
  // against a real disposable Postgres instance) for why it's now safe to
  // call finalizeLeadWithQuote here again.
  it("classification=same_job, materially changed: updates the EXISTING lead via finalizeLeadWithQuote and explains the new price", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: QUOTED_LEAD,
      leadSlotClaimSucceeds: true,
      existingLineItems: [{ description: "Kitchen faucet replacement", rate: 120, qty: 1 }],
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpPhotoIntent).mockResolvedValue({ classification: "same_job" } as any);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "Plumbing",
      severity: "Medium",
      confidence: "High",
      diagnosis: "Corroded shut-off valves found — replacement is more involved than standard.",
      isDiagnosisOnly: false,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        {
          description: "Kitchen faucet replacement",
          detail: "Corroded valves",
          amount: 185,
          priceSheetItemId: "ps-1",
          hours: undefined,
        },
      ],
      totalLow: 185,
      totalHigh: 185,
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "here's what it looks like under the sink",
      mediaRef: "media-ref-3",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(finalizeLeadWithQuote).toHaveBeenCalledTimes(1);
    const finalizeArg = vi.mocked(finalizeLeadWithQuote).mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    // Tenant/lead association: the EXISTING lead and tenant, never a
    // fresh/different one.
    expect(finalizeArg.data["leadId"]).toBe(QUOTED_LEAD.id);
    expect(finalizeArg.data["tenantSlug"]).toBe(TEST_TENANT.slug);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("updated your estimate");
    expect(sent[0]!.body).toContain("185");
    expect(sent[0]!.body).toContain("previously"); // explains what changed, never silent
    expect(sent[0]!.body).toContain("120");
  });

  // Scenario: a later photo that does NOT materially change the estimate —
  // must not send an unnecessary confirmation message.
  it("classification=same_job, NOT materially changed: never calls finalizeLeadWithQuote and sends no message at all", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: QUOTED_LEAD,
      leadSlotClaimSucceeds: true,
      existingLineItems: [{ description: "Kitchen faucet replacement", rate: 120, qty: 1 }],
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpPhotoIntent).mockResolvedValue({ classification: "same_job" } as any);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "Plumbing",
      severity: "Low",
      confidence: "High",
      diagnosis: "Confirms standard kitchen faucet replacement.",
      isDiagnosisOnly: false,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        {
          description: "Kitchen faucet replacement",
          detail: "",
          amount: 120,
          priceSheetItemId: "ps-1",
          hours: undefined,
        },
      ],
      totalLow: 120,
      totalHigh: 120,
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "",
      mediaRef: "media-ref-4",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(finalizeLeadWithQuote).not.toHaveBeenCalled();
    expect(sent).toEqual([]); // no unnecessary confirmation
    // The owner is still informed a photo came in, even though nothing
    // about the quote changed — same precedent as the existing text-only
    // same-job branch, which also always notifies regardless of outcome.
    expect(sendFollowUpNotificationEmail).toHaveBeenCalledTimes(1);
  });

  // Scenario: duplicate inbound photo events / concurrent processing — a
  // lost lead-processing claim must suppress the automated reply entirely
  // (same concurrency protection already proven for the text-only same-job
  // path), never silently double-process or duplicate the lead's line items.
  it("classification=same_job, lead-processing claim lost: AI pipeline never touched, no reply sent, owner still notified", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: QUOTED_LEAD,
      leadSlotClaimSucceeds: false,
      existingLineItems: [{ description: "Kitchen faucet replacement", rate: 120, qty: 1 }],
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpPhotoIntent).mockResolvedValue({ classification: "same_job" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "",
      mediaRef: "media-ref-5",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getQuoteEstimate).not.toHaveBeenCalled(); // claim-protected callback never ran
    expect(finalizeLeadWithQuote).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(sendFollowUpNotificationEmail).toHaveBeenCalledTimes(1);
  });

  // Scenario: continued loop-guard enforcement — every reply this new code
  // produces still goes through sendGuardedReply (see the structural
  // "exactly four raw adapter.sendMessage(...)" test above, which already
  // proves this file adds no new direct send site). This test proves the
  // guard's suppression itself still applies in practice when tripped.
  it("loop guard tripped: suppresses the same-job reassessment reply, sends only the generic pause notice", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: QUOTED_LEAD,
      leadSlotClaimSucceeds: true,
      existingLineItems: [{ description: "Kitchen faucet replacement", rate: 120, qty: 1 }],
      loopGuardTripped: true,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "",
      mediaRef: "media-ref-6",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    // Tripped before routing is even reached — classification never runs.
    expect(classifyFollowUpPhotoIntent).not.toHaveBeenCalled();
    expect(sent).toEqual([{ to: TEST_PHONE, body: LOOP_PAUSE_MESSAGE }]);
  });

  // Format/load-failure gates, proven not to bypass classification/reassessment.
  it("an unsupported image format gets a clear message and never reaches classification or reassessment", async () => {
    const { admin } = fakeInboundAdmin({ openLead: QUOTED_LEAD, leadSlotClaimSucceeds: true });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(isSupportedImageBase64).mockReturnValue(false);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "",
      mediaRef: "media-ref-7",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(classifyFollowUpPhotoIntent).not.toHaveBeenCalled();
    expect(getQuoteEstimate).not.toHaveBeenCalled();
    expect(sent).toEqual([{ to: TEST_PHONE, body: "unsupported image message" }]);
  });

  it("a photo download failure gets a clear retry message and never reaches classification", async () => {
    const { admin } = fakeInboundAdmin({ openLead: QUOTED_LEAD, leadSlotClaimSucceeds: true });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const sent: Array<{ to: string; body: string }> = [];
    const adapter: ChannelAdapter = {
      sendMessage: async (to, body) => {
        sent.push({ to, body });
      },
      fetchMedia: async () => {
        throw new Error("simulated media fetch failure");
      },
    };

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "",
      mediaRef: "media-ref-8",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(classifyFollowUpPhotoIntent).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { to: TEST_PHONE, body: "I couldn't load that photo — could you try sending it again?" },
    ]);
  });
});

// ---------------------------------------------------------------------
// WhatsApp opt-out — handleInboundWhatsAppMessage's own state machine
// (handleOptOutState), checked BEFORE the loop guard. Real-Postgres
// coverage of the underlying atomic RPCs (record_whatsapp_opt_out's own
// concurrency fix, the claim/send/confirm sequence) lives in
// scripts/pg-whatsapp-opt-out-check.sh, not here — these tests exercise
// the TypeScript-level orchestration against a stateful fake admin.
// ---------------------------------------------------------------------

type FakeOptOutRow = {
  opted_out_at: string | null;
  resumed_at: string | null;
  confirmation_status: string | null;
};

function fakeOptOutAdmin(config: { row?: FakeOptOutRow } = {}) {
  const row: FakeOptOutRow = config.row ?? {
    opted_out_at: null,
    resumed_at: null,
    confirmation_status: null,
  };
  const calls = {
    recordOptOutCalls: 0,
    claimConfirmationCalls: 0,
    markSentCalls: 0,
    resumeCalls: 0,
    // Every phone-key string actually reached the database layer with,
    // across every RPC/read call this fake handles below — the
    // regression test for the phone-normalization fix asserts against
    // this directly, independent of the fake's own internal state
    // matching, so it still catches a regression even if some other part
    // of the fake were "accidentally" lenient about key matching.
    phoneKeysUsed: [] as string[],
  };
  const currentlyOptedOut = () =>
    Boolean(row.opted_out_at) && (!row.resumed_at || row.resumed_at < row.opted_out_at!);

  const admin = {
    rpc: async (name: string, rpcParams?: Record<string, unknown>) => {
      if (rpcParams && typeof rpcParams["p_phone"] === "string") {
        calls.phoneKeysUsed.push(rpcParams["p_phone"]);
      }
      if (name === "record_whatsapp_opt_out") {
        calls.recordOptOutCalls++;
        const wasOptedOut = currentlyOptedOut();
        if (!wasOptedOut) {
          row.opted_out_at = new Date().toISOString();
          row.confirmation_status = "pending";
          row.resumed_at = null;
          return { data: [{ just_opted_out: true }], error: null };
        }
        return { data: [{ just_opted_out: false }], error: null };
      }
      if (name === "claim_whatsapp_opt_out_confirmation") {
        calls.claimConfirmationCalls++;
        if (row.confirmation_status === "pending") {
          row.confirmation_status = "sending";
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      if (name === "release_whatsapp_opt_out_confirmation") {
        if (row.confirmation_status === "sending") {
          row.confirmation_status = "pending";
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      if (name === "mark_whatsapp_opt_out_confirmation_sent") {
        calls.markSentCalls++;
        if (row.confirmation_status === "sending") {
          row.confirmation_status = "sent";
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      if (name === "resume_whatsapp_opt_out") {
        calls.resumeCalls++;
        if (currentlyOptedOut()) {
          row.resumed_at = new Date().toISOString();
          return { data: true, error: null };
        }
        return { data: false, error: null };
      }
      // Loop-guard RPCs are a separate concern from these opt-out tests —
      // handled here, permissively ("never tripped"), only so a test that
      // deliberately falls PAST the opt-out check (proving opt-out did
      // NOT short-circuit) can exercise the rest of the real pipeline
      // without crashing on an RPC this fake was never meant to simulate
      // in detail. See whatsapp-conversation-server.test.ts's own
      // fakeLoopGuardAdmin for real loop-guard coverage.
      if (name === "record_whatsapp_interaction") {
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
      throw new Error(`fakeOptOutAdmin: unexpected rpc "${name}"`);
    },
    from: (table: string) => {
      if (table === "whatsapp_opt_outs") {
        return {
          select: () => ({
            eq: () => ({
              // isOptedOut's real call shape is .eq("tenant_id", t).eq("phone", p) —
              // this second .eq is the phone key, captured the same way the
              // rpc() dispatcher above captures p_phone.
              eq: (_col: string, phoneValue: string) => {
                calls.phoneKeysUsed.push(phoneValue);
                return {
                  maybeSingle: async () => ({
                    data: row.opted_out_at
                      ? { opted_out_at: row.opted_out_at, resumed_at: row.resumed_at }
                      : null,
                    error: null,
                  }),
                };
              },
            }),
          }),
        };
      }
      // Same reason as "leads" below — the one test that falls PAST the
      // opt-out check reaches hasPriorInboundInteraction and the
      // automated-reply cap check too. "No prior interactions, cap not
      // reached" so that test actually exercises the real pipeline instead
      // of being diverted into the greeting short-circuit or the cap
      // handoff.
      if (table === "whatsapp_interaction_events") {
        return { select: () => chainableRead({ data: null, error: null }) };
      }
      // "leads" is only reached by the one test that deliberately falls
      // PAST the opt-out check into the real pipeline — a minimal
      // "no open lead" stub so handleFreshQuote's pre-lead-greeting path
      // can complete without crashing. Not meant to simulate real lead
      // routing; see fakeInboundAdmin above for that.
      if (table === "leads") {
        const chain: Record<string, unknown> = {
          eq: () => chain,
          gte: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return { select: () => chain };
      }
      throw new Error(`fakeOptOutAdmin: unexpected table "${table}"`);
    },
  };
  return { admin: admin as unknown as SupabaseClient, row, calls };
}

// Localization regression coverage (2026-10-19): a real production
// conversation was observed getting a Spanish AI-generated diagnosis
// followed by a hardcoded English "Estimated price... Want me to get this
// booked in?" tail — the surrounding template text this file builds itself
// never branched on detectLanguage, unlike the AI's own diagnosis/question
// text. Also covers the related evidence-language defect: the closing
// line claimed "based on the photos" even on a text-only conversation that
// never sent one.
function fakeFreshQuoteAdmin(config: { priorInboundInteraction?: boolean } = {}) {
  const calls = {
    leadMessageInserts: [] as Array<{ lead_id: string; role: string; body: string }>,
  };
  const admin = {
    rpc: async (name: string) => {
      if (name === "record_whatsapp_interaction") {
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
      if (name === "claim_whatsapp_lead_slot") return { data: true, error: null };
      if (name === "release_whatsapp_lead_slot") return { data: null, error: null };
      throw new Error(`fakeFreshQuoteAdmin: unexpected rpc "${name}"`);
    },
    from: (table: string) => {
      if (table === "whatsapp_opt_outs") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          }),
        };
      }
      if (table === "leads") {
        // No open lead — every test in this block is a genuinely fresh,
        // first-ever conversation from this phone number.
        const chain: Record<string, unknown> = {
          eq: () => chain,
          gte: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return { select: () => chain };
      }
      if (table === "price_sheet_items") {
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      }
      if (table === "lead_messages") {
        return {
          insert: async (row: { lead_id: string; role: string; body: string }) => {
            calls.leadMessageInserts.push(row);
            return { error: null };
          },
        };
      }
      if (table === "whatsapp_interaction_events") {
        // Defaults to "no prior interaction" — matches this fixture's own
        // "genuinely fresh, first-ever conversation" intent. A test can
        // opt into priorInboundInteraction: true to simulate the real gap
        // this signal exists to close: a phone that already sent a thin,
        // lead-less message (so "leads" above still correctly returns no
        // open lead) but has messaged before within the window.
        const chain: Record<string, unknown> = {
          eq: () => chain,
          gte: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({
            data: config.priorInboundInteraction ? { id: "evt-1" } : null,
            error: null,
          }),
        };
        return { select: () => chain };
      }
      throw new Error(`fakeFreshQuoteAdmin: unexpected table "${table}"`);
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

const PRICED_RESULT = {
  needsClarification: false,
  outOfScope: false,
  isEmergency: false,
  issueType: "Plumbing",
  severity: "Low",
  confidence: "High",
  diagnosis: "Standard kitchen faucet replacement.",
  isDiagnosisOnly: false,
  hasNoPricedWork: false,
  hasPartiallyDeferredWork: false,
  lineItems: [
    {
      description: "Kitchen faucet replacement",
      detail: "",
      amount: 120,
      priceSheetItemId: "ps-1",
      hours: undefined,
    },
  ],
  totalLow: 120,
  totalHigh: 120,
};

describe("WhatsApp conversation language localization", () => {
  beforeEach(() => {
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(createLead).mockClear();
    vi.mocked(createLead).mockResolvedValue({ id: "new-lead-1" } as any);
  });

  it("instant quote, English, no photo: closing says 'information and description provided', never 'photos'", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue(PRICED_RESULT as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "How much to replace a kitchen faucet?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Price may change if the actual issue is different from what you described");
    expect(sent[0]!.body).not.toContain("the photos");
  });

  it("instant quote, English, with photo: closing preserves the existing 'photos' wording", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue(PRICED_RESULT as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "How much to replace a kitchen faucet?",
      mediaRef: "media-ref-en-photo",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Price may change if the actual issue is different from the photos");
  });

  it("instant quote, Spanish, no photo: entire reply is in Spanish, and never claims photo evidence that was never sent", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      ...PRICED_RESULT,
      diagnosis: "Reemplazo estándar de la llave de la cocina.",
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Tengo una fuga de agua en el baño, ¿cuánto cuesta repararla?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body).toContain("Precio estimado:");
    expect(body).toContain("El precio podría cambiar si el problema real es diferente a lo descrito");
    expect(body).toContain("¿le gustaría que agendemos la visita?");
    // The evidence-language bug this regression guards against: never say
    // "based on photos" (in either language) when none was ever sent.
    expect(body).not.toContain("fotos");
    expect(body).not.toContain("Price may change");
  });

  it("instant quote, Spanish, with photo: closing correctly claims photo evidence since one was actually sent", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      ...PRICED_RESULT,
      diagnosis: "Reemplazo estándar de la llave de la cocina.",
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Tengo una fuga de agua, aquí está la foto",
      mediaRef: "media-ref-es-photo",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("El precio podría cambiar si el problema real es diferente a las fotos");
  });

  // Photo-reassessment update path (handleQuotedFollowUpPhoto) — a
  // different function/template than the instant-quote path above, with
  // its own separate hardcoded English strings that had the identical bug.
  const SPANISH_QUOTED_LEAD: FakeOpenLead = {
    id: "lead-es-1",
    customer_name: "Cliente",
    photo_url: null,
    problem: "Tengo una fuga de agua en el baño.",
    confidence: "High",
    diagnosis: "Fuga en la llave de paso del lavabo.",
    flag_type: null,
  };

  it("photo-reassessment update, Spanish conversation: intro and price line are in Spanish", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: SPANISH_QUOTED_LEAD,
      leadSlotClaimSucceeds: true,
      existingLineItems: [{ description: "Reparación de llave de paso", rate: 120, qty: 1 }],
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpPhotoIntent).mockResolvedValue({ classification: "same_job" } as any);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "Plumbing",
      severity: "Medium",
      confidence: "High",
      diagnosis: "Válvulas corroídas encontradas — la reparación es más extensa de lo normal.",
      isDiagnosisOnly: false,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        {
          description: "Reparación de llave de paso",
          detail: "Válvulas corroídas",
          amount: 185,
          priceSheetItemId: "ps-1",
          hours: undefined,
        },
      ],
      totalLow: 185,
      totalHigh: 185,
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "aquí está cómo se ve",
      mediaRef: "media-ref-es-reassess",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body).toContain("¡Gracias por la foto! Según lo que puedo ver, actualicé su estimado:");
    expect(body).toContain("Precio estimado:");
    expect(body).toContain("(antes");
    expect(body).not.toContain("Thanks for the photo");
  });

  it("photo-reassessment update, English conversation: unchanged, still in English (regression)", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-en-1",
        customer_name: "Riley",
        photo_url: null,
        problem: "Kitchen faucet needs replacing.",
        confidence: "High",
        diagnosis: "Standard kitchen faucet replacement.",
        flag_type: null,
      },
      leadSlotClaimSucceeds: true,
      existingLineItems: [{ description: "Kitchen faucet replacement", rate: 120, qty: 1 }],
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpPhotoIntent).mockResolvedValue({ classification: "same_job" } as any);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "Plumbing",
      severity: "Medium",
      confidence: "High",
      diagnosis: "Corroded shut-off valves found — replacement is more involved than standard.",
      isDiagnosisOnly: false,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        {
          description: "Kitchen faucet replacement",
          detail: "Corroded valves",
          amount: 185,
          priceSheetItemId: "ps-1",
          hours: undefined,
        },
      ],
      totalLow: 185,
      totalHigh: 185,
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "here's what it looks like",
      mediaRef: "media-ref-en-reassess",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body).toContain(
      "Thanks for the photo! Based on what I can see, I've updated your estimate:",
    );
    expect(body).toContain("(previously");
    expect(body).not.toContain("Gracias por la foto");
  });

  // Regression for a real review finding (2026-10-19): the first version of
  // this localization fix detected language from openLead.problem +
  // openLead.diagnosis + body combined — meaning a lead's stored (AI-
  // generated) diagnosis could silently override a reliable signal from
  // the customer's OWN words. Fixed to detect from problem + body only.
  // These two cases are the direct, deliberately mismatched proof: the
  // customer's own text (problem, and this round's reply) must win even
  // when the lead's existing diagnosis text reads in the other language.
  it("language detection prefers the customer's own words: English problem + Spanish-reading stored diagnosis stays English", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-mismatch-1",
        customer_name: "Riley",
        photo_url: null,
        problem: "Kitchen faucet needs replacing.",
        confidence: "High",
        // Deliberately contains a word from estimate-server.ts's own
        // SPANISH_PATTERNS list ("problema") — a real, guaranteed pattern
        // match, not just Spanish-looking prose — to prove it's never
        // consulted for language detection — only openLead.problem and the
        // customer's current reply (body) are. (A prior draft of this test
        // used Spanish prose that happened not to match any actual
        // detectLanguage pattern, which meant it passed even against the
        // bug this test exists to catch — confirmed by deliberately
        // reverting the fix and seeing it still pass. This wording was
        // chosen specifically so reverting the fix makes this test fail.)
        diagnosis: "Hay un problema con la llave de la cocina.",
        flag_type: null,
      },
      leadSlotClaimSucceeds: true,
      existingLineItems: [{ description: "Kitchen faucet replacement", rate: 120, qty: 1 }],
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpPhotoIntent).mockResolvedValue({ classification: "same_job" } as any);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      ...PRICED_RESULT,
      diagnosis: "Corroded shut-off valves found.",
      totalLow: 185,
      totalHigh: 185,
      lineItems: [
        {
          description: "Kitchen faucet replacement",
          detail: "Corroded valves",
          amount: 185,
          priceSheetItemId: "ps-1",
          hours: undefined,
        },
      ],
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "here's what it looks like now",
      mediaRef: "media-ref-mismatch-1",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain(
      "Thanks for the photo! Based on what I can see, I've updated your estimate:",
    );
    expect(sent[0]!.body).not.toContain("Gracias por la foto");
  });

  // Note on asymmetry: detectLanguage is a simple "does any Spanish pattern
  // appear anywhere in the combined text" OR-test — appending more text
  // (like a diagnosis) can only ever ADD a false match, never remove one
  // the customer's own words already produced. So this direction can't
  // actually be flipped by a mismatched diagnosis the way the opposite
  // direction (tested above) can — this case instead confirms Spanish
  // detection from the customer's own words stays correct regardless of
  // what the stored diagnosis separately says, which is still worth
  // locking in even though it isn't a red/green distinguishing case.
  it("Spanish problem + English-reading stored diagnosis: Spanish is still correctly detected from the customer's own words", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-mismatch-2",
        customer_name: "Cliente",
        photo_url: null,
        problem: "Tengo una fuga de agua en el baño.",
        confidence: "High",
        // Deliberately English, to prove it's never consulted.
        diagnosis: "Standard shut-off valve repair.",
        flag_type: null,
      },
      leadSlotClaimSucceeds: true,
      existingLineItems: [{ description: "Reparación de llave de paso", rate: 120, qty: 1 }],
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpPhotoIntent).mockResolvedValue({ classification: "same_job" } as any);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      ...PRICED_RESULT,
      diagnosis: "Válvulas corroídas encontradas.",
      totalLow: 185,
      totalHigh: 185,
      lineItems: [
        {
          description: "Reparación de llave de paso",
          detail: "Válvulas corroídas",
          amount: 185,
          priceSheetItemId: "ps-1",
          hours: undefined,
        },
      ],
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "así se ve ahora",
      mediaRef: "media-ref-mismatch-2",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain(
      "¡Gracias por la foto! Según lo que puedo ver, actualicé su estimado:",
    );
    expect(sent[0]!.body).not.toContain("Thanks for the photo");
  });
});

describe("WhatsApp first-contact greeting", () => {
  beforeEach(() => {
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(createLead).mockClear();
    vi.mocked(createLead).mockResolvedValue({ id: "new-lead-1" } as any);
  });

  it("customer describes a problem immediately (English): first reply greets, then answers", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue(PRICED_RESULT as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "My kitchen faucet is leaking, how much to fix it?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.startsWith("Hi! 👋 ")).toBe(true);
    expect(sent[0]!.body).toContain(PRICED_RESULT.diagnosis);
  });

  // PRODUCTION REGRESSION: a real WhatsApp conversation showed "Hi! 👋"
  // twice — once on the customer's first (thin, e.g. "Hi") message, and
  // AGAIN on their very next message, a substantial one that triggered a
  // real clarifying question. Root cause: the thin-description reply never
  // creates a lead, so a second message that arrives before any lead
  // exists still sees openLead == null and was treated as a first contact
  // all over again. isFirstContact must also check whatsapp_interaction_
  // events directly (hasPriorInboundInteraction), not just lead existence.
  it("does NOT re-greet a substantial second message when the first (thin) message already got a reply but created no lead", async () => {
    const { admin } = fakeFreshQuoteAdmin({ priorInboundInteraction: true });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: true,
      questions: [{ question: "What's happening with the air conditioner?", options: ["Not cooling", "Noisy", "Other"] }],
    } as any);
    vi.mocked(createClarifyingLead).mockResolvedValue({ id: "new-clarifying-lead-1" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "one question do you do maintenance to air conditioner",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).not.toContain("Hi! 👋");
    expect(sent[0]!.body).not.toContain("Hello!");
    expect(sent[0]!.body).toContain("What's happening with the air conditioner?");
  });

  // PRODUCTION REGRESSION (companion to the one above, same screenshot):
  // the clarifying question read "...is it not cooling, making noise,
  // leaking water, or something else?" immediately followed by the exact
  // same choices again as "(Not cooling / blowing warm air / Making
  // unusual noise / Leaking water / Not turning on at all / Other issue)".
  // The real fix is a prompt change (buildPrompt now tells the model to
  // keep "question" a plain question with no inline example list, since
  // "options" are shown separately) — not testable at this level. This
  // confirms the orchestration code's own part (appending optionsText)
  // produces a clean, single listing when the model does follow that
  // instruction — i.e. the code never introduces duplication of its own on
  // top of a well-formed model response.
  it("a clean clarifying question (no inline example list) composes with its options exactly once, no duplicate listing", async () => {
    // priorInboundInteraction: true isolates the question/options
    // composition from the (separately-tested) greeting prefix.
    const { admin } = fakeFreshQuoteAdmin({ priorInboundInteraction: true });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: true,
      questions: [
        {
          question: "What's happening with it?",
          options: ["Not cooling", "Making noise", "Leaking water", "Other"],
        },
      ],
    } as any);
    vi.mocked(createClarifyingLead).mockResolvedValue({ id: "new-clarifying-lead-2" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "do you do maintenance on air conditioners",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body).toBe("What's happening with it?\n(Not cooling / Making noise / Leaking water / Other)");
    // Each option appears exactly once — never restated inside the
    // question sentence AND inside the parenthetical list.
    expect(body.match(/Not cooling/g)?.length).toBe(1);
    expect(body.match(/Making noise/g)?.length).toBe(1);
  });

  it("DOES greet a thin message that's genuinely this phone's first-ever contact (no prior interaction recorded)", async () => {
    const { admin } = fakeFreshQuoteAdmin({ priorInboundInteraction: false });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Hi",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.startsWith("Hi! 👋 ")).toBe(true);
  });

  it("customer sends just a simple greeting (English, thin description): first reply greets once, not twice", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Hi",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body.startsWith("Hi! 👋 ")).toBe(true);
    // Exactly one wave — the thin-description welcome text itself doesn't
    // separately say "Hi"/"Hello" (it opens with "Thanks for reaching
    // out..."), so the prefix must not be duplicated.
    expect(body.match(/Hi! 👋/g)?.length).toBe(1);
    expect(body).toContain("Thanks for reaching out");
  });

  it("Spanish conversation: first reply greets with '¡Hola! 👋' and stays in Spanish throughout", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      ...PRICED_RESULT,
      diagnosis: "Reemplazo estándar de la llave de la cocina.",
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Mi llave de la cocina está goteando, ¿cuánto cuesta repararla?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body.startsWith("¡Hola! 👋 ")).toBe(true);
    expect(body).not.toContain("Hi! 👋");
  });

  it("follow-up message on an already-open (still-clarifying) lead does not repeat the greeting", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-greeting-followup",
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
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: true,
    } as any);
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

    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body).not.toContain("Hi! 👋");
    expect(body).not.toContain("Hello!");
    expect(body).not.toContain("¡Hola!");
  });

  it("a different job within the existing 48-hour window does not trigger another greeting", async () => {
    // fakeInboundAdmin's leads table reflects an existing, still-in-window
    // row for this (tenant, phone) — the exact same openLead value
    // handleInboundWhatsAppMessage's own 48-hour, phone+tenant-scoped
    // lookup would return for a lead created minutes or hours ago. Since
    // isFirstContact is now derived from that same openLead (not a
    // separate all-time check), a "different job" fallthrough from an
    // already-quoted lead that's still in that window must not re-greet.
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-returning-customer",
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
    vi.mocked(classifyFollowUpIntent).mockClear();
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "different_job" } as any);
    vi.mocked(getQuoteEstimate).mockResolvedValue(PRICED_RESULT as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "actually, separate from that — my water heater is leaking too",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body).not.toContain("Hi! 👋");
    expect(body).not.toContain("Hello!");
    expect(body).not.toContain("¡Hola!");
  });

  it("a flagged/resolved lead still inside the 48-hour window routes to fresh_quote but is still not re-greeted", async () => {
    // decideLeadRoute sends a flagged lead (confidence null, flag_type
    // set) to "fresh_quote" even though it's still inside the 48-hour
    // window (see decideLeadRoute's own doc comment: this governs pricing
    // behavior — start clean — not whether the customer was already
    // greeted in this conversation). openLead is still non-null here, so
    // isFirstContact must correctly read false even though the route is
    // the same "fresh_quote" path a genuinely first-time customer takes.
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-flagged-in-window",
        customer_name: "Jordan",
        photo_url: null,
        problem: "a prior request that got flagged",
        confidence: null,
        diagnosis: null,
        flag_type: "outside_service_scope",
      },
      leadSlotClaimSucceeds: true,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(getQuoteEstimate).mockResolvedValue(PRICED_RESULT as any);
    vi.mocked(createLead).mockClear();
    vi.mocked(createLead).mockResolvedValue({ id: "new-lead-after-flag" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "My kitchen faucet is leaking, how much to fix it?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body).not.toContain("Hi! 👋");
    expect(body).not.toContain("Hello!");
    expect(body).not.toContain("¡Hola!");
  });

  it("a returning customer whose previous lead is outside the 48-hour window receives a new greeting", async () => {
    // handleInboundWhatsAppMessage's own openLead lookup is already scoped
    // to the last 48 hours (.gte("created_at", now - 48h)) — a lead from
    // weeks ago simply isn't found, so this phone's DB-visible state is
    // identical to a genuinely first-time customer's (fakeFreshQuoteAdmin
    // models exactly that: no row comes back from the leads table). That
    // is the intended behavior: isFirstContact must be true here, exactly
    // as it is for a brand-new customer, because the current conversation
    // really is new regardless of history outside the window.
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue(PRICED_RESULT as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Hey, it's been a while — my water heater is leaking now, how much?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.startsWith("Hi! 👋 ")).toBe(true);
  });
});

describe("WhatsApp first-contact greeting — configurable source (recommended vs. custom)", () => {
  beforeEach(() => {
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(createLead).mockClear();
    vi.mocked(createLead).mockResolvedValue({ id: "new-lead-1" } as any);
  });

  const CUSTOM_TENANT: InboundWhatsAppTenant = {
    ...TEST_TENANT,
    greetingMode: "custom",
    customGreetingEn: "Yo! Thanks for texting {business_name} — what's up?",
    customGreetingEs: "¡Qué tal! Gracias por escribir a {business_name} — ¿qué necesitas?",
  };

  it("a tenant with a custom English greeting gets their own text, not the recommended default", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue(PRICED_RESULT as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: CUSTOM_TENANT,
      fromPhone: TEST_PHONE,
      body: "My kitchen faucet is leaking, how much to fix it?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.startsWith("Yo! Thanks for texting Acme Handyman — what's up?")).toBe(true);
    expect(sent[0]!.body).not.toContain("How can I help you today?"); // the recommended default's own wording
  });

  it("a tenant with a custom Spanish greeting gets their own text for a Spanish conversation", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      ...PRICED_RESULT,
      diagnosis: "Reemplazo estándar de la llave de la cocina.",
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: CUSTOM_TENANT,
      fromPhone: TEST_PHONE,
      body: "Mi llave de la cocina está goteando, ¿cuánto cuesta repararla?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.startsWith("¡Qué tal! Gracias por escribir a Acme Handyman — ¿qué necesitas?")).toBe(
      true,
    );
  });

  it("custom mode with ONLY the English field set falls back to the recommended default for a Spanish conversation", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      ...PRICED_RESULT,
      diagnosis: "Reemplazo estándar de la llave de la cocina.",
    } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: { ...TEST_TENANT, greetingMode: "custom", customGreetingEn: "Yo! What's up?", customGreetingEs: null },
      fromPhone: TEST_PHONE,
      body: "Mi llave de la cocina está goteando, ¿cuánto cuesta repararla?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.startsWith("¡Hola! 👋 Gracias por contactar a Acme Handyman.")).toBe(true);
  });

  it("custom mode with a whitespace-only (deleted) greeting falls back to the recommended default", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue(PRICED_RESULT as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: { ...TEST_TENANT, greetingMode: "custom", customGreetingEn: "   ", customGreetingEs: "   " },
      fromPhone: TEST_PHONE,
      body: "My kitchen faucet is leaking, how much to fix it?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.startsWith("Hi! 👋 Thanks for reaching out to Acme Handyman.")).toBe(true);
  });

  it("business name is substituted into the recommended greeting from the tenant's own name, never left as a literal token", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue(PRICED_RESULT as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: { ...TEST_TENANT, name: "Dusty's Plumbing & Drains" },
      fromPhone: TEST_PHONE,
      body: "My kitchen faucet is leaking, how much to fix it?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Thanks for reaching out to Dusty's Plumbing & Drains.");
    expect(sent[0]!.body).not.toContain("{business_name}");
  });

  it("falls back to a generic phrase (never leaving a literal token or dangling 'to .') when the tenant's name is blank", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue(PRICED_RESULT as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: { ...TEST_TENANT, name: "   " },
      fromPhone: TEST_PHONE,
      body: "My kitchen faucet is leaking, how much to fix it?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Thanks for reaching out to our team.");
    expect(sent[0]!.body).not.toContain("{business_name}");
    expect(sent[0]!.body).not.toContain("to .");
  });

  it("a custom greeting also only ever fires once — a different-job pivot within the 48-hour window doesn't repeat it", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-custom-greeting-followup",
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
    vi.mocked(classifyFollowUpIntent).mockClear();
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "different_job" } as any);
    vi.mocked(getQuoteEstimate).mockResolvedValue(PRICED_RESULT as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: CUSTOM_TENANT,
      fromPhone: TEST_PHONE,
      body: "actually, separate from that — my water heater is leaking too",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).not.toContain("Yo! Thanks for texting");
    expect(sent[0]!.body).not.toContain("Hi! 👋");
  });
});

describe("WhatsApp opt-out — handleInboundWhatsAppMessage's state machine", () => {
  it("a STOP message records the opt-out and sends exactly one confirmation, with no AI/reply pipeline touched", async () => {
    const { admin, row, calls } = fakeOptOutAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "STOP",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(row.opted_out_at).not.toBeNull();
    expect(row.confirmation_status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/unsubscribed/i);
    expect(calls.claimConfirmationCalls).toBe(1);
    expect(calls.markSentCalls).toBe(1);
  });

  // Regression test for a High-severity finding from an adversarial
  // review: handleOptOutState used to pass the RAW, unnormalized
  // fromPhone to recordOptOut/isOptedOut/resumeOptOut, while the actual
  // enforcement check inside sendWhatsAppMessage/sendWhatsAppMessageMeta/
  // sendWhatsAppTemplateMessage always normalized via normalizePhone.
  // If a provider ever delivered a phone number in a form that wasn't
  // already normalize-idempotent, the write key (raw) and the
  // enforcement-check key (normalized) would silently diverge — a
  // customer's STOP could be recorded under one string and never found
  // by the check that's supposed to block their next message, or an
  // owner's dashboard resume (which does normalize, like everything
  // else) could fail to find a row stored under the raw form. This test
  // supplies a deliberately non-canonical phone (spaces, parens, a dash —
  // exactly the kind of formatting normalizePhone exists to strip) and
  // asserts every single whatsapp_opt_outs key that reaches the database
  // layer is the fully normalized form, never the raw input. Written to
  // fail against the pre-fix code (which pushed the raw string straight
  // through) and pass against the corrected version.
  it("REGRESSION: a non-canonical inbound phone is normalized before being used as the whatsapp_opt_outs key — for the opt-out write, the confirmation claim, AND the mark-sent call", async () => {
    const NON_CANONICAL_PHONE = "+1 (555) 123-4567";
    const EXPECTED_NORMALIZED = "+15551234567";
    const { admin, calls } = fakeOptOutAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: NON_CANONICAL_PHONE,
      body: "STOP",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    // Every DB-layer call this flow makes (record_whatsapp_opt_out,
    // claim_whatsapp_opt_out_confirmation, mark_whatsapp_opt_out_confirmation_sent)
    // must have used the identical normalized key — not the raw input,
    // and not inconsistent forms across the three calls.
    expect(calls.phoneKeysUsed.length).toBeGreaterThan(0);
    for (const key of calls.phoneKeysUsed) {
      expect(key).toBe(EXPECTED_NORMALIZED);
      expect(key).not.toBe(NON_CANONICAL_PHONE);
    }

    // The actual provider-facing SEND still goes to the ORIGINAL,
    // unnormalized address — normalization is a DB-key concern only,
    // never applied to where the message is actually delivered.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(NON_CANONICAL_PHONE);
  });

  it("REGRESSION: an opt-out written under one raw phone format is found by a later check using a DIFFERENT raw format of the same number", async () => {
    // Simulates the exact failure mode the bug risked: the customer's
    // number arrives formatted one way on the STOP message, and a
    // differently-formatted (but logically identical) value is used for
    // a later lookup — e.g. a dashboard resume attempt, or any other
    // caller that doesn't happen to receive the exact byte-identical
    // string. Proven here at the isOptedOut level directly, which is
    // what every enforcement check and the dashboard resume path both
    // call through normalizePhone(...) already.
    const { admin, calls } = fakeOptOutAdmin({
      row: {
        opted_out_at: new Date().toISOString(),
        resumed_at: null,
        confirmation_status: "sent",
      },
    });
    const WRITE_FORM = "+1 555 123 4567"; // how it might have been stored
    const READ_FORM = "+1-555-123-4567"; // a differently-punctuated form of the SAME number
    const found = await isOptedOut(admin, TEST_TENANT.id, normalizePhone(READ_FORM));
    expect(normalizePhone(WRITE_FORM)).toBe(normalizePhone(READ_FORM)); // both forms normalize identically
    expect(found).toBe(true); // the read finds the row regardless of which raw form was used
    expect(calls.phoneKeysUsed).toContain(normalizePhone(READ_FORM));
  });

  it("a repeated STOP from an already-opted-out number does NOT send a second confirmation", async () => {
    const { admin, row, calls } = fakeOptOutAdmin({
      row: {
        opted_out_at: new Date(Date.now() - 60_000).toISOString(),
        resumed_at: null,
        confirmation_status: "sent",
      },
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "stop",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(0); // no second confirmation
    expect(calls.claimConfirmationCalls).toBe(0); // never even attempted — just_opted_out was false
    expect(row.confirmation_status).toBe("sent"); // unchanged
  });

  it("an ordinary message from a currently-opted-out number gets NO reply at all — no auto-resume on a bare message", async () => {
    const { admin, row } = fakeOptOutAdmin({
      row: {
        opted_out_at: new Date().toISOString(),
        resumed_at: null,
        confirmation_status: "sent",
      },
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "actually I still need that faucet fixed",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(0);
    expect(row.resumed_at).toBeNull(); // still opted out — not auto-resumed
  });

  it("START from a currently-opted-out number resumes and sends exactly one opt-in confirmation", async () => {
    const { admin, row } = fakeOptOutAdmin({
      row: {
        opted_out_at: new Date().toISOString(),
        resumed_at: null,
        confirmation_status: "sent",
      },
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "START",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(row.resumed_at).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/resubscribed/i);
  });

  it("START from a number that is NOT currently opted out is a no-op (not treated as an opt-out/opt-in control message at all) and falls through to normal processing", async () => {
    const { admin } = fakeOptOutAdmin(); // never opted out
    vi.mocked(getAdminClient).mockReturnValue(admin);
    // "start" isn't an opt-out keyword, and isOptedOut() is false, so
    // handleOptOutState's { stop: false } lets this fall through to the
    // normal pipeline — proven here by observing it does NOT short-circuit
    // with an opt-in confirmation (which only ever fires while opted out).
    const { adapter, sent } = fakeAdapter();
    // No lead exists and the message is short, so the real fallback here
    // is the thin-description greeting — confirms normal processing ran,
    // not the opt-in path.
    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "start",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });
    expect(sent.some((m) => /resubscribed/i.test(m.body))).toBe(false);
  });

  it("two concurrent STOP messages only ever produce one confirmation send (the atomic claim, not a race)", async () => {
    const { admin, calls } = fakeOptOutAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    const send = () =>
      handleInboundWhatsAppMessage({
        tenant: TEST_TENANT,
        fromPhone: TEST_PHONE,
        body: "STOP",
        mediaRef: undefined,
        providerMessageId: undefined,
        profileName: undefined,
        channel: "WhatsApp",
        adapter,
      });

    // The fake admin's rpc calls are synchronous-resolving promises, so
    // Promise.all here still serializes at each `await` inside the real
    // code path — this proves the LOGIC (only one just_opted_out: true)
    // rather than true OS-thread concurrency, which the real atomic SQL
    // UPDATE (proven separately in pg-whatsapp-opt-out-check.sh) is what
    // actually guarantees under genuine concurrent connections.
    await Promise.all([send(), send()]);

    expect(sent).toHaveLength(1);
    expect(calls.claimConfirmationCalls).toBe(1);
  });
});
