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
  // detectLanguage/detectCurrentLanguage are real, not mocked — they're
  // pure, deterministic pattern-matchers (see estimate-server.ts), and the
  // whatsapp-conversation-server.ts localization tests below depend on
  // their actual Spanish-detection behavior to verify real language-
  // routing, not a fake return value that would prove nothing about the
  // real code path.
  const actual = await importOriginal<typeof import("@/lib/estimate-server")>();
  return {
    getQuoteEstimate: vi.fn(),
    getFollowUpAnswer: vi.fn(),
    classifyFollowUpIntent: vi.fn(),
    classifyFollowUpPhotoIntent: vi.fn(),
    // Defaults to "specific_or_other" so every existing fresh_quote test
    // (which doesn't configure this mock at all) falls through to the
    // normal getQuoteEstimate flow unchanged, exactly as it did before this
    // classifier existed — only tests that explicitly set this mock to
    // "broad_overview" exercise the new short-circuit.
    classifyBroadServiceInquiry: vi.fn(() => Promise.resolve({ classification: "specific_or_other" })),
    isSupportedImageBase64: vi.fn(() => true),
    detectLanguage: actual.detectLanguage,
    detectCurrentLanguage: actual.detectCurrentLanguage,
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
  attemptConversationResume,
  RESUMABLE_STATUSES,
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
  classifyBroadServiceInquiry,
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
    expect(decideLeadRoute({ confidence: null, flag_type: null, status: "new" })).toBe(
      "continue_clarification",
    );
  });

  it("routes to quoted_follow_up once a lead has a real confidence value", () => {
    expect(decideLeadRoute({ confidence: "High", flag_type: null, status: "quoted" })).toBe(
      "quoted_follow_up",
    );
  });

  it("routes a flagged, never-quoted lead (outside_service_scope) to fresh_quote", () => {
    expect(
      decideLeadRoute({ confidence: null, flag_type: "outside_service_scope", status: "flagged" }),
    ).toBe("fresh_quote");
  });

  it("routes a flagged, never-quoted lead (needs_human_review) to fresh_quote — not a sticky permanent state", () => {
    expect(
      decideLeadRoute({ confidence: null, flag_type: "needs_human_review", status: "flagged" }),
    ).toBe("fresh_quote");
  });

  it("confidence takes priority over flag_type: a quoted-but-flagged lead (pending_negotiated_price) still routes to quoted_follow_up", () => {
    expect(
      decideLeadRoute({ confidence: "High", flag_type: "pending_negotiated_price", status: "flagged" }),
    ).toBe("quoted_follow_up");
  });

  it("confidence takes priority over flag_type even for an unrelated flag combination", () => {
    expect(
      decideLeadRoute({ confidence: "Low", flag_type: "needs_human_review", status: "flagged" }),
    ).toBe(
      "quoted_follow_up",
    );
  });

  it("a won lead is terminal — a new message routes to fresh_quote, never quoted_follow_up", () => {
    expect(decideLeadRoute({ confidence: "High", flag_type: null, status: "won" })).toBe(
      "fresh_quote",
    );
  });

  it("a lost lead is terminal — a new message routes to fresh_quote, never quoted_follow_up", () => {
    expect(decideLeadRoute({ confidence: "High", flag_type: null, status: "lost" })).toBe(
      "fresh_quote",
    );
  });

  it("a booked lead is NOT terminal — still routes to quoted_follow_up, unchanged from before this fix (a question about the appointment is a real follow-up, not a new request)", () => {
    expect(decideLeadRoute({ confidence: "High", flag_type: null, status: "booked" })).toBe(
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

  // "outside_service_scope" deliberately removed from
  // ALREADY_HANDED_OFF_FLAG_TYPES (2026-10-27): this test used to assert
  // suppression on the premise that an outOfScope result had already sent
  // the customer a real handoff message ("I'll pass your message along to
  // our team."). The silence mechanism means that's no longer true — an
  // outOfScope result sends nothing at all — so the premise this
  // suppression relied on is false, and leaving it in place would leave a
  // customer in total, permanent, unexplained silence (whatsapp_loop_guards
  // trips never auto-clear) instead of at least getting this generic pause
  // notice. The pause notice must now fire normally, same as any other
  // non-exempt flag (pending_negotiated_price above); the lead-level
  // loop_suspected label is still correctly blocked by the existing-flag
  // WHERE clause, same as that case.
  it("no longer suppresses the pause notice for a lead flagged outside_service_scope — that flag's handoff message is silent now, so the premise no longer holds", async () => {
    const { admin, leadState, calls } = fakeLoopGuardAdmin({
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
    expect(sent).toEqual([{ to: TEST_PHONE, body: LOOP_PAUSE_MESSAGE }]);
    expect(leadState.flag_type).toBe("outside_service_scope"); // untouched — WHERE flag_type IS NULL still blocks it
    expect(calls.leadFlagUpdateApplied).toBe(0);
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
  // hand) — confirms the by-phone lookup correctly finds the open lead and,
  // same as the direct-leadId test above, no longer suppresses the pause
  // notice for outside_service_scope now that flag sends no handoff
  // message of its own.
  it("still sends the pause notice via the by-phone lookup when called with leadId: null and the found lead is flagged outside_service_scope", async () => {
    const { admin } = fakeLoopGuardAdmin({
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
    expect(sent).toEqual([{ to: TEST_PHONE, body: LOOP_PAUSE_MESSAGE }]);
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
  // Optional — defaults applied by each fixture (fakeInboundAdmin: "new")
  // so the ~20 existing call sites that predate decideLeadRoute's
  // status-awareness don't all need touching for a field irrelevant to
  // what they're actually testing.
  status?: string;
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
    in: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => resolved,
    then: (resolvePromise: (v: typeof listResolved) => void) => resolvePromise(listResolved),
  };
  return chain;
}

function fakeInboundAdmin(config: {
  // null simulates "no lead at all in the last 48 hours" — the precondition
  // for attemptConversationResume to even run. Every pre-existing test
  // passes a real object here and is unaffected by widening this type.
  openLead: FakeOpenLead | null;
  leadSlotClaimSucceeds: boolean;
  // Rows attemptConversationResume's own extended-window query (the
  // leads-table .in(...) call) should see. Defaults to [] so every
  // pre-existing test (none of which exercise resume behavior) keeps its
  // exact prior "no candidates" behavior.
  resumeCandidates?: FakeOpenLead[];
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
  // What hasPriorInboundInteraction's own 48-hour-windowed query should
  // report. Defaults to true — every pre-existing test configures a real
  // openLead, which already makes isFirstContact false on its own, so this
  // signal was previously irrelevant and hardcoded true. Set to false to
  // genuinely exercise the no-prior-interaction case (together with
  // openLead: null).
  hadPriorInboundInteraction?: boolean;
  // What attemptConversationResume's own secondary "any lead at all in the
  // 14-day window" existence check should report — independent of
  // resumeCandidates (which is filtered to RESUMABLE_STATUSES only).
  // Defaults to false. Set to true to simulate a won/lost (or otherwise
  // excluded-status) lead that still proves the customer is returning, even
  // though it can never itself be a resume candidate.
  anyPriorLeadInExtendedWindow?: boolean;
  // Active tenant_capabilities rows fetchCapabilitiesForQuote should see,
  // every time handleFreshQuote/the clarification/reassessment paths call
  // getQuoteEstimate. Defaults to [] — every pre-existing test (none of
  // which configure any capability) keeps its exact prior "nothing
  // excluded, no specialties" behavior.
  capabilities?: Array<{ id: string; type: string; label: string; notes: string | null; active: boolean }>;
  // Raw price_sheet_items rows handleFreshQuote reads to build its
  // priceSheet argument. Defaults to [] — every pre-existing test (where
  // getQuoteEstimate is mocked anyway, so the actual price-sheet content
  // never mattered) keeps its exact prior "empty" behavior. Only the
  // broad-service-inquiry short-circuit tests need real category/price_min
  // content, since that's what the short-circuit's own category list and
  // "is anything actually priced" gate read directly off this table.
  priceSheetRows?: Array<Record<string, unknown>>;
}) {
  // Deliberately NOT the same object decideLeadRoute's initial read
  // returns — see flagTypeAtWriteTime's own comment above.
  const writeTimeState = {
    flag_type: config.flagTypeAtWriteTime ?? config.openLead?.flag_type ?? null,
  };
  // Defaults to "new" — every pre-existing test using this fixture predates
  // decideLeadRoute's status-awareness and doesn't care about it; "new" is
  // never won/lost, so it never changes any of their outcomes. null (no
  // recent lead) stays null, never coerced into a fake object — decideLeadRoute
  // treats a real-but-empty object as a lead with undefined confidence/flag_type,
  // which is a completely different (and wrong) routing outcome than "no lead".
  const leadState: FakeOpenLead | null = config.openLead
    ? { status: "new", ...config.openLead }
    : null;
  const resumeCandidateRows: FakeOpenLead[] = (config.resumeCandidates ?? []).map((c) => ({
    status: "new",
    ...c,
  }));
  const calls = {
    leadMessageInserts: [] as Array<{ lead_id: string; role: string; body: string }>,
    leadUpdateAttempts: 0,
    leadUpdateApplied: 0,
    lastLeadUpdatePatch: null as Record<string, unknown> | null,
    claimAttempts: 0,
    releaseAttempts: 0,
    // Captures exactly what attemptConversationResume's extended-window
    // query filtered its "status in (...)" clause to, each time .in() is
    // called — the direct proof that won/lost leads are excluded by the
    // query itself, not by some later filtering step.
    resumeStatusInArgs: [] as unknown[][],
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
        // Single-row (.maybeSingle()) shape: hasPriorInboundInteraction's
        // own call — configurable via hadPriorInboundInteraction (defaults
        // true, matching every pre-existing test's implicit assumption).
        // List shape (awaited directly off .limit()):
        // countRecentOutboundInteractions' own call — outboundInteractionCount
        // controls how many rows come back, capped to whatever `n` the real
        // code asked for.
        const outboundCount = config.outboundInteractionCount ?? 1;
        const hadPriorInbound = config.hadPriorInboundInteraction ?? true;
        const chain: Record<string, unknown> = {
          eq: () => chain,
          gte: () => chain,
          limit: (n: number) => ({
            ...chain,
            then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
              resolve({ data: Array(Math.min(outboundCount, n)).fill({ id: "evt-1" }), error: null }),
          }),
          maybeSingle: async () => ({ data: hadPriorInbound ? { id: "evt-1" } : null, error: null }),
        };
        return { select: () => chain };
      }
      if (table === "leads") {
        return {
          // .in(...) is only ever called by attemptConversationResume's
          // extended-window query, never by the main openLead lookup this
          // fixture otherwise simulates. Once called, every subsequent
          // chain call (including a later .limit()) switches to the resume
          // chain below, which resolves to resumeCandidateRows (default
          // [], preserving every pre-existing test's "no candidates"
          // behavior) — chainableRead's own eq()/gte() loop back to THEIR
          // OWN closure, not this one, so the override has to live on a
          // chain built specifically for this table, not spread onto
          // chainableRead's result.
          select: () => {
            const resumeChain: Record<string, unknown> = {
              eq: () => resumeChain,
              gte: () => resumeChain,
              order: () => resumeChain,
              in: (_col: string, values: unknown[]) => {
                calls.resumeStatusInArgs.push(values);
                return resumeChain;
              },
              limit: (n: number) => ({
                ...resumeChain,
                then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                  resolve({ data: resumeCandidateRows.slice(0, n), error: null }),
              }),
              maybeSingle: async () => ({ data: resumeCandidateRows[0] ?? null, error: null }),
              then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                resolve({ data: resumeCandidateRows, error: null }),
            };
            const normalChain: Record<string, unknown> = {
              eq: () => normalChain,
              gte: () => normalChain,
              order: () => normalChain,
              // Two real call shapes end here, distinguished by what comes
              // next: the main 48h openLead lookup always calls
              // .order().limit(1).maybeSingle() (handled below, via the
              // spread-preserved maybeSingle), while attemptConversationResume's
              // secondary "any lead at all in the 14-day window" existence
              // check never calls .order() or .maybeSingle() at all — it's
              // awaited directly off .limit(1) (query shape: .eq().eq().gte().limit(1)),
              // which this .then resolves independently via
              // anyPriorLeadInExtendedWindow, never leadState (a completely
              // different, 48-hour-scoped concept).
              limit: () => ({
                ...normalChain,
                then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                  resolve({
                    data: config.anyPriorLeadInExtendedWindow ? [{ id: "any-prior-lead" }] : [],
                    error: null,
                  }),
              }),
              maybeSingle: async () => ({ data: leadState ? { ...leadState } : null, error: null }),
              then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                resolve({ data: leadState ? [{ ...leadState }] : [], error: null }),
              in: (col: string, values: unknown[]) => {
                calls.resumeStatusInArgs.push(values);
                return resumeChain;
              },
            };
            return normalChain;
          },
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
                  // leadState is only null for resume tests where the main
                  // 48h lookup found nothing — a resumed lead is a
                  // different, separately-tracked object (resumeCandidateRows),
                  // so there's nothing of leadState's to mutate here.
                  if (leadState) Object.assign(leadState, patch);
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
                    if (leadState) Object.assign(leadState, patch);
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
        // to build its price-sheet argument — content is usually
        // irrelevant since getQuoteEstimate itself is mocked, except for
        // the broad-service-inquiry short-circuit (handleFreshQuote),
        // which reads this directly, before getQuoteEstimate is ever
        // reached.
        return { select: () => ({ eq: async () => ({ data: config.priceSheetRows ?? [], error: null }) }) };
      }
      if (table === "tenant_capabilities") {
        // getActiveCapabilitiesForTenant's own query shape:
        // .select(...).eq("tenant_id", ...).eq("active", true).order(...).
        const rows = config.capabilities ?? [];
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({ data: rows, error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`fakeInboundAdmin: unexpected table "${table}"`);
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls, leadState };
}

// ---------------------------------------------------------------------
// Extended-window conversation resume — attemptConversationResume is
// exported solely so this decision logic (candidate selection, the
// never-guess-above-MAX_RESUME_CANDIDATES fallback, the single-confident-
// match auto-resume, the ask-rather-than-guess fallback) is directly
// testable without re-driving the whole handleInboundWhatsAppMessage
// pipeline for every scenario — same reasoning decideLeadRoute's own
// export already follows above. A separate describe block below exercises
// the WIRING into handleInboundWhatsAppMessage itself (route recomputed,
// quoted_follow_up takes over, no duplicate lead created).
// ---------------------------------------------------------------------

const OLD_UNRESOLVED_LEAD: FakeOpenLead = {
  id: "lead-old-1",
  customer_name: "Jordan",
  photo_url: null,
  problem: "the kitchen faucet is still dripping after the last visit",
  confidence: "High",
  diagnosis: "Worn cartridge replacement",
  flag_type: null,
  status: "quoted",
};

describe("attemptConversationResume", () => {
  beforeEach(() => {
    vi.mocked(classifyFollowUpIntent).mockClear();
  });

  it("zero candidates in the extended window: no_match, classifyFollowUpIntent never called, nothing sent", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [],
    });
    const { adapter, sent } = fakeAdapter();

    const outcome = await attemptConversationResume({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      body: "hi, is anyone there?",
    });

    // No candidate AND no other lead of any status in the 14-day window —
    // a genuinely first-time (or long-dormant-enough-not-to-matter)
    // contact, not just "nothing resumable."
    expect(outcome).toEqual({ kind: "no_match", hadPriorHistory: false });
    expect(classifyFollowUpIntent).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("one candidate, classified same_job: resumes it, sends exactly one localized acknowledgment naming the real stored problem, and queries only the resumable status set (won/lost excluded by construction, not by later filtering)", async () => {
    const { admin, calls } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [OLD_UNRESOLVED_LEAD],
    });
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "same_job" } as any);
    const { adapter, sent } = fakeAdapter();

    const outcome = await attemptConversationResume({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      body: "is that still happening?",
    });

    expect(outcome.kind).toBe("resumed");
    if (outcome.kind === "resumed") expect(outcome.lead.id).toBe(OLD_UNRESOLVED_LEAD.id);
    expect(classifyFollowUpIntent).toHaveBeenCalledWith({
      data: {
        priorProblem: OLD_UNRESOLVED_LEAD.problem,
        priorDiagnosis: OLD_UNRESOLVED_LEAD.diagnosis,
        customerReply: "is that still happening?",
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(TEST_PHONE);
    expect(sent[0]!.body).toContain("kitchen faucet is still dripping");
    expect(calls.leadMessageInserts).toEqual([
      { lead_id: OLD_UNRESOLVED_LEAD.id, role: "assistant", body: sent[0]!.body },
    ]);
    // The real safety guarantee for "a completed job must not automatically
    // become the active conversation": the query's own status filter is the
    // resumable set, never won/lost — confirmed against the real exported
    // constant, not a hardcoded duplicate list that could silently drift.
    expect(calls.resumeStatusInArgs).toHaveLength(1);
    expect(calls.resumeStatusInArgs[0]).toEqual([...RESUMABLE_STATUSES]);
    expect(calls.resumeStatusInArgs[0]).not.toContain("won");
    expect(calls.resumeStatusInArgs[0]).not.toContain("lost");
  });

  it("one candidate, classified same_job, prior problem in Spanish: the acknowledgment is localized to Spanish, never defaults to English", async () => {
    const spanishLead: FakeOpenLead = {
      ...OLD_UNRESOLVED_LEAD,
      problem: "la llave de la cocina todavía gotea",
    };
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [spanishLead],
    });
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "same_job" } as any);
    const { adapter, sent } = fakeAdapter();

    await attemptConversationResume({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      body: "¿sigue goteando?",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Retomando esto");
    expect(sent[0]!.body).toContain("llave de la cocina");
  });

  it("one candidate, classified different_job: no_match — a genuinely new request is never silently attached to the old job, and nothing about it is recorded", async () => {
    const { admin, calls } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [OLD_UNRESOLVED_LEAD],
    });
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "different_job" } as any);
    const { adapter, sent } = fakeAdapter();

    const outcome = await attemptConversationResume({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      body: "my garage door opener is making a grinding noise",
    });

    // A real candidate existed and was classified — so this customer IS a
    // known returning one, even though nothing here was a match.
    expect(outcome).toEqual({ kind: "no_match", hadPriorHistory: true });
    expect(sent).toEqual([]); // no acknowledgment, no clarifying question
    expect(calls.leadMessageInserts).toEqual([]); // no contamination of any kind
  });

  // PRODUCTION GAP (2026-10-27): a payment message arriving on a phone with
  // a resumable candidate lead must never produce the "which job is this
  // about?" disambiguation reply below — that would itself be a
  // customer-facing message about an out-of-scope message. "out_of_scope"
  // is excluded from "plausible" the same way "different_job" is, so this
  // falls through to no_match exactly like the different_job case above,
  // letting the normal fresh_quote path (RULE 0 in buildPrompt) handle the
  // silence instead.
  it("one candidate, classified out_of_scope: no_match — never asks which job a payment message is about, no acknowledgment, no contamination", async () => {
    const { admin, calls } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [OLD_UNRESOLVED_LEAD],
    });
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "out_of_scope" } as any);
    const { adapter, sent } = fakeAdapter();

    const outcome = await attemptConversationResume({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      body: "Did you receive my payment?",
    });

    expect(outcome).toEqual({ kind: "no_match", hadPriorHistory: true });
    expect(sent).toEqual([]); // no disambiguation question, no acknowledgment
    expect(calls.leadMessageInserts).toEqual([]);
  });

  it("one candidate, classified ambiguous: asks a single clarifying question naming only that job — never guesses either way", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [OLD_UNRESOLVED_LEAD],
    });
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "ambiguous" } as any);
    const { adapter, sent } = fakeAdapter();

    const outcome = await attemptConversationResume({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      body: "ok",
    });

    expect(outcome).toEqual({ kind: "handled" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe(
      'Is this about "the kitchen faucet is still dripping after the last visit", or something new?',
    );
  });

  it("two plausible candidates (one same_job, one ambiguous): asks which one rather than silently picking either — the required 'ask instead of guess' fallback for more than one match", async () => {
    const faucetLead: FakeOpenLead = {
      ...OLD_UNRESOLVED_LEAD,
      id: "lead-faucet",
      problem: "the kitchen faucet is still dripping",
    };
    const garageLead: FakeOpenLead = {
      ...OLD_UNRESOLVED_LEAD,
      id: "lead-garage",
      problem: "the garage door opener makes a grinding noise",
      diagnosis: "Opener motor inspection",
    };
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [faucetLead, garageLead],
    });
    vi.mocked(classifyFollowUpIntent).mockImplementation(async ({ data }: any) => ({
      classification: data.priorProblem.includes("garage") ? "ambiguous" : "same_job",
    }));
    const { adapter, sent } = fakeAdapter();

    const outcome = await attemptConversationResume({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      body: "any update?",
    });

    expect(outcome).toEqual({ kind: "handled" });
    expect(classifyFollowUpIntent).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe(
      'I have more than one thing open for you — is this about "the kitchen faucet is still dripping", or "the garage door opener makes a grinding noise"?',
    );
  });

  it("more than MAX_RESUME_CANDIDATES plausible leads: never guesses from a partial set — sends one honest clarifying question and never even runs classification", async () => {
    const candidates: FakeOpenLead[] = Array.from({ length: 4 }, (_, i) => ({
      ...OLD_UNRESOLVED_LEAD,
      id: `lead-${i}`,
      problem: `job number ${i}`,
    }));
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: candidates,
    });
    const { adapter, sent } = fakeAdapter();

    const outcome = await attemptConversationResume({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      body: "any update?",
    });

    expect(outcome).toEqual({ kind: "handled" });
    // Never classifies against an arbitrary subset and silently ignores the
    // rest — the safe fallback is a single honest question, not a guess
    // from whichever MAX_RESUME_CANDIDATES+1 happened to come back first.
    expect(classifyFollowUpIntent).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        to: TEST_PHONE,
        body: "I see a few things in progress for you — could you remind me which one this is about?",
      },
    ]);
  });

  it("exactly MAX_RESUME_CANDIDATES (3) candidates, all plausible: proceeds through normal classification instead of the too-many fallback — the limit is 'more than 3', not 'any multiple'", async () => {
    const candidates: FakeOpenLead[] = Array.from({ length: 3 }, (_, i) => ({
      ...OLD_UNRESOLVED_LEAD,
      id: `lead-${i}`,
      problem: `job number ${i}`,
    }));
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: candidates,
    });
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "same_job" } as any);
    const { adapter, sent } = fakeAdapter();

    const outcome = await attemptConversationResume({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      body: "any update?",
    });

    expect(classifyFollowUpIntent).toHaveBeenCalledTimes(3);
    // 3 confident matches, not exactly 1 — still asks rather than guessing,
    // but via the normal "more than one plausible" path, not the too-many
    // fallback (proven above by classification actually having run).
    expect(outcome).toEqual({ kind: "handled" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).not.toBe(
      "I see a few things in progress for you — could you remind me which one this is about?",
    );
  });

  // Fix 1 — a flagged lead with no price yet (needs_human_review,
  // outside_service_scope, conflicting_information, loop_suspected) always
  // routes to fresh_quote on its next message, by design (decideLeadRoute's
  // own flag_type check) — it must never receive a resume acknowledgment it
  // then can't actually honor, which would otherwise create a disconnected
  // duplicate lead right after telling the customer their conversation was
  // being picked back up.
  it("a flagged lead with no price yet is never resumed, even on a confident same-job match — it still counts as real prior history, but is filtered out before classification ever runs", async () => {
    const unpricedFlaggedLead: FakeOpenLead = {
      ...OLD_UNRESOLVED_LEAD,
      id: "lead-unpriced-flagged",
      confidence: null,
      flag_type: "needs_human_review",
      status: "flagged",
    };
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [unpricedFlaggedLead],
    });
    const { adapter, sent } = fakeAdapter();

    const outcome = await attemptConversationResume({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      body: "is that still happening?",
    });

    // decideLeadRoute(unpricedFlaggedLead) === "fresh_quote" (confidence
    // null, flag_type set) — filtered out before any AI call, not just
    // before the acknowledgment.
    expect(classifyFollowUpIntent).not.toHaveBeenCalled();
    expect(sent).toEqual([]); // no false "picking this back up"
    // Still real prior history — a returning customer, just nothing
    // resumable about this specific lead.
    expect(outcome).toEqual({ kind: "no_match", hadPriorHistory: true });
  });

  it("a flagged lead that DOES already have a real price (e.g. pending_negotiated_price) stays resumable — flagged alone is never the disqualifier, only the combination with no price yet", async () => {
    const pricedFlaggedLead: FakeOpenLead = {
      ...OLD_UNRESOLVED_LEAD,
      id: "lead-priced-flagged",
      confidence: "High",
      flag_type: "pending_negotiated_price",
      status: "flagged",
    };
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [pricedFlaggedLead],
    });
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "same_job" } as any);
    const { adapter, sent } = fakeAdapter();

    const outcome = await attemptConversationResume({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      body: "any update on the price?",
    });

    // decideLeadRoute(pricedFlaggedLead) === "quoted_follow_up" (confidence
    // set, not won/lost) — a safe, valid downstream route, so this one
    // DOES get classified and resumed normally.
    expect(classifyFollowUpIntent).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("resumed");
    expect(sent).toHaveLength(1);
  });

  it("when the acknowledgment send itself is suppressed by the loop guard, the outcome is 'handled', not a false 'resumed' — the caller never continues processing as though it went out", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [OLD_UNRESOLVED_LEAD],
      // Trips the SAME record_whatsapp_interaction RPC sendGuardedReply's
      // own evaluateOutboundInteraction calls — simulating the loop guard
      // suppressing this specific send, independent of (and reached only
      // after) the resume-matching logic above it.
      loopGuardTripped: true,
    });
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "same_job" } as any);
    const { adapter, sent } = fakeAdapter();

    const outcome = await attemptConversationResume({
      admin,
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      adapter,
      body: "is that still happening?",
    });

    expect(outcome).toEqual({ kind: "handled" });
    // The generic pause notice went out instead of the acknowledgment —
    // never both, never neither.
    expect(sent).toEqual([{ to: TEST_PHONE, body: LOOP_PAUSE_MESSAGE }]);
  });
});

describe("attemptConversationResume — tenant isolation on the service-role path", () => {
  it("two tenants sharing the same phone number never see each other's resume candidates — getAdminClient bypasses RLS entirely, so isolation here depends ENTIRELY on this query's own tenant_id filter", async () => {
    const SHARED_PHONE = "+15559998888";
    // A real (if minimal) tenant_id+phone filter, unlike fakeInboundAdmin's
    // resumeCandidates (a static list that ignores tenant_id) — this
    // fixture exists specifically to prove the .eq("tenant_id", ...) filter
    // in the real query is what isolation depends on here, since the
    // service-role client has no RLS to fall back on if that filter were
    // ever dropped.
    const allLeads = [
      {
        tenant_id: "tenant-A",
        id: "lead-A1",
        customer_name: "A Customer",
        photo_url: null,
        problem: "tenant A's leaking faucet",
        confidence: null,
        diagnosis: null,
        flag_type: null,
        status: "new",
        phone: SHARED_PHONE,
      },
      {
        tenant_id: "tenant-B",
        id: "lead-B1",
        customer_name: "B Customer",
        photo_url: null,
        problem: "tenant B's broken garage door",
        confidence: null,
        diagnosis: null,
        flag_type: null,
        status: "new",
        phone: SHARED_PHONE,
      },
    ];

    function adminFor() {
      return {
        from: (table: string) => {
          if (table === "lead_messages") {
            return { insert: async () => ({ error: null }) };
          }
          if (table !== "leads") throw new Error(`unexpected table "${table}"`);
          const filters: { tenant_id?: string; phone?: string } = {};
          const chain: Record<string, unknown> = {
            eq: (col: string, val: string) => {
              if (col === "tenant_id") filters.tenant_id = val;
              if (col === "phone") filters.phone = val;
              return chain;
            },
            gte: () => chain,
            order: () => chain,
            in: () => chain,
            limit: (n: number) => ({
              then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
                const matches = allLeads.filter(
                  (l) => l.tenant_id === filters.tenant_id && l.phone === filters.phone,
                );
                resolve({ data: matches.slice(0, n), error: null });
              },
            }),
          };
          return { select: () => chain };
        },
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
          throw new Error(`unexpected rpc "${name}"`);
        },
      } as unknown as SupabaseClient;
    }

    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "same_job" } as any);
    const { adapter: adapterA, sent: sentA } = fakeAdapter();
    const { adapter: adapterB, sent: sentB } = fakeAdapter();

    const outcomeA = await attemptConversationResume({
      admin: adminFor(),
      tenant: { ...TEST_TENANT, id: "tenant-A" },
      fromPhone: SHARED_PHONE,
      adapter: adapterA,
      body: "following up",
    });
    const outcomeB = await attemptConversationResume({
      admin: adminFor(),
      tenant: { ...TEST_TENANT, id: "tenant-B" },
      fromPhone: SHARED_PHONE,
      adapter: adapterB,
      body: "following up",
    });

    expect(outcomeA.kind).toBe("resumed");
    expect(outcomeB.kind).toBe("resumed");
    if (outcomeA.kind === "resumed") expect(outcomeA.lead.id).toBe("lead-A1");
    if (outcomeB.kind === "resumed") expect(outcomeB.lead.id).toBe("lead-B1");
    expect(sentA[0]!.body).toContain("leaking faucet");
    expect(sentA[0]!.body).not.toContain("garage door");
    expect(sentB[0]!.body).toContain("garage door");
    expect(sentB[0]!.body).not.toContain("leaking faucet");
  });
});

describe("handleInboundWhatsAppMessage — conversation resume wiring", () => {
  beforeEach(() => {
    vi.mocked(classifyFollowUpIntent).mockClear();
    // mockReset (not mockClear): these two carry a per-test resolved value,
    // and only some tests in this block set one — without resetting, a
    // prior test's configured value leaks into a later test that never
    // asked for it (the exact bug the redelivered-webhook test caught).
    vi.mocked(getFollowUpAnswer).mockReset();
    vi.mocked(getQuoteEstimate).mockReset();
    vi.mocked(createLead).mockClear();
    vi.mocked(createClarifyingLead).mockClear();
  });

  it("no lead in the last 48h, one unresolved quoted job from days ago, same_job: resumes it, answers using the OLD diagnosis, and never creates a duplicate lead", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [OLD_UNRESOLVED_LEAD],
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "same_job" } as any);
    vi.mocked(getFollowUpAnswer).mockResolvedValue("Yes, still the same price for that.");
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "is that offer still good?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toContain("kitchen faucet is still dripping"); // resume acknowledgment
    expect(sent[1]!.body).toBe("Yes, still the same price for that."); // quoted_follow_up's own answer
    expect(getFollowUpAnswer).toHaveBeenCalledTimes(1);
    expect(getQuoteEstimate).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
    expect(createClarifyingLead).not.toHaveBeenCalled();
  });

  it("a booked job (appointment already scheduled) can still be resumed for an appointment-related follow-up — booked is never treated as terminal the way won/lost are", async () => {
    const bookedLead: FakeOpenLead = {
      ...OLD_UNRESOLVED_LEAD,
      id: "lead-booked-1",
      problem: "water heater replacement, scheduled install",
      status: "booked",
    };
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [bookedLead],
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "same_job" } as any);
    vi.mocked(getFollowUpAnswer).mockResolvedValue("Yes, we'll be there Tuesday at 10am.");
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "what time will you be here?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    // Resumed into quoted_follow_up (getFollowUpAnswer ran), never treated
    // as a fresh request just because it's reached through the extended
    // window — the exact "booked may be resumed for appointment questions"
    // requirement.
    expect(getFollowUpAnswer).toHaveBeenCalledTimes(1);
    expect(getQuoteEstimate).not.toHaveBeenCalled();
    expect(sent[1]!.body).toBe("Yes, we'll be there Tuesday at 10am.");
  });

  it("a finished (won) job on file never resurfaces as a resume candidate — a genuinely new request proceeds straight to a fresh quote, with no wasted classification call against the closed job", async () => {
    // RESUMABLE_STATUSES excludes won/lost at the query level (proven
    // directly above) — resumeCandidates: [] here simulates exactly what
    // the real query would already have filtered out, not an extra
    // application-level check.
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [],
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "Electrical",
      severity: "Low",
      confidence: "High",
      diagnosis: "Outlet replacement.",
      isDiagnosisOnly: false,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        {
          description: "Outlet replacement",
          detail: "",
          amount: 150,
          priceSheetItemId: "ps-outlet",
          hours: undefined,
        },
      ],
      totalLow: 150,
      totalHigh: 150,
    } as any);
    vi.mocked(createLead).mockResolvedValue({ id: "new-outlet-lead" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "my bedroom outlet stopped working",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(classifyFollowUpIntent).not.toHaveBeenCalled(); // nothing to classify against
    expect(getQuoteEstimate).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("150");
  });

  it("a redelivered webhook for the same resume-triggering message is caught by the top-level loop guard before any second resume attempt — never a duplicate acknowledgment or a second AI classification round", async () => {
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "same_job" } as any);
    // The resumed lead's confidence is set, so it routes to quoted_follow_up
    // right after resuming — same_job there calls getFollowUpAnswer for its
    // own reply, a second send alongside the resume acknowledgment itself.
    vi.mocked(getFollowUpAnswer).mockResolvedValue("Yes, still the same price for that.");

    // First delivery: processes normally, resumes the old lead.
    const first = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [OLD_UNRESOLVED_LEAD],
    });
    vi.mocked(getAdminClient).mockReturnValue(first.admin);
    const { adapter: adapter1, sent: sent1 } = fakeAdapter();
    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "is that still happening?",
      mediaRef: undefined,
      providerMessageId: "wamid.FIRST",
      profileName: undefined,
      channel: "WhatsApp",
      adapter: adapter1,
    });
    expect(sent1).toHaveLength(2); // resume acknowledgment + quoted_follow_up's own answer
    expect(classifyFollowUpIntent).toHaveBeenCalledTimes(2); // resume match + quoted_follow_up's own same_job check

    // Second delivery: the loop guard's own duplicate-content detection
    // (real-Postgres logic — see fakeInboundAdmin's own notes on why this
    // file doesn't reimplement that RPC's hashing) recognizes the
    // redelivered event and trips BEFORE any routing or resume logic runs.
    vi.mocked(classifyFollowUpIntent).mockClear();
    const second = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [OLD_UNRESOLVED_LEAD],
      loopGuardTripped: true,
    });
    vi.mocked(getAdminClient).mockReturnValue(second.admin);
    const { adapter: adapter2, sent: sent2 } = fakeAdapter();
    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "is that still happening?",
      mediaRef: undefined,
      providerMessageId: "wamid.FIRST",
      profileName: undefined,
      channel: "WhatsApp",
      adapter: adapter2,
    });

    expect(classifyFollowUpIntent).not.toHaveBeenCalled(); // never re-runs resume matching
    expect(sent2).toEqual([{ to: TEST_PHONE, body: LOOP_PAUSE_MESSAGE }]); // generic pause, not a second ack
  });
});

// Phase 2, P0.1 — the diagnosis-visit-fee quote line used to say "this
// applies toward the total repair cost... once we know what's needed" —
// factually wrong for a non-repair business (a salon, consultant, or
// cleaning company isn't repairing anything). Confirms the wording is now
// industry-neutral in both languages, through the real pipeline, not just
// read from source.
describe("quote price line wording — industry-neutral diagnosis-fee phrasing (no repair-specific language)", () => {
  beforeEach(() => {
    vi.mocked(getQuoteEstimate).mockReset();
    vi.mocked(createLead).mockClear();
  });

  it("English: the diagnosis-fee line says 'total job cost,' never 'repair cost' or 'the fix'", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [],
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "General",
      severity: "Low",
      confidence: "Medium",
      diagnosis: "Needs an in-person look before pricing.",
      isDiagnosisOnly: true,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        { description: "Diagnostic visit", detail: "", amount: 89, priceSheetItemId: "service_call", hours: undefined },
      ],
      totalLow: 89,
      totalHigh: 89,
    } as any);
    vi.mocked(createLead).mockResolvedValue({ id: "new-lead-1" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "I'm not sure what's wrong, can you take a look?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("total job cost");
    expect(sent[0]!.body).not.toContain("repair cost");
    expect(sent[0]!.body).not.toContain("the fix");
  });

  it("Spanish: the diagnosis-fee line says 'costo total del trabajo,' never 'la reparación'", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [],
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "General",
      severity: "Low",
      confidence: "Medium",
      diagnosis: "Necesita una visita en persona antes de poder dar un precio.",
      isDiagnosisOnly: true,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        { description: "Visita de diagnóstico", detail: "", amount: 89, priceSheetItemId: "service_call", hours: undefined },
      ],
      totalLow: 89,
      totalHigh: 89,
    } as any);
    vi.mocked(createLead).mockResolvedValue({ id: "new-lead-2" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "No estoy segura de qué pasa, ¿pueden revisar?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("costo total del trabajo");
    expect(sent[0]!.body).not.toContain("la reparación");
  });
});

// Fix 2/3 — the 14-day resume lookback can discover real prior history
// (a won/lost lead, or a lead classified as a different job) even when
// nothing is actually resumed. That history must not be discarded: a
// returning customer must never get the first-contact greeting just
// because hasPriorInboundInteraction's own 48-hour window alone can't see
// that far back. These tests use the fixture's new
// hadPriorInboundInteraction/anyPriorLeadInExtendedWindow fields (Fix 3) to
// genuinely exercise all three cases, rather than the pre-existing
// fixture default that made isFirstContact unconditionally false.
describe("handleInboundWhatsAppMessage — first-contact greeting correctly reflects the 14-day history signal", () => {
  const FIRST_CONTACT_PHRASE = "How can I help you today?";
  const RETURNING_GREETING_PHRASE = "To get you a fast, accurate price";

  beforeEach(() => {
    vi.mocked(classifyFollowUpIntent).mockClear();
    vi.mocked(getQuoteEstimate).mockReset();
    vi.mocked(createLead).mockClear();
  });

  it("baseline: genuinely no prior history anywhere (no 48h interaction, no 14-day lead of any status) — the first-contact greeting still fires normally", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [],
      hadPriorInboundInteraction: false,
      anyPriorLeadInExtendedWindow: false,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "hi",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain(FIRST_CONTACT_PHRASE);
  });

  it("a won lead exists in the 14-day window (excluded from resume eligibility) — still correctly suppresses the first-contact greeting; the customer gets the ordinary returning-customer prompt instead", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      // Nothing resumable — a won lead is never a resumeCandidates row
      // (excluded by RESUMABLE_STATUSES at the query level) — but it DOES
      // show up in attemptConversationResume's own secondary existence
      // check, which doesn't filter by status.
      resumeCandidates: [],
      hadPriorInboundInteraction: false,
      anyPriorLeadInExtendedWindow: true,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "hi",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    // This is the whole point of the fix: if isFirstContact ignored the
    // 14-day signal (i.e. this assertion were run against the pre-fix
    // code), this customer — who just had a completed job 5 days ago —
    // would wrongly get FIRST_CONTACT_PHRASE here instead.
    expect(sent[0]!.body).not.toContain(FIRST_CONTACT_PHRASE);
    expect(sent[0]!.body).toContain(RETURNING_GREETING_PHRASE);
  });

  it("a prior lead classified as a different job establishes real history for a substantial message too — the fresh quote it still gets is never prefixed with the first-contact greeting", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [OLD_UNRESOLVED_LEAD],
      hadPriorInboundInteraction: false,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "different_job" } as any);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "Electrical",
      severity: "Low",
      confidence: "High",
      diagnosis: "Outlet replacement.",
      isDiagnosisOnly: false,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        {
          description: "Outlet replacement",
          detail: "",
          amount: 150,
          priceSheetItemId: "ps-outlet",
          hours: undefined,
        },
      ],
      totalLow: 150,
      totalHigh: 150,
    } as any);
    vi.mocked(createLead).mockResolvedValue({ id: "new-outlet-lead" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "my bedroom outlet stopped working",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("150"); // still a genuine fresh quote
    expect(sent[0]!.body).not.toContain(FIRST_CONTACT_PHRASE); // but not greeted as brand new
    // And the OLD candidate's own content never leaks into this new lead —
    // same transcript-isolation guarantee as the direct attemptConversationResume
    // tests above, now confirmed through the full pipeline too.
    expect(sent[0]!.body).not.toContain(OLD_UNRESOLVED_LEAD.problem);
  });
});

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
    // PRODUCTION REGRESSION (2026-10-27): JIR only responds within the
    // configured Price Sheet's scope — an outOfScope result now sends NO
    // customer-facing WhatsApp reply at all. Everything else (flag update,
    // owner notification, claim release) still fires exactly once.
    expect(sent).toEqual([]);
    expect(sendFollowUpNotificationEmail).toHaveBeenCalledTimes(1); // exactly once, not duplicated
    expect(calls.leadUpdateAttempts).toBe(1);
    expect(calls.leadUpdateApplied).toBe(1);
    expect(calls.lastLeadUpdatePatch?.["flag_type"]).toBe("outside_service_scope");
    expect(calls.releaseAttempts).toBe(1); // claim released after the callback completes
  });

  // Phase 2 — "configured exclusions actually control AI behavior." When
  // getQuoteEstimate's own exclusion guard (estimate-server.ts) is what
  // produced this outOfScope result, the mid-clarification path must flag
  // it distinctly from a genuine "nothing on the price sheet covers this"
  // — same mechanism as the fresh-quote test below, exercised through the
  // continue_clarification branch instead.
  it("continue_clarification: an outOfScope result caused by a configured exclusion is flagged excluded_service, not outside_service_scope", async () => {
    const { admin, calls } = fakeInboundAdmin({
      openLead: {
        id: "lead-gas",
        customer_name: "Pat",
        photo_url: null,
        problem: "install a gas line",
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
      excludedServiceLabel: "Gas line installation",
    } as any);
    const { adapter } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "it's for a new stove hookup",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(calls.lastLeadUpdatePatch?.["flag_type"]).toBe("excluded_service");
    expect(calls.lastLeadUpdatePatch?.["flag_reason"]).toContain("Gas line installation");
  });

  // PRODUCTION REGRESSION (2026-10-27): JIR only responds within the
  // configured Price Sheet's scope — an outOfScope result now sends no
  // customer-facing reply at all, regardless of whether the model's
  // "acknowledgment" field is present. (Historical context: this field was
  // originally added so a cold, generic "I'll pass your message along to
  // our team." could open with a warmer acknowledgment of what the
  // customer actually said — real customer regression, "Not cooling and
  // needs a clean" about an AC unit the business doesn't service. That
  // wording is now moot for WhatsApp specifically, since no reply is sent
  // either way — acknowledgment may still matter to other channels this
  // file doesn't touch.)
  it("out-of-scope handoff sends no reply whether or not the model provides an acknowledgment", async () => {
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

    expect(sent).toEqual([]);
  });

  it("out-of-scope handoff still sends no reply when the model omits acknowledgment", async () => {
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

    expect(sent).toEqual([]);
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

describe("quoted_follow_up text classification — four-way (same_job / different_job / ambiguous / out_of_scope)", () => {
  beforeEach(() => {
    vi.mocked(getFollowUpAnswer).mockClear();
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(classifyFollowUpIntent).mockClear();
    vi.mocked(createLead).mockClear();
    vi.mocked(sendFollowUpNotificationEmail).mockClear();
  });

  // PRODUCTION GAP (2026-10-27): a payment/deposit/administrative message
  // on an already-quoted lead never went through getQuoteEstimate's RULE 0
  // at all — classifyFollowUpIntent had no "this isn't a service follow-up"
  // option, so a message like "Did you receive my payment?" read as
  // substantively about that job's payment and landed on "same_job",
  // which getFollowUpAnswer would then confidently answer. This is the
  // fix: the classifier's new 4th option short-circuits straight to the
  // same silence treatment as the other three outOfScope branches.
  it('classification="out_of_scope": a payment message on an already-quoted lead gets NO customer-facing reply, but the lead is flagged and the owner notified', async () => {
    const { admin, calls } = fakeInboundAdmin({ openLead: QUOTED_FAUCET_LEAD, leadSlotClaimSucceeds: true });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyFollowUpIntent).mockResolvedValue({ classification: "out_of_scope" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Did you receive my payment?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getFollowUpAnswer).not.toHaveBeenCalled();
    expect(getQuoteEstimate).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(calls.lastLeadUpdatePatch?.["flag_type"]).toBe("outside_service_scope");
    expect(sendFollowUpNotificationEmail).toHaveBeenCalledTimes(1);
    const emailArg = vi.mocked(sendFollowUpNotificationEmail).mock.calls[0]![0] as { body: string };
    expect(emailArg.body).toContain("Did you receive my payment?");
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

// A broad "what do you offer" / "send me your full list" message should
// never produce a 50+-item AI-generated wall of text — but it also isn't a
// job to price, a clarification answer, or out of scope, so it doesn't fit
// getQuoteEstimate's three-way contract. classifyBroadServiceInquiry
// (estimate-server.ts) is a small, separate, single-purpose classifier
// checked in handleFreshQuote before getQuoteEstimate is ever called; the
// reply it produces is always a deterministic template built from the
// tenant's own price-sheet categories and its own slug, never AI free text.
const PRICED_ROWS_FOR_OVERVIEW = [
  {
    id: "p1",
    task: "Ceiling fan install",
    category: "Electrical",
    keywords: [],
    pricing_type: "flat",
    price_min: 150,
    price_max: 150,
    hours: 1,
    bundleable: false,
    materials_policy: "included",
    diagnosis_pricing_type: null,
    diagnosis_fee: null,
    ai_notes: null,
  },
  {
    id: "p2",
    task: "Drain clearing",
    category: "Plumbing",
    keywords: [],
    pricing_type: "flat",
    price_min: 120,
    price_max: 120,
    hours: 1,
    bundleable: false,
    materials_policy: "included",
    diagnosis_pricing_type: null,
    diagnosis_fee: null,
    ai_notes: null,
  },
];

describe("handleFreshQuote — broad service-inquiry short-circuit", () => {
  beforeEach(() => {
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(classifyBroadServiceInquiry).mockClear();
    vi.mocked(createLead).mockClear();
    vi.mocked(createClarifyingLead).mockClear();
    vi.mocked(createFlaggedLead).mockClear();
  });

  it('classification="broad_overview" with priced services: sends the deterministic category+link template, never calls getQuoteEstimate, creates no lead', async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      priceSheetRows: PRICED_ROWS_FOR_OVERVIEW,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyBroadServiceInquiry).mockResolvedValue({ classification: "broad_overview" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "What services do you offer?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getQuoteEstimate).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
    expect(createFlaggedLead).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body;
    expect(body).toContain("Electrical");
    expect(body).toContain("Plumbing");
    expect(body).toContain(`https://www.jobitready.com/menu/${TEST_TENANT.slug}`);
  });

  it('classification="broad_overview" but no priced services exist: never fabricates a menu link, falls through to the normal getQuoteEstimate flow instead', async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      priceSheetRows: [], // nothing priced — nothing honest to list or link to
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: true,
      questions: [{ question: "What do you need done?", options: [] }],
    } as any);
    vi.mocked(createClarifyingLead).mockResolvedValue({ id: "clarifying-lead-1" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "What services do you offer?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    // Gated on categories.length > 0 before the classifier is even called —
    // with no priced rows at all, there's nothing to short-circuit.
    expect(classifyBroadServiceInquiry).not.toHaveBeenCalled();
    expect(getQuoteEstimate).toHaveBeenCalledTimes(1);
    expect(sent.some((m) => m.body.includes("jobitready.com/menu"))).toBe(false);
  });

  it('classification="specific_or_other" (regression guard): a real service question still goes through getQuoteEstimate normally', async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      priceSheetRows: PRICED_ROWS_FOR_OVERVIEW,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyBroadServiceInquiry).mockResolvedValue({ classification: "specific_or_other" } as any);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "Electrical",
      severity: "Low",
      confidence: "High",
      diagnosis: "Ceiling fan installation.",
      isDiagnosisOnly: false,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        { description: "Ceiling fan install", detail: "", amount: 150, priceSheetItemId: "p1", hours: 1 },
      ],
      totalLow: 150,
      totalHigh: 150,
    } as any);
    vi.mocked(createLead).mockResolvedValue({ id: "new-fan-lead" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Do you install ceiling fans?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getQuoteEstimate).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("150");
  });

  it("a photo attached never triggers the broad-inquiry classifier, even with priced services and broad-sounding text", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      priceSheetRows: PRICED_ROWS_FOR_OVERVIEW,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({ needsClarification: true, questions: [] } as any);
    vi.mocked(createClarifyingLead).mockResolvedValue({ id: "clarifying-lead-2" } as any);
    const { adapter } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "what do you guys do?",
      mediaRef: "media-ref-1",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(classifyBroadServiceInquiry).not.toHaveBeenCalled();
  });

  it('classification="broad_overview" in Spanish: the overview and menu intro are localized, never default to English', async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      priceSheetRows: PRICED_ROWS_FOR_OVERVIEW,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(classifyBroadServiceInquiry).mockResolvedValue({ classification: "broad_overview" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "¿Qué servicios ofrecen?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Ofrecemos servicios de");
    expect(sent[0]!.body).toContain(`https://www.jobitready.com/menu/${TEST_TENANT.slug}`);
  });
});

// Composite regression (2026-10-27, approved during the Price-Sheet-only
// review): proves the full real-world sequence end to end rather than its
// individual pieces in isolation — an out-of-scope message must never
// "poison" the same customer's NEXT, genuinely in-scope request. Two
// separate handleInboundWhatsAppMessage calls, each against its own fake
// admin configured to represent the real DB state at that exact moment
// (the second call's openLead is exactly what message 1's own flagging
// write would have produced) — the same approach every other sequential-
// state scenario in this file already uses, since decideLeadRoute/
// handleLoopGuardPause are themselves stateless functions of whatever the
// DB currently holds, not of any in-memory history.
describe("production regression: an out-of-scope message must not suppress the customer's next, legitimate request", () => {
  it("message 1 (payment, out of scope) is silent and flags the lead; message 2 (a real listed service) reaches normal matching and is NOT suppressed by the loop guard", async () => {
    // --- Message 1: "Did you receive my payment?" on a brand-new conversation ---
    const { admin: admin1 } = fakeInboundAdmin({ openLead: null, leadSlotClaimSucceeds: true });
    vi.mocked(getAdminClient).mockReturnValue(admin1);
    vi.mocked(getQuoteEstimate).mockReset();
    vi.mocked(getQuoteEstimate).mockResolvedValueOnce({
      needsClarification: false,
      outOfScope: true,
    } as any);
    vi.mocked(createFlaggedLead).mockClear();
    vi.mocked(createFlaggedLead).mockResolvedValue({ id: "lead-payment-1" } as any);
    vi.mocked(sendFollowUpNotificationEmail).mockClear();
    const { adapter: adapter1, sent: sent1 } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Did you receive my payment?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: "Jordan",
      channel: "WhatsApp",
      adapter: adapter1,
    });

    // Requirement 2: no customer-facing WhatsApp reply for the out-of-scope message.
    expect(sent1).toEqual([]);
    expect(createFlaggedLead).toHaveBeenCalledTimes(1);
    const flaggedCall = vi.mocked(createFlaggedLead).mock.calls[0]![0] as { data: { flagType: string } };
    expect(flaggedCall.data.flagType).toBe("outside_service_scope");
    expect(sendFollowUpNotificationEmail).toHaveBeenCalledTimes(1); // owner still told

    // --- Message 2: a real, listed service request from the SAME phone ---
    // openLead here is exactly the state message 1's own flagging write
    // produced: the lead createFlaggedLead returned, confidence still
    // null (never priced), flag_type outside_service_scope. Per
    // decideLeadRoute's own rule, a flagged lead with no confidence
    // always routes to fresh_quote — real, pre-existing, intentional
    // behavior (a flagged/unpriced lead never gets "stuck" re-litigating
    // the thing that got it flagged); this test's job is to confirm that
    // restart actually reaches a normal priced reply, unsuppressed by
    // either decideLeadRoute or the loop guard.
    const { admin: admin2 } = fakeInboundAdmin({
      openLead: {
        id: "lead-payment-1",
        customer_name: "Jordan",
        photo_url: null,
        problem: "Did you receive my payment?",
        confidence: null,
        diagnosis: null,
        flag_type: "outside_service_scope",
      },
      leadSlotClaimSucceeds: true,
      priceSheetRows: PRICED_ROWS_FOR_OVERVIEW,
      // Explicit, not just the default — the point being verified is that
      // nothing about message 1's outside_service_scope flag trips the
      // guard on its own; a real trip is a volume/repeat signal entirely
      // independent of flag_type (see ALREADY_HANDED_OFF_FLAG_TYPES's own
      // comment in the source).
      loopGuardTripped: false,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin2);
    // mockClear() elsewhere in this file only clears call history, not a
    // previously-set mockResolvedValue — explicitly restore the real
    // default here so this message is actually classified normally
    // ("Do you install ceiling fans?" names a specific service, not a
    // broad "what do you offer" question) regardless of what the
    // immediately-preceding test in file-run order last configured this
    // mock to return.
    vi.mocked(classifyBroadServiceInquiry).mockResolvedValue({ classification: "specific_or_other" } as any);
    vi.mocked(getQuoteEstimate).mockReset();
    vi.mocked(getQuoteEstimate).mockResolvedValueOnce({
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "Electrical",
      severity: "Low",
      confidence: "High",
      diagnosis: "Ceiling fan installation.",
      isDiagnosisOnly: false,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        { description: "Ceiling fan install", detail: "", amount: 150, priceSheetItemId: "p1", hours: 1 },
      ],
      totalLow: 150,
      totalHigh: 150,
    } as any);
    vi.mocked(createLead).mockClear();
    vi.mocked(createLead).mockResolvedValue({ id: "lead-fan-2" } as any);
    const { adapter: adapter2, sent: sent2 } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Do you install ceiling fans?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: "Jordan",
      channel: "WhatsApp",
      adapter: adapter2,
    });

    // Requirements 3-5: the legitimate request reaches real service
    // matching (getQuoteEstimate actually ran against the live price
    // sheet) and the loop guard did NOT suppress the reply — a real,
    // priced, customer-facing message went out, not silence and not the
    // generic loop-pause notice.
    expect(getQuoteEstimate).toHaveBeenCalledTimes(1);
    expect(sent2).toHaveLength(1);
    expect(sent2[0]!.body).not.toBe(LOOP_PAUSE_MESSAGE);
    expect(sent2[0]!.body).toContain("Ceiling fan installation");
    expect(sent2[0]!.body).toContain("150");
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

  // Phase 2 — "configured exclusions actually control AI behavior." A
  // genuinely fresh (no prior lead) conversation whose outOfScope result
  // came from the exclusion guard, not a real no-match, must create the
  // flagged lead with flagType: "excluded_service" and a flag_reason the
  // owner can actually act on — distinguishing "the business refuses this"
  // from "nothing on the price sheet covers it" at the dashboard level,
  // never changing what the customer is told.
  it("handleFreshQuote: an outOfScope result caused by a configured exclusion creates a flagged lead with flagType excluded_service", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: true,
      excludedServiceLabel: "Gas line installation",
    } as any);
    vi.mocked(createFlaggedLead).mockClear();
    vi.mocked(createFlaggedLead).mockResolvedValue({ id: "new-lead-gas" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "I need a gas line run to my new stove",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(createFlaggedLead).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createFlaggedLead).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data["flagType"]).toBe("excluded_service");
    expect(call.data["flagReason"]).toContain("Gas line installation");
    // PRODUCTION REGRESSION (2026-10-27): JIR only responds within the
    // configured Price Sheet's scope — no customer-facing reply for any
    // outOfScope result, excluded_service included. The lead is still
    // correctly flagged (above) without ever revealing "you hit an
    // exclusion list" to the customer — there's simply no reply at all.
    expect(sent).toHaveLength(0);
  });

  // PRODUCTION REGRESSION (2026-10-27): the actual reported scenario this
  // silence mechanism exists for — a payment/deposit confirmation message
  // (now correctly classified outOfScope by RULE 0, simulated here since
  // this is a synthetic getQuoteEstimate result, not a live model call)
  // must send zero WhatsApp replies, while every piece of internal
  // bookkeeping the owner depends on still happens exactly as before.
  it("a payment/deposit-confirmation message: zero WhatsApp replies, but lead creation, message logging, and owner notification all still occur", async () => {
    const { admin, calls } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: true,
      acknowledgment: "Got it — a payment question.",
    } as any);
    vi.mocked(createFlaggedLead).mockClear();
    vi.mocked(createFlaggedLead).mockResolvedValue({ id: "new-lead-payment" } as any);
    vi.mocked(sendFollowUpNotificationEmail).mockClear();
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Hi, I sent the deposit via bank transfer yesterday, can you confirm you received it?",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    // Zero WhatsApp replies — the core requirement.
    expect(sent).toHaveLength(0);

    // Lead creation still happens, correctly flagged.
    expect(createFlaggedLead).toHaveBeenCalledTimes(1);
    const leadCall = vi.mocked(createFlaggedLead).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(leadCall.data["flagType"]).toBe("outside_service_scope");
    expect(leadCall.data["problem"]).toContain("deposit via bank transfer");

    // The inbound message is still logged.
    expect(calls.leadMessageInserts).toHaveLength(1);
    expect(calls.leadMessageInserts[0]).toMatchObject({
      role: "customer",
      body: expect.stringContaining("deposit via bank transfer"),
    });

    // The owner is still notified.
    expect(sendFollowUpNotificationEmail).toHaveBeenCalledTimes(1);
    const emailArg = vi.mocked(sendFollowUpNotificationEmail).mock.calls[0]![0] as { body: string };
    expect(emailArg.body).toContain("deposit via bank transfer");
  });

  // PRODUCTION REGRESSION (2026-10-27): "Thanks anywaya" previously
  // resolved to Spanish (correctly preserving established context) and the
  // Spanish hand-off text was the only way to observe that. Now that
  // outOfScope sends no reply at all, language is instead verified at the
  // source — getQuoteEstimate's own actual call arguments — which is a
  // more direct check of the same underlying fix than reading sent text
  // ever was.
  it("handleFreshQuote main body: a longer English reply ('Thanks anywaya') after Spanish prior context still resolves Spanish internally, and still sends no reply (outOfScope)", async () => {
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
    vi.mocked(getQuoteEstimate).mockClear();
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

    expect(getQuoteEstimate).toHaveBeenCalledTimes(1);
    const call = vi.mocked(getQuoteEstimate).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data["detectedLanguage"]).toBe("es");
    expect(sent).toHaveLength(0);
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

  // PRODUCTION REGRESSION (2026-10-27): the actual reported incident — a
  // real WhatsApp conversation where the customer wrote a substantial
  // English first message, but this phone had an older lead on file whose
  // problem text was Spanish (openLead?.problem, folded in here as
  // priorContextText), and the reply came back in Spanish anyway. Same
  // handleFreshQuote code path and same fixture shape as the "Thanks
  // anywaya" test above — the only thing that changed is the current
  // message is now substantial and unambiguously English, so it must win.
  it("handleFreshQuote: a substantial English message replies in English despite Spanish prior-lead context (the exact reported incident)", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-joshua-1",
        customer_name: "Joshua",
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
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: true,
    } as any);
    vi.mocked(createFlaggedLead).mockResolvedValue({ id: "new-lead-joshua" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Hi, I'd like to get a quote for a new water heater installation please",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    // PRODUCTION REGRESSION (2026-10-27): language is verified at the
    // source (getQuoteEstimate's actual call arguments) rather than via
    // sent reply text, since outOfScope now sends no reply at all.
    expect(getQuoteEstimate).toHaveBeenCalledTimes(1);
    const call = vi.mocked(getQuoteEstimate).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data["detectedLanguage"]).toBe("en");
    expect(sent).toHaveLength(0);
  });

  // Companion reverse-direction case: established English context must not
  // block an explicit switch to Spanish either.
  it("handleFreshQuote: a substantial Spanish message resolves Spanish internally despite English prior-lead context, and sends no reply (outOfScope)", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-reverse-1",
        customer_name: "Pat",
        photo_url: null,
        problem: "a few different things, broken garbage disposal.",
        confidence: null,
        diagnosis: null,
        flag_type: "needs_human_review",
      },
      leadSlotClaimSucceeds: true,
      outboundInteractionCount: MAX_AUTOMATED_REPLIES_PER_CONVERSATION - 1,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockClear();
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: true,
    } as any);
    vi.mocked(createFlaggedLead).mockResolvedValue({ id: "new-lead-reverse" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Hola, necesito una cotización para instalar un calentador de agua nuevo",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(getQuoteEstimate).toHaveBeenCalledTimes(1);
    const call = vi.mocked(getQuoteEstimate).mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data["detectedLanguage"]).toBe("es");
    expect(sent).toHaveLength(0);
  });
});

// PRODUCTION REGRESSION (2026-10-27), Part 2 — proves the fix at the
// wiring level, not just the observed reply text: the SAME resolved
// language actually reaches getQuoteEstimate's own call arguments (used by
// buildPrompt's languageInstruction), rather than buildPrompt silently
// re-detecting a possibly different answer from a narrower set of inputs.
// Companion to this file's existing "getQuoteEstimate call-argument
// wiring" describe block (exclusions/specialties), same technique: assert
// on the mock's actual call arguments, not its return value.
describe("getQuoteEstimate call-argument wiring — the orchestration layer's resolved language actually reaches buildPrompt", () => {
  beforeEach(() => {
    vi.mocked(getQuoteEstimate).mockClear();
  });

  function getQuoteEstimateCallData(): Record<string, unknown> {
    expect(getQuoteEstimate).toHaveBeenCalledTimes(1);
    const call = vi.mocked(getQuoteEstimate).mock.calls[0]![0] as { data: Record<string, unknown> };
    return call.data;
  }

  it("handleFreshQuote path: detectedLanguage in the call data matches the English reply actually sent", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-wiring-1",
        customer_name: "Joshua",
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
    vi.mocked(getQuoteEstimate).mockResolvedValue({ needsClarification: false, outOfScope: true } as any);
    vi.mocked(createFlaggedLead).mockResolvedValue({ id: "new-lead-wiring-1" } as any);
    const { adapter } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Hi, I'd like to get a quote for a new water heater installation please",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    const data = getQuoteEstimateCallData();
    expect(data["detectedLanguage"]).toBe("en");
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
    // PRODUCTION REGRESSION (2026-10-27): outOfScope sends no reply now.
    expect(sent).toEqual([]);
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

// Phase 2 — "configured exclusions actually control AI behavior," the
// input-wiring half. The excluded_service flag-type tests elsewhere in
// this file (search "excluded_service") prove the OUTPUT branching is
// correct given a getQuoteEstimate result that already has
// excludedServiceLabel set — they never prove the fetched capabilities
// actually reached getQuoteEstimate's own input in the first place. These
// tests close that gap directly: asserting on getQuoteEstimate's real
// call arguments (via vi.mocked(getQuoteEstimate).mock.calls), not its
// return value, at each of the three call sites that reach it.
describe("getQuoteEstimate call-argument wiring — fetched exclusions/specialties actually reach the AI call", () => {
  const EXCLUSION_CAPABILITIES = [
    { id: "cap-1", type: "exclusion", label: "Gas line installation", notes: null, active: true },
    { id: "cap-2", type: "specialty", label: "Tankless water heaters", notes: null, active: true },
  ];

  beforeEach(() => {
    vi.mocked(getQuoteEstimate).mockClear();
  });

  function getQuoteEstimateCallData(): Record<string, unknown> {
    expect(getQuoteEstimate).toHaveBeenCalledTimes(1);
    const call = vi.mocked(getQuoteEstimate).mock.calls[0]![0] as { data: Record<string, unknown> };
    return call.data;
  }

  it("fresh-quote path (handleFreshQuote): configured exclusions and specialties are present in getQuoteEstimate's actual call arguments", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [],
      capabilities: EXCLUSION_CAPABILITIES,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({ needsClarification: false, outOfScope: true } as any);
    vi.mocked(createFlaggedLead).mockResolvedValue({ id: "new-lead-1" } as any);
    const { adapter } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "I need a gas line run to my new stove",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    const data = getQuoteEstimateCallData();
    expect(data["exclusions"]).toEqual([{ label: "Gas line installation" }]);
    expect(data["specialties"]).toEqual([{ label: "Tankless water heaters" }]);
  });

  it("fresh-quote path: a tenant with nothing configured sends empty exclusions/specialties arrays, never undefined or omitted", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: null,
      leadSlotClaimSucceeds: true,
      resumeCandidates: [],
      // capabilities deliberately omitted — the common case for every
      // tenant today (confirmed live: 0 tenant_capabilities rows exist in
      // production as of this feature's rollout).
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({ needsClarification: false, outOfScope: true } as any);
    vi.mocked(createFlaggedLead).mockResolvedValue({ id: "new-lead-2" } as any);
    const { adapter } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "my kitchen faucet is leaking",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    const data = getQuoteEstimateCallData();
    expect(data["exclusions"]).toEqual([]);
    expect(data["specialties"]).toEqual([]);
  });

  it("mid-clarification path (continue_clarification): configured exclusions reach getQuoteEstimate's call arguments", async () => {
    const { admin } = fakeInboundAdmin({
      openLead: {
        id: "lead-clarify-1",
        customer_name: "Pat",
        photo_url: null,
        problem: "install a gas line",
        confidence: null,
        diagnosis: null,
        flag_type: null,
      },
      leadSlotClaimSucceeds: true,
      capabilities: EXCLUSION_CAPABILITIES,
    });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({ needsClarification: false, outOfScope: true } as any);
    const { adapter } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "it's for a new stove hookup",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    const data = getQuoteEstimateCallData();
    expect(data["exclusions"]).toEqual([{ label: "Gas line installation" }]);
    expect(data["specialties"]).toEqual([{ label: "Tankless water heaters" }]);
  });

  it("photo-reassessment path (quoted_follow_up, same_job): configured exclusions reach getQuoteEstimate's call arguments", async () => {
    const quotedLead: FakeOpenLead = {
      id: "lead-photo-reassess-1",
      customer_name: "Riley",
      photo_url: null,
      problem: "Kitchen faucet needs replacing.",
      confidence: "High",
      diagnosis: "Standard kitchen faucet replacement.",
      flag_type: null,
    };
    const { admin } = fakeInboundAdmin({
      openLead: quotedLead,
      leadSlotClaimSucceeds: true,
      existingLineItems: [{ description: "Kitchen faucet replacement", rate: 120, qty: 1 }],
      capabilities: EXCLUSION_CAPABILITIES,
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
      diagnosis: "Corroded shut-off valves found.",
      isDiagnosisOnly: false,
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
      lineItems: [
        { description: "Kitchen faucet replacement", detail: "", amount: 185, priceSheetItemId: "ps-1", hours: undefined },
      ],
      totalLow: 185,
      totalHigh: 185,
    } as any);
    const { adapter } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "here's what it looks like under the sink",
      mediaRef: "media-ref-reassess-1",
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    const data = getQuoteEstimateCallData();
    expect(data["exclusions"]).toEqual([{ label: "Gas line installation" }]);
    expect(data["specialties"]).toEqual([{ label: "Tankless water heaters" }]);
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
        // Also covers attemptConversationResume's extended-window query
        // (.in(...), awaited directly off .limit() with no .maybeSingle())
        // — resolves to zero candidates, same "no open lead" intent as the
        // .maybeSingle() shape below.
        const chain: Record<string, unknown> = {
          eq: () => chain,
          gte: () => chain,
          in: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
            resolve({ data: [], error: null }),
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
        // first-ever conversation from this phone number. Also covers
        // attemptConversationResume's extended-window query (.in(...),
        // awaited directly off .limit()) — zero candidates, same intent.
        const chain: Record<string, unknown> = {
          eq: () => chain,
          gte: () => chain,
          in: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
            resolve({ data: [], error: null }),
        };
        return { select: () => chain };
      }
      if (table === "price_sheet_items") {
        return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
      }
      if (table === "tenant_capabilities") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        };
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
    // Short greeting — the customer already said why they're reaching out,
    // so the open-ended "how can I help you today?" tail is dropped; the
    // priced response follows immediately in the same message.
    expect(sent[0]!.body.startsWith("Hi! 👋 Thanks for reaching out to")).toBe(true);
    expect(sent[0]!.body).not.toContain("How can I help you today?");
    expect(sent[0]!.body).toContain(PRICED_RESULT.diagnosis);
  });

  // PRODUCTION REGRESSION (2026-10-27): JIR only responds within the
  // configured Price Sheet's scope — first-contact outOfScope now sends no
  // reply at all, acknowledgment present or not (the short-vs-full greeting
  // mechanism this test originally verified is still covered by the
  // priced-quote first-contact test above, which still gets a reply).
  it("first contact, outOfScope hand-off: no reply sent, even with an acknowledgment present", async () => {
    const { admin } = fakeFreshQuoteAdmin();
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: false,
      outOfScope: true,
      acknowledgment: "Got it — roof repair.",
    } as any);
    vi.mocked(createFlaggedLead).mockClear();
    vi.mocked(createFlaggedLead).mockResolvedValue({ id: "new-flagged-lead-1" } as any);
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Do you fix roofs? Mine is leaking.",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(createFlaggedLead).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
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

  // PRODUCTION REGRESSION: a real WhatsApp conversation showed a double
  // greeting on a genuinely first-contact message ("Edgar. Buen dia" — the
  // customer addressing the business owner by name, not stating their own)
  // — the recommended greeting, followed immediately by the model's own
  // "Hi Edgar! What can we help you with today?" clarifying question and
  // its options, all concatenated into one message. Root cause: a
  // first-contact needsClarification response had the structural greeting
  // prefix glued directly onto the model's own question text, with nothing
  // stopping the model from adding its own (name-guessing) greeting too.
  // Fix: on first contact, needsClarification now sends ONLY the plain
  // greeting — no question, no options, no lead — exactly mirroring the
  // thin-description short-circuit. The customer's next message is then
  // correctly NOT treated as first contact (evaluateInboundInteraction
  // already recorded this one at the top of the handler), so the real
  // question gets asked then, without re-greeting.
  it("first contact + needsClarification sends ONLY the plain greeting — no question, no options, no lead created", async () => {
    const { admin } = fakeFreshQuoteAdmin({ priorInboundInteraction: false });
    vi.mocked(getAdminClient).mockReturnValue(admin);
    vi.mocked(getQuoteEstimate).mockResolvedValue({
      needsClarification: true,
      questions: [
        {
          question: "Hi Edgar! What can we help you with today?",
          options: [
            "I need a repair or fix",
            "I want to install or replace something",
            "I need maintenance or cleaning",
            "Something else",
          ],
        },
      ],
    } as any);
    vi.mocked(createClarifyingLead).mockClear();
    const { adapter, sent } = fakeAdapter();

    await handleInboundWhatsAppMessage({
      tenant: TEST_TENANT,
      fromPhone: TEST_PHONE,
      body: "Edgar. Buen dia",
      mediaRef: undefined,
      providerMessageId: undefined,
      profileName: undefined,
      channel: "WhatsApp",
      adapter,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.startsWith("Hi! 👋 ")).toBe(true);
    expect(sent[0]!.body).not.toContain("Edgar");
    expect(sent[0]!.body).not.toContain("What can we help you with");
    expect(sent[0]!.body).not.toContain("I need a repair or fix");
    expect(createClarifyingLead).not.toHaveBeenCalled();
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

    // PRODUCTION REGRESSION (2026-10-27): outOfScope now sends no reply at
    // all, which structurally eliminates the greeting-duplication risk this
    // test originally checked for (no message means no greeting to find).
    expect(sent).toHaveLength(0);
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
    // Short greeting again — real content was in the first message.
    expect(sent[0]!.body.startsWith("Hi! 👋 Thanks for reaching out to")).toBe(true);
    expect(sent[0]!.body).not.toContain("How can I help you today?");
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
