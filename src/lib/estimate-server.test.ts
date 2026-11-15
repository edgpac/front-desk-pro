import { describe, expect, it, vi, beforeEach } from "vitest";

// enforceTenantAiLimit is the only export in this file that reaches
// outside its own module (via getAdminClient, imported from
// public-lead-server.ts) — mocked here so its tests control exactly
// what the "database" returns, the same way estimate-server.ts's own
// established pattern elsewhere in this codebase (a fake client passed
// in, never the real Supabase SDK) keeps these tests fast and
// deterministic. Nothing else in this file touches public-lead-server.ts
// at all, so this mock has no effect on any other test below.
vi.mock("@/lib/public-lead-server", () => ({ getAdminClient: vi.fn() }));

import { getAdminClient } from "@/lib/public-lead-server";
import {
  validateSubmittedLineItem,
  validateQuoteAgainstPriceSheet,
  buildPrompt,
  buildClaudeMessageContent,
  buildQuoteResult,
  findMatchingExclusion,
  applyExclusionGuard,
  extractDollarAmounts,
  findUnexpectedAmounts,
  isSupportedImageBase64,
  UNSUPPORTED_IMAGE_MESSAGE,
  IMAGE_TOO_LARGE_MESSAGE,
  MAX_IMAGE_BASE64_CHARS,
  SERVICE_CALL_SENTINEL_ID,
  NO_DESCRIPTION_PLACEHOLDER,
  detectLanguage,
  detectCurrentLanguage,
  enforceTenantAiLimit,
  gateClarification,
  runQuoteAttempts,
  withAuthoritativeCatalog,
  evaluateFollowUpScope,
  checkFollowUpRequest,
  attachScopeTokens,
  signQuoteScope,
  verifyQuoteScope,
  signQuestionsScope,
  verifyQuestionsScope,
  signFollowUpScope,
  outOfScopeFlag,
  CLARIFICATION_SCOPE_RULE,
  PHOTO_ONLY_SCOPE_RULE,
  type PriceSheetItem,
  type QuoteInput,
  type QuoteResult,
} from "./estimate-server";

// Covers the highest-priority gap identified in the 2026-09 security
// audit: createLead/finalizeLeadWithQuote run on the service-role client,
// reachable by an anonymous caller, and previously trusted a submitted
// lineItem's amount with no check against the tenant's real price sheet.
// This is the function that closes that gap (public-lead-server.ts calls
// it for every submitted line item) — these cases are the same ones
// manually verified before that fix was first deployed, now committed as
// a real regression test.

const priceSheet: PriceSheetItem[] = [
  {
    id: "ps-1",
    task: "Quick fix / minor repair",
    category: "General",
    keywords: ["doorknob"],
    pricingType: "flat",
    priceMin: 60,
    priceMax: 60,
    hours: 0,
    bundleable: true,
    materialsPolicy: "included",
    diagnosisFee: null,
    aiNotes: null,
    alwaysRequiresInspection: false,
  },
  {
    id: "ps-2",
    task: "Drain clearing",
    category: "Plumbing",
    keywords: ["clog"],
    pricingType: "range",
    priceMin: 150,
    priceMax: 250,
    hours: 1,
    bundleable: false,
    materialsPolicy: "included",
    diagnosisFee: null,
    aiNotes: null,
    alwaysRequiresInspection: false,
  },
  {
    id: "ps-3",
    task: "AC diagnostic",
    category: "HVAC",
    keywords: ["ac", "not cooling"],
    pricingType: "hourly",
    priceMin: 95,
    priceMax: 95,
    hours: 1,
    bundleable: false,
    materialsPolicy: "included",
    diagnosisFee: null,
    aiNotes: null,
    alwaysRequiresInspection: false,
  },
];

describe("validateSubmittedLineItem", () => {
  it("accepts a valid flat-priced match", () => {
    const failure = validateSubmittedLineItem(
      { description: "Doorknob", priceSheetItemId: "ps-1", amount: 60 },
      priceSheet,
      89,
      "fixed",
    );
    expect(failure).toBeNull();
  });

  it("accepts a valid range-priced match within bounds", () => {
    const failure = validateSubmittedLineItem(
      { description: "Clog", priceSheetItemId: "ps-2", amount: 200 },
      priceSheet,
      89,
      "fixed",
    );
    expect(failure).toBeNull();
  });

  it("accepts a valid hourly-priced match with correct rate x hours", () => {
    const failure = validateSubmittedLineItem(
      { description: "AC check", priceSheetItemId: "ps-3", amount: 190, hours: 2 },
      priceSheet,
      89,
      "fixed",
    );
    expect(failure).toBeNull();
  });

  it("rejects a forged amount on a real flat-priced item", () => {
    const failure = validateSubmittedLineItem(
      { description: "Doorknob", priceSheetItemId: "ps-1", amount: 9999 },
      priceSheet,
      89,
      "fixed",
    );
    expect(failure).not.toBeNull();
  });

  it("rejects an amount outside a real range-priced item's bounds", () => {
    const failure = validateSubmittedLineItem(
      { description: "Clog", priceSheetItemId: "ps-2", amount: 5000 },
      priceSheet,
      89,
      "fixed",
    );
    expect(failure).not.toBeNull();
  });

  it("rejects an hourly item where amount doesn't match rate x hours", () => {
    const failure = validateSubmittedLineItem(
      { description: "AC check", priceSheetItemId: "ps-3", amount: 9999, hours: 2 },
      priceSheet,
      89,
      "fixed",
    );
    expect(failure).not.toBeNull();
  });

  it("rejects an hourly item with no hours value to verify against", () => {
    const failure = validateSubmittedLineItem(
      { description: "AC check", priceSheetItemId: "ps-3", amount: 190 },
      priceSheet,
      89,
      "fixed",
    );
    expect(failure).not.toBeNull();
  });

  it("accepts a valid service-call sentinel matching the configured fee", () => {
    const failure = validateSubmittedLineItem(
      { description: "Service call", priceSheetItemId: SERVICE_CALL_SENTINEL_ID, amount: 89 },
      priceSheet,
      89,
      "fixed",
    );
    expect(failure).toBeNull();
  });

  it("rejects a forged service-call amount", () => {
    const failure = validateSubmittedLineItem(
      { description: "Service call", priceSheetItemId: SERVICE_CALL_SENTINEL_ID, amount: 5 },
      priceSheet,
      89,
      "fixed",
    );
    expect(failure).not.toBeNull();
  });

  it("rejects the service-call sentinel entirely when the tenant's fee is negotiated", () => {
    const failure = validateSubmittedLineItem(
      { description: "Service call", priceSheetItemId: SERVICE_CALL_SENTINEL_ID, amount: 89 },
      priceSheet,
      89,
      "negotiated",
    );
    expect(failure).not.toBeNull();
  });

  it("rejects a line item missing priceSheetItemId entirely", () => {
    const failure = validateSubmittedLineItem(
      { description: "Made up job", amount: 999 },
      priceSheet,
      89,
      "fixed",
    );
    expect(failure).not.toBeNull();
  });

  it("rejects a line item referencing an unknown/invented priceSheetItemId", () => {
    const failure = validateSubmittedLineItem(
      { description: "Made up job", priceSheetItemId: "ps-does-not-exist", amount: 500 },
      priceSheet,
      89,
      "fixed",
    );
    expect(failure).not.toBeNull();
  });

  it("rejects a non-numeric amount", () => {
    const failure = validateSubmittedLineItem(
      { description: "Doorknob", priceSheetItemId: "ps-1", amount: Number.NaN },
      priceSheet,
      89,
      "fixed",
    );
    expect(failure).not.toBeNull();
  });
});

// The full AI-response validator — checks matchedServices/lineItems
// internal consistency (not just individual amounts) on top of the same
// id/amount logic validateSubmittedLineItem covers above. This is what
// getQuoteEstimate runs Claude's own parsed JSON through before it's ever
// returned to a customer or persisted as a lead.
describe("validateQuoteAgainstPriceSheet", () => {
  function base(
    overrides: Partial<{ matchedServices: unknown; lineItems: unknown; diagnosis: unknown }> = {},
  ) {
    return {
      matchedServices: [{ customerIssue: "doorknob", priceSheetItemId: "ps-1" }],
      lineItems: [{ description: "Doorknob", detail: "", amount: 60, priceSheetItemId: "ps-1" }],
      diagnosis: "The doorknob is loose.",
      ...overrides,
    };
  }

  it("accepts a single correctly matched, correctly priced item", () => {
    const failures = validateQuoteAgainstPriceSheet(base(), priceSheet, 89, "fixed");
    expect(failures).toEqual([]);
  });

  it("accepts two customerIssues bundled into one lineItem for the same bundleable item", () => {
    const failures = validateQuoteAgainstPriceSheet(
      base({
        matchedServices: [
          { customerIssue: "doorknob", priceSheetItemId: "ps-1" },
          { customerIssue: "towel bar", priceSheetItemId: "ps-1" },
        ],
        lineItems: [{ description: "Quick fix", detail: "", amount: 60, priceSheetItemId: "ps-1" }],
      }),
      priceSheet,
      89,
      "fixed",
    );
    expect(failures).toEqual([]);
  });

  it("flags a matchedServices entry with no corresponding lineItem", () => {
    const failures = validateQuoteAgainstPriceSheet(
      base({ lineItems: [] }),
      priceSheet,
      89,
      "fixed",
    );
    expect(failures.some((f) => f.includes("no lineItem uses it"))).toBe(true);
  });

  it("flags a lineItem whose id was never in matchedServices", () => {
    const failures = validateQuoteAgainstPriceSheet(
      base({ matchedServices: [] }),
      priceSheet,
      89,
      "fixed",
    );
    expect(failures.some((f) => f.includes("wasn't in matchedServices"))).toBe(true);
  });

  it("flags the same non-bundleable item charged twice", () => {
    const failures = validateQuoteAgainstPriceSheet(
      base({
        matchedServices: [
          { customerIssue: "clog 1", priceSheetItemId: "ps-2" },
          { customerIssue: "clog 2", priceSheetItemId: "ps-2" },
        ],
        lineItems: [
          { description: "Clog 1", detail: "", amount: 200, priceSheetItemId: "ps-2" },
          { description: "Clog 2", detail: "", amount: 200, priceSheetItemId: "ps-2" },
        ],
      }),
      priceSheet,
      89,
      "fixed",
    );
    expect(failures.some((f) => f.includes("can only ever produce one lineItem"))).toBe(true);
  });

  it("flags an unknown/invented priceSheetItemId in lineItems", () => {
    const failures = validateQuoteAgainstPriceSheet(
      base({
        matchedServices: [{ customerIssue: "x", priceSheetItemId: "ps-invented" }],
        lineItems: [{ description: "x", detail: "", amount: 100, priceSheetItemId: "ps-invented" }],
      }),
      priceSheet,
      89,
      "fixed",
    );
    expect(failures.some((f) => f.includes("unknown priceSheetItemId"))).toBe(true);
  });

  it("flags a forged amount on a correctly matched item", () => {
    const failures = validateQuoteAgainstPriceSheet(
      base({
        lineItems: [
          { description: "Doorknob", detail: "", amount: 9999, priceSheetItemId: "ps-1" },
        ],
      }),
      priceSheet,
      89,
      "fixed",
    );
    expect(failures.some((f) => f.includes("doesn't match the configured price"))).toBe(true);
  });

  it("rejects the service-call sentinel as a priced lineItem when the tenant's fee is negotiated", () => {
    const failures = validateQuoteAgainstPriceSheet(
      base({
        matchedServices: [
          { customerIssue: "diagnostic visit", priceSheetItemId: SERVICE_CALL_SENTINEL_ID },
        ],
        lineItems: [
          {
            description: "Service call",
            detail: "",
            amount: 89,
            priceSheetItemId: SERVICE_CALL_SENTINEL_ID,
          },
        ],
      }),
      priceSheet,
      89,
      "negotiated",
    );
    expect(failures.some((f) => f.includes("negotiated"))).toBe(true);
  });

  it("requires credit wording when a service-call charge coexists with real matched work", () => {
    const failures = validateQuoteAgainstPriceSheet(
      base({
        matchedServices: [
          { customerIssue: "diagnostic visit", priceSheetItemId: SERVICE_CALL_SENTINEL_ID },
          { customerIssue: "doorknob", priceSheetItemId: "ps-1" },
        ],
        lineItems: [
          {
            description: "Service call",
            detail: "",
            amount: 89,
            priceSheetItemId: SERVICE_CALL_SENTINEL_ID,
          },
          { description: "Doorknob", detail: "", amount: 60, priceSheetItemId: "ps-1" },
        ],
        diagnosis:
          "Diagnostic visit plus a doorknob fix — no mention of how the fee relates to the repair.",
      }),
      priceSheet,
      89,
      "fixed",
    );
    expect(failures.some((f) => f.includes("toward the approved repair"))).toBe(true);
  });

  it("passes the same service-call + real-work case once the diagnosis states the credit wording", () => {
    const failures = validateQuoteAgainstPriceSheet(
      base({
        matchedServices: [
          { customerIssue: "diagnostic visit", priceSheetItemId: SERVICE_CALL_SENTINEL_ID },
          { customerIssue: "doorknob", priceSheetItemId: "ps-1" },
        ],
        lineItems: [
          {
            description: "Service call",
            detail: "",
            amount: 89,
            priceSheetItemId: SERVICE_CALL_SENTINEL_ID,
          },
          { description: "Doorknob", detail: "", amount: 60, priceSheetItemId: "ps-1" },
        ],
        diagnosis:
          "The service call fee goes toward the approved repair if you proceed with the doorknob fix.",
      }),
      priceSheet,
      89,
      "fixed",
    );
    expect(failures).toEqual([]);
  });

  it("requires materials-policy wording for a customer_pays_receipt item", () => {
    const partsPriceSheet: PriceSheetItem[] = [
      { ...priceSheet[0]!, id: "ps-parts", materialsPolicy: "customer_pays_receipt" },
    ];
    const failures = validateQuoteAgainstPriceSheet(
      base({
        matchedServices: [{ customerIssue: "doorknob", priceSheetItemId: "ps-parts" }],
        lineItems: [
          { description: "Doorknob", detail: "", amount: 60, priceSheetItemId: "ps-parts" },
        ],
        diagnosis: "The doorknob is loose and needs a new part.",
      }),
      partsPriceSheet,
      89,
      "fixed",
    );
    expect(failures.some((f) => f.includes("materials_policy"))).toBe(true);
  });

  // Phase 4A follow-up: a real production incident where the AI quoted a
  // full price for a photo-only estimate on a service the owner had marked
  // "always needs an in-person look, don't estimate from a photo alone" via
  // the old free-text aiNotes field — which carries no code-level
  // enforcement (see PriceSheetItem.alwaysRequiresInspection's own
  // comment). These tests cover the structured, enforced replacement.
  describe("ALWAYS INSPECT (alwaysRequiresInspection)", () => {
    it("accepts a correctly deferred match — no diagnosis fee configured, priceSheetItemId: null, no lineItem", () => {
      const inspectOnlyPriceSheet: PriceSheetItem[] = [
        { ...priceSheet[0]!, id: "ps-paint", alwaysRequiresInspection: true, diagnosisFee: null },
      ];
      const failures = validateQuoteAgainstPriceSheet(
        base({
          matchedServices: [{ customerIssue: "paint touch-up", priceSheetItemId: null }],
          lineItems: [],
          diagnosis: "Paint touch-up — pricing confirmed after an in-person look.",
        }),
        inspectOnlyPriceSheet,
        89,
        "fixed",
      );
      expect(failures).toEqual([]);
    });

    it("flags a full-price lineItem for an ALWAYS INSPECT item with no diagnosis fee configured", () => {
      const inspectOnlyPriceSheet: PriceSheetItem[] = [
        { ...priceSheet[0]!, id: "ps-paint", alwaysRequiresInspection: true, diagnosisFee: null },
      ];
      const failures = validateQuoteAgainstPriceSheet(
        base({
          matchedServices: [{ customerIssue: "paint touch-up", priceSheetItemId: "ps-paint" }],
          lineItems: [
            { description: "Paint touch-up", detail: "", amount: 93, priceSheetItemId: "ps-paint" },
          ],
        }),
        inspectOnlyPriceSheet,
        89,
        "fixed",
      );
      expect(
        failures.some((f) => f.includes("ALWAYS INSPECT") && f.includes("priceSheetItemId: null")),
      ).toBe(true);
    });

    it("accepts the item's own diagnosis-fee id when ALWAYS INSPECT is paired with a configured diagnosis fee", () => {
      const inspectWithFeePriceSheet: PriceSheetItem[] = [
        {
          ...priceSheet[0]!,
          id: "ps-paint",
          alwaysRequiresInspection: true,
          diagnosisFee: { pricingType: "flat", amount: 40 },
        },
      ];
      const failures = validateQuoteAgainstPriceSheet(
        base({
          matchedServices: [
            { customerIssue: "paint touch-up", priceSheetItemId: "ps-paint:diagnosis" },
          ],
          lineItems: [
            {
              description: "Paint touch-up — diagnosis visit",
              detail: "",
              amount: 40,
              priceSheetItemId: "ps-paint:diagnosis",
            },
          ],
        }),
        inspectWithFeePriceSheet,
        89,
        "fixed",
      );
      expect(failures).toEqual([]);
    });

    it("flags the bare (full-price) id even when a diagnosis fee is configured — the :diagnosis id is required instead", () => {
      const inspectWithFeePriceSheet: PriceSheetItem[] = [
        {
          ...priceSheet[0]!,
          id: "ps-paint",
          alwaysRequiresInspection: true,
          diagnosisFee: { pricingType: "flat", amount: 40 },
        },
      ];
      const failures = validateQuoteAgainstPriceSheet(
        base({
          matchedServices: [{ customerIssue: "paint touch-up", priceSheetItemId: "ps-paint" }],
          lineItems: [
            { description: "Paint touch-up", detail: "", amount: 93, priceSheetItemId: "ps-paint" },
          ],
        }),
        inspectWithFeePriceSheet,
        89,
        "fixed",
      );
      expect(
        failures.some((f) => f.includes("ALWAYS INSPECT") && f.includes("ps-paint:diagnosis")),
      ).toBe(true);
    });

    it("an ALWAYS INSPECT violation on one item doesn't block a normal item priced correctly in the same response", () => {
      const mixedPriceSheet: PriceSheetItem[] = [
        priceSheet[0]!, // normal, alwaysRequiresInspection: false
        {
          ...priceSheet[1]!,
          id: "ps-paint",
          alwaysRequiresInspection: true,
          diagnosisFee: null,
          priceMin: 93,
          priceMax: 93,
        },
      ];
      const failures = validateQuoteAgainstPriceSheet(
        base({
          matchedServices: [
            { customerIssue: "doorknob", priceSheetItemId: "ps-1" },
            { customerIssue: "paint touch-up", priceSheetItemId: "ps-paint" },
          ],
          lineItems: [
            { description: "Doorknob", detail: "", amount: 60, priceSheetItemId: "ps-1" },
            { description: "Paint touch-up", detail: "", amount: 93, priceSheetItemId: "ps-paint" },
          ],
        }),
        mixedPriceSheet,
        89,
        "fixed",
      );
      // The normal item is fine; only the ALWAYS INSPECT violation is flagged.
      expect(failures.length).toBe(1);
      expect(failures[0]).toContain("ALWAYS INSPECT");
    });

    it("accepts the dedicated :inspection sentinel id for a no-fee ALWAYS INSPECT item — the preferred, fee-free-signaling form", () => {
      const inspectOnlyPriceSheet: PriceSheetItem[] = [
        { ...priceSheet[0]!, id: "ps-paint", alwaysRequiresInspection: true, diagnosisFee: null },
      ];
      const failures = validateQuoteAgainstPriceSheet(
        base({
          matchedServices: [
            { customerIssue: "paint touch-up", priceSheetItemId: "ps-paint:inspection" },
          ],
          lineItems: [],
          diagnosis: "Got it — paint touch-up.",
        }),
        inspectOnlyPriceSheet,
        89,
        "fixed",
      );
      expect(failures).toEqual([]);
    });

    it("rejects the :inspection sentinel for an item that actually has a diagnosis fee configured — :diagnosis is required instead", () => {
      const inspectWithFeePriceSheet: PriceSheetItem[] = [
        {
          ...priceSheet[0]!,
          id: "ps-paint",
          alwaysRequiresInspection: true,
          diagnosisFee: { pricingType: "flat", amount: 40 },
        },
      ];
      const failures = validateQuoteAgainstPriceSheet(
        base({
          matchedServices: [
            { customerIssue: "paint touch-up", priceSheetItemId: "ps-paint:inspection" },
          ],
          lineItems: [],
        }),
        inspectWithFeePriceSheet,
        89,
        "fixed",
      );
      expect(failures.some((f) => f.includes("unknown priceSheetItemId"))).toBe(true);
    });

    it("flags a lineItem that uses the :inspection sentinel as a priced charge — it must never be priced, only acknowledged", () => {
      const inspectOnlyPriceSheet: PriceSheetItem[] = [
        { ...priceSheet[0]!, id: "ps-paint", alwaysRequiresInspection: true, diagnosisFee: null },
      ];
      const failures = validateQuoteAgainstPriceSheet(
        base({
          matchedServices: [
            { customerIssue: "paint touch-up", priceSheetItemId: "ps-paint:inspection" },
          ],
          lineItems: [
            {
              description: "Paint touch-up",
              detail: "",
              amount: 0,
              priceSheetItemId: "ps-paint:inspection",
            },
          ],
        }),
        inspectOnlyPriceSheet,
        89,
        "fixed",
      );
      expect(failures.some((f) => f.includes(":inspection") && f.includes("must never"))).toBe(
        true,
      );
    });
  });
});

describe("buildQuoteResult — hasFeeFreeDeferralOnly", () => {
  it("is true when every deferred matchedServices entry is an :inspection sentinel and nothing was priced", () => {
    const result = buildQuoteResult(
      {
        diagnosis: "Got it — concrete crack repair and touch-up paint.",
        matchedServices: [
          { customerIssue: "concrete cracks", priceSheetItemId: "ps-concrete:inspection" },
          { customerIssue: "touch-up paint", priceSheetItemId: "ps-paint:inspection" },
        ],
        lineItems: [],
      },
      priceSheet,
    );
    expect(result).toMatchObject({ hasNoPricedWork: true, hasFeeFreeDeferralOnly: true });
  });

  it("is false when even one deferred entry is a bare null — falls back to the safer fee-applies wording", () => {
    const result = buildQuoteResult(
      {
        diagnosis: "Got it.",
        matchedServices: [
          { customerIssue: "concrete cracks", priceSheetItemId: "ps-concrete:inspection" },
          { customerIssue: "something ambiguous", priceSheetItemId: null },
        ],
        lineItems: [],
      },
      priceSheet,
    );
    expect(result).toMatchObject({ hasNoPricedWork: true, hasFeeFreeDeferralOnly: false });
  });

  it("is false for the pre-existing generic negotiated-mode deferral (bare null only) — unaffected by this feature", () => {
    const result = buildQuoteResult(
      {
        diagnosis: "Got it — we'll confirm the fee when we're in touch.",
        matchedServices: [{ customerIssue: "something ambiguous", priceSheetItemId: null }],
        lineItems: [],
      },
      priceSheet,
    );
    expect(result).toMatchObject({ hasNoPricedWork: true, hasFeeFreeDeferralOnly: false });
  });

  it("is false whenever real priced work exists, even alongside an :inspection deferral", () => {
    const result = buildQuoteResult(
      {
        diagnosis: "Doorknob priced; paint touch-up needs a look first.",
        matchedServices: [
          { customerIssue: "doorknob", priceSheetItemId: "ps-1" },
          { customerIssue: "paint touch-up", priceSheetItemId: "ps-paint:inspection" },
        ],
        lineItems: [{ description: "Doorknob", detail: "", amount: 60, priceSheetItemId: "ps-1" }],
      },
      priceSheet,
    );
    expect(result).toMatchObject({ hasNoPricedWork: false, hasFeeFreeDeferralOnly: false });
  });

  it("is false when matchedServices is empty (degenerate case) even though lineItems is also empty", () => {
    const result = buildQuoteResult(
      { diagnosis: "Not sure this is something we do.", matchedServices: [], lineItems: [] },
      priceSheet,
    );
    expect(result).toMatchObject({ hasNoPricedWork: true, hasFeeFreeDeferralOnly: false });
  });
});

describe("buildPrompt", () => {
  function baseInput(overrides: Partial<QuoteInput> = {}): QuoteInput {
    return {
      businessName: "Cabos Handyman",
      laborRate: 60,
      serviceCallFee: 89,
      serviceCallFeeMode: "fixed",
      priceSheet,
      description: "My doorknob is loose.",
      ...overrides,
    };
  }

  it("includes the tenant's business name and customer description", () => {
    const prompt = buildPrompt(baseInput());
    expect(prompt).toContain("Cabos Handyman");
    expect(prompt).toContain("My doorknob is loose.");
  });

  it("includes every price-sheet item's id and task so Claude can reference them", () => {
    const prompt = buildPrompt(baseInput());
    for (const item of priceSheet) {
      expect(prompt).toContain(item.id);
      expect(prompt).toContain(item.task);
    }
  });

  it("states the real service-call fee amount in fixed mode", () => {
    const prompt = buildPrompt(baseInput({ serviceCallFee: 89, serviceCallFeeMode: "fixed" }));
    expect(prompt).toContain("89");
  });

  it("instructs the model to never state a service-call dollar figure in negotiated mode", () => {
    const prompt = buildPrompt(baseInput({ serviceCallFee: 89, serviceCallFeeMode: "negotiated" }));
    // The raw number can still appear (as a "don't use this" example in the
    // instruction itself) — what actually matters is that the model is
    // explicitly told never to quote one, which validateQuoteAgainstPriceSheet
    // then enforces server-side regardless of what the prompt says.
    expect(prompt).toContain("never state or invent a dollar figure");
  });

  it("does not warn against stating a service-call amount in fixed mode", () => {
    const prompt = buildPrompt(baseInput({ serviceCallFee: 89, serviceCallFeeMode: "fixed" }));
    expect(prompt.includes("never state or invent a dollar figure")).toBe(false);
  });

  it("includes prior clarification answers when provided", () => {
    const prompt = buildPrompt(
      baseInput({ answers: [{ question: "Is there a photo?", answer: "No photo available" }] }),
    );
    expect(prompt).toContain("Is there a photo?");
    expect(prompt).toContain("No photo available");
  });

  // Priority 3 of the 2026-10-19 photo-intelligence investigation: the
  // confidence field used to be defined ONLY as "confidence in reading the
  // photo" — incoherent, and risked implying a visual read that never
  // happened, whenever no photo was ever sent. Fixed to be evidence-general.
  it("never defines confidence solely as 'reading the photo' — the old, photo-only wording is gone", () => {
    expect(buildPrompt(baseInput())).not.toContain("confidence in reading the photo");
    expect(buildPrompt(baseInput({ imageBase64: "x" }))).not.toContain(
      "confidence in reading the photo",
    );
  });

  it("instructs the model never to imply it saw a photo it never received", () => {
    const prompt = buildPrompt(baseInput()); // no imageBase64 at all
    expect(prompt).toContain("never phrase or imply confidence as if you saw one");
  });

  it("instructs the model that a clear text description can fully support High confidence with no photo", () => {
    const prompt = buildPrompt(baseInput());
    expect(prompt).toContain("can still fully support High confidence on its own");
  });

  it("instructs the model that a missing photo is never by itself a reason to lower confidence", () => {
    const prompt = buildPrompt(baseInput());
    expect(prompt).toContain("a missing photo is never by itself a reason to lower confidence");
  });

  // Phase 2, P1.2 — the bundling/multi-line-item worked example used to be
  // anchored to a doorknob/towel-bar/toilet-unclogging price sheet, sent to
  // every tenant regardless of industry. Confirms the lesson (same-item
  // matches collapse to one line; different-item matches stay separate,
  // both fully priced) survives in abstract, industry-neutral form.
  it("the bundling worked example is industry-neutral — no repair-specific task names, same matchedServices/lineItems lesson preserved", () => {
    // A clean, non-repair price sheet — the module-level `priceSheet`
    // fixture above legitimately contains "doorknob" as a keyword of its
    // OWN (unrelated to the worked example), so this test uses its own
    // override to isolate exactly what the worked-example text itself
    // contains, independent of fixture data.
    const cleanPriceSheet: PriceSheetItem[] = [
      {
        id: "ps-clean-1",
        task: "Consultation",
        category: "General",
        keywords: ["consultation"],
        pricingType: "flat",
        priceMin: 50,
        priceMax: 50,
        hours: 0,
        bundleable: false,
        materialsPolicy: "included",
        diagnosisFee: null,
        aiNotes: null,
        alwaysRequiresInspection: false,
      },
    ];
    const prompt = buildPrompt(
      baseInput({ priceSheet: cleanPriceSheet, description: "I'd like to book a consultation." }),
    );
    expect(prompt).not.toContain("doorknob");
    expect(prompt).not.toContain("towel bar");
    expect(prompt).not.toContain("unclogging");
    expect(prompt).toContain("Service A");
    expect(prompt).toContain("Service B");
    expect(prompt).toContain("BUNDLEABLE");
    expect(prompt).toContain("so ONE line item");
    expect(prompt).toContain("so TWO line items");
  });

  // PRODUCTION REGRESSION: a real WhatsApp conversation showed the model's
  // own clarifying question opening with "Hi Edgar!" — guessed from the
  // customer addressing the business owner by name in their message, then
  // echoed back as if it were the customer's own name — immediately after
  // the business's own structural greeting, producing a visible double
  // greeting. Fixed with an explicit instruction, not just the orchestration
  // fix (whatsapp-conversation-server.ts) that stops sending a question at
  // all on first contact — defense in depth, since this same question-
  // composition rule also governs every later clarification round, where
  // the orchestration fix doesn't apply.
  it("instructs the model never to open a clarifying question with a greeting or a guessed customer name", () => {
    const prompt = buildPrompt(baseInput());
    expect(prompt).toContain(
      "Never open the question with a greeting or salutation of any kind",
    );
    expect(prompt).toContain("Never address the customer by name or invent one");
  });

  // Phase 2, P1.1 — the no-photo/first-round clarifying-question instruction
  // used to hardcode "a photo is almost always the single most useful thing
  // you're missing" regardless of what kind of business this is. Replaced
  // with an instruction to reason from the price sheet (the same mechanism
  // this prompt already uses for isEmergency and every other business-type
  // inference), so a salon/consultant/photographer tenant isn't defaulted
  // into a photo-first request that doesn't fit their kind of work.
  it("the no-photo, first-round instruction reasons from the price sheet instead of assuming a photo is always most useful", () => {
    const prompt = buildPrompt(baseInput()); // no imageBase64, no answers: !hasPhoto && isFirstRound
    expect(prompt).not.toContain(
      "a photo is almost always the single most useful thing you're missing",
    );
    expect(prompt).toContain(
      "Reason about whether a photo would genuinely help you price or assess the specific kind of work this business does",
    );
  });

  it("the no-photo, first-round instruction appears only when there's no photo and it's the first round — absent once a photo exists or a round has already happened", () => {
    const marker =
      "Reason about whether a photo would genuinely help you price or assess the specific kind of work this business does";
    expect(buildPrompt(baseInput())).toContain(marker); // !hasPhoto && isFirstRound
    expect(buildPrompt(baseInput({ imageBase64: "x" }))).not.toContain(marker); // hasPhoto
    expect(
      buildPrompt(baseInput({ answers: [{ question: "Is there a photo?", answer: "No" }] })),
    ).not.toContain(marker); // !isFirstRound
  });

  it("the no-photo-repeat-round instruction (already asked once, still no photo) remains byte-for-byte unchanged", () => {
    const prompt = buildPrompt(
      baseInput({ answers: [{ question: "Is there a photo?", answer: "No" }] }),
    );
    expect(prompt).toContain(
      "No photo has been provided, and the customer has already been asked about this — do NOT ask for a photo again under any circumstance, even if you still don't have one. Proceed using the description and answers already given; if a genuinely different, price-changing detail remains, ask about that instead, otherwise price the job now.",
    );
  });

  it("the photo-without-description instruction remains byte-for-byte unchanged", () => {
    const prompt = buildPrompt(
      baseInput({ imageBase64: "x", description: NO_DESCRIPTION_PLACEHOLDER }),
    );
    expect(prompt).toContain(
      "No description was provided — a photo alone rarely tells you everything (what's actually needed, relevant history, what the customer wants done), so make your first clarifying question an open-ended request for the customer to describe what they need in their own words, rather than guessing from the image alone or asking a narrower multiple-choice question first. Phrase it naturally for whatever this business actually does — not every photo represents something broken (a repair job, a grooming request, an installation) — don't assume 'problem' framing where it doesn't fit.",
    );
  });

  // PRODUCTION REGRESSION (2026-10-27), Part 2 — the orchestration layer
  // (whatsapp-conversation-server.ts) and buildPrompt used to detect
  // language independently, from different inputs, and could disagree
  // within the same turn. QuoteInput.detectedLanguage lets a caller that's
  // already resolved the language (factoring in conversation context
  // buildPrompt has no visibility into) hand that decision to buildPrompt
  // directly, instead of it re-deriving a possibly different answer.
  describe("QuoteInput.detectedLanguage — keeping orchestration and buildPrompt consistent", () => {
    it("an explicitly provided detectedLanguage is used even when it disagrees with the description's own language", () => {
      // English description, but the caller has already resolved Spanish
      // from conversation context buildPrompt can't see — buildPrompt must
      // defer to it, not re-detect English from the description alone.
      const prompt = buildPrompt(
        baseInput({ description: "Can you fix this?", detectedLanguage: "es" }),
      );
      expect(prompt).toContain("IMPORTANT: The customer is writing in Spanish.");
    });

    it("an explicit English detectedLanguage suppresses the language instruction even with a Spanish-looking description", () => {
      const prompt = buildPrompt(
        baseInput({ description: "Necesito ayuda con mi fuga.", detectedLanguage: "en" }),
      );
      expect(prompt).not.toContain("IMPORTANT: The customer is writing in");
    });

    it("falls back to self-contained detection (description + answers) when detectedLanguage is omitted — unchanged behavior for /demo and the public quote page/widget", () => {
      const prompt = buildPrompt(baseInput({ description: "Necesito ayuda con mi fuga." }));
      expect(prompt).toContain("IMPORTANT: The customer is writing in Spanish.");
    });
  });

  // PRODUCTION REGRESSION (2026-10-27): JIR is a Price-Sheet-only assistant,
  // not a general-purpose one — a real conversation showed a payment/
  // deposit-confirmation message get treated as if it might be a service
  // request (at risk of being matched to the service call fee via the
  // "don't leave an ambiguous-but-plausible problem as a null match"
  // guidance, which has no carve-out for a message that was never
  // attempting to describe a service at all). Fixed with a new RULE 0,
  // checked before RULE 1, plus a narrowing clause on both service-call-fee
  // variants (fixed and negotiated mode) scoping that guidance to messages
  // that ARE genuinely describing a service need.
  describe("RULE 0 — payment/administrative messages are never a service description", () => {
    const RULE_0_MARKER =
      "payment, a deposit, an invoice, a receipt, a bank transfer, or asking whether something was sent/received is never a service description";

    // 1. A price-sheet-listed service, regression — RULE 0 must not
    // interfere with ordinary, genuine service matching.
    it("a listed service still matches normally — RULE 0 present but inert for a real service description", () => {
      const prompt = buildPrompt(baseInput({ description: "My doorknob is loose." }));
      expect(prompt).toContain(RULE_0_MARKER);
      expect(prompt).toContain("ps-1");
      expect(prompt).toContain("Quick fix / minor repair");
    });

    // 2. A listed service with a configured price, regression.
    it("a listed service's configured price still appears correctly", () => {
      const prompt = buildPrompt(baseInput({ description: "My drain is clogged." }));
      expect(prompt).toContain("ps-2");
      expect(prompt).toContain("$150-$250");
    });

    // 3. A service inquiry for something absent from the price sheet,
    // regression — RULE 1's own outOfScope framing must remain intact,
    // byte-for-byte, alongside the new RULE 0.
    it("RULE 1's existing non-match outOfScope instruction remains byte-for-byte unchanged", () => {
      const prompt = buildPrompt(baseInput());
      expect(prompt).toContain(
        'check whether what\'s being described is already clearly unrelated to everything on the price sheet (a genuinely different kind of job this business doesn\'t do at all, not just one you need more detail about). If so, skip clarification entirely and respond with {"needsClarification": false, "outOfScope": true, "acknowledgment": "..."} immediately',
      );
    });

    // 4. The exact reported scenario: a deposit/payment confirmation.
    it("a deposit-confirmation message: RULE 0 explicitly covers it, and the service-call-fee guidance is scoped away from it", () => {
      const prompt = buildPrompt(
        baseInput({
          description: "Hi, I sent the deposit via bank transfer yesterday, can you confirm you received it?",
        }),
      );
      expect(prompt).toContain(RULE_0_MARKER);
      expect(prompt).toContain(
        'Never match it to the service call fee, a per-service diagnosis fee, or any price-sheet item "just in case it\'s plausible"',
      );
      expect(prompt).toContain(
        "This ambiguity-resolution guidance applies only when the customer IS genuinely describing some physical problem or service need",
      );
    });

    // 5. A follow-up asking the owner to verify a payment — RULE 0 is not
    // conditioned on first-round vs. follow-up; it must apply identically
    // on a later round (answers populated).
    it("a follow-up payment-verification message gets the same RULE 0 coverage on a later round", () => {
      const prompt = buildPrompt(
        baseInput({
          description: "I need some work done.",
          answers: [
            { question: "What do you need help with?", answer: "Can you confirm you got my payment?" },
          ],
        }),
      );
      expect(prompt).toContain(RULE_0_MARKER);
    });

    // 6. Two separate administrative messages, each its own turn — RULE 0
    // must apply consistently and independently to each, not just the
    // first.
    it("RULE 0 applies consistently to two independent administrative messages, each its own prompt", () => {
      const firstPrompt = buildPrompt(
        baseInput({ description: "Did you receive the deposit I sent?" }),
      );
      const secondPrompt = buildPrompt(
        baseInput({ description: "Just checking in — did you see my message about the payment?" }),
      );
      expect(firstPrompt).toContain(RULE_0_MARKER);
      expect(secondPrompt).toContain(RULE_0_MARKER);
    });

    // 7. A genuinely ambiguous but real service request must still trigger
    // normal clarification — confirms RULE 0 doesn't over-correct into
    // suppressing legitimate clarifying questions.
    it("a genuinely ambiguous service request still gets the normal clarifying-question treatment, unaffected by RULE 0", () => {
      const prompt = buildPrompt(baseInput({ description: "My AC isn't working right." }));
      expect(prompt).toContain(
        "respond with 1-2 short clarifying questions instead of guessing",
      );
      expect(prompt).toContain("ps-3");
    });

    // 8. Conversation history/answers containing unrelated administrative
    // content must not expand scope or contaminate matching for the
    // actual, separate service request under discussion.
    it("an unrelated administrative mention inside prior answers does not alter the price-sheet section or suppress RULE 0", () => {
      const prompt = buildPrompt(
        baseInput({
          description: "My drain is clogged.",
          answers: [
            { question: "Anything else?", answer: "Also, did you get the deposit I sent last week?" },
          ],
        }),
      );
      expect(prompt).toContain(RULE_0_MARKER);
      // The price sheet itself is passed through unfiltered/unaltered —
      // both real items are still present, uncontaminated by the
      // unrelated answer text.
      expect(prompt).toContain("ps-1");
      expect(prompt).toContain("ps-2");
      expect(prompt).toContain("ps-3");
    });

    // 9. Tenant isolation — already structurally guaranteed (buildPrompt
    // takes input fresh per call, no shared/global state); this confirms
    // it, rather than introducing any new mechanism.
    it("tenant isolation: one tenant's price sheet and business name never appear in another tenant's prompt", () => {
      const tenantAPrompt = buildPrompt(
        baseInput({
          businessName: "Tenant A Plumbing",
          priceSheet: [
            {
              id: "tenant-a-item",
              task: "Tenant A exclusive service",
              category: "General",
              keywords: ["tenant a"],
              pricingType: "flat",
              priceMin: 99,
              priceMax: 99,
              hours: 1,
              bundleable: false,
              materialsPolicy: "included",
              diagnosisFee: null,
              aiNotes: null,
              alwaysRequiresInspection: false,
            },
          ],
          description: "Did you receive my deposit?",
        }),
      );
      const tenantBPrompt = buildPrompt(
        baseInput({
          businessName: "Tenant B Salon",
          priceSheet: [
            {
              id: "tenant-b-item",
              task: "Tenant B exclusive service",
              category: "General",
              keywords: ["tenant b"],
              pricingType: "flat",
              priceMin: 55,
              priceMax: 55,
              hours: 1,
              bundleable: false,
              materialsPolicy: "included",
              diagnosisFee: null,
              aiNotes: null,
              alwaysRequiresInspection: false,
            },
          ],
          description: "Did you receive my deposit?",
        }),
      );

      expect(tenantAPrompt).toContain("Tenant A exclusive service");
      expect(tenantAPrompt).not.toContain("Tenant B exclusive service");
      expect(tenantAPrompt).not.toContain("Tenant B Salon");

      expect(tenantBPrompt).toContain("Tenant B exclusive service");
      expect(tenantBPrompt).not.toContain("Tenant A exclusive service");
      expect(tenantBPrompt).not.toContain("Tenant A Plumbing");

      // Both still get RULE 0 identically — scope boundary is generic,
      // never tenant-specific.
      expect(tenantAPrompt).toContain(RULE_0_MARKER);
      expect(tenantBPrompt).toContain(RULE_0_MARKER);
    });
  });
});

// PRODUCTION REGRESSION (2026-10-27): a real WhatsApp conversation showed a
// Spanish greeting sent in reply to a substantial English first message —
// root cause traced to detectLanguage's plain "combine everything and
// test," which has no precedence between a customer's current message and
// older/stale context. detectCurrentLanguage is the fix: see its own
// extensive comment in estimate-server.ts for the full reasoning,
// including two real test cases below that a cruder, character-length-only
// first draft of this function got wrong.
describe("detectCurrentLanguage", () => {
  it("a substantial current English message wins over Spanish prior context (the exact reported bug)", () => {
    expect(
      detectCurrentLanguage(
        "Hi, I'd like to get a quote for a new water heater installation please",
        "Necesito ayuda con una fuga en el baño.",
      ),
    ).toBe("en");
  });

  it("a substantial current Spanish message wins over English prior context (explicit switch, reverse direction)", () => {
    expect(
      detectCurrentLanguage(
        "Hola, necesito ayuda con una fuga en el baño por favor",
        "I need a quote for a new water heater.",
      ),
    ).toBe("es");
  });

  it("a short, low-signal current message ('Ok') preserves established Spanish context", () => {
    expect(detectCurrentLanguage("Ok", "Necesito ayuda con una fuga en el baño.")).toBe("es");
  });

  it("a short, low-signal current message ('Fixed') preserves established English context", () => {
    expect(detectCurrentLanguage("Fixed", "I have a leak under the sink.")).toBe("en");
  });

  // The exact real production regression test this fix was built against:
  // "Thanks anywaya" is 14 characters (would pass a pure character-length
  // threshold) but only two throwaway words carrying no real content —
  // established Spanish context must still win.
  it("'Thanks anywaya' (14 characters, two words) does not override established Spanish context", () => {
    expect(
      detectCurrentLanguage("Thanks anywaya", "varias cosas. triturador de basura roto."),
    ).toBe("es");
  });

  it("a short Spanish message that itself contains a recognized keyword still wins immediately, regardless of word count", () => {
    expect(detectCurrentLanguage("No gracias", "I need a quote.")).toBe("es");
  });

  it("a short Spanish reply relying only on an accented vowel (no keyword match) still wins immediately", () => {
    // Real production regression input — "así" carries no keyword-pattern
    // match, only an accented vowel.
    expect(detectCurrentLanguage("así", "I need a quote.")).toBe("es");
  });

  it("boundary: exactly at the word-count threshold (2 words) is NOT substantial — falls back to prior context", () => {
    expect(detectCurrentLanguage("ok then", "Necesito ayuda.")).toBe("es");
  });

  it("boundary: one word over the threshold (3 words) IS substantial — current message wins", () => {
    expect(detectCurrentLanguage("ok then thanks", "Necesito ayuda.")).toBe("en");
  });

  it("an undefined current message falls through entirely to prior context", () => {
    expect(detectCurrentLanguage(undefined, "Necesito ayuda con mi fuga.")).toBe("es");
  });

  it("no current message and no prior context defaults to English, same as detectLanguage", () => {
    expect(detectCurrentLanguage(undefined)).toBe("en");
  });

  it("with no prior context at all, a substantial current message is still judged correctly on its own", () => {
    expect(detectCurrentLanguage("I need a quote for a new water heater installation")).toBe("en");
  });
});

// Confirms the new Spanish accented-vowel pattern (added to close the gap
// detectCurrentLanguage's own tests above surfaced) doesn't regress
// detectLanguage's existing combine-everything behavior for callers that
// were never touched by this fix — getFollowUpAnswer (question + diagnosis
// + full conversation history, spread last) and buildSuggestedReply
// (problem + diagnosis) both call detectLanguage directly, unchanged.
describe("detectLanguage — unchanged direct callers (getFollowUpAnswer-shaped, reply-composer-shaped inputs)", () => {
  it("getFollowUpAnswer-shaped call: question + diagnosis + full history array, Spanish signal anywhere still detected", () => {
    expect(
      detectLanguage(
        "What should I tell them?",
        "Standard repair.",
        "Customer: Necesito ayuda.",
        "You: Sure, one moment.",
      ),
    ).toBe("es");
  });

  it("getFollowUpAnswer-shaped call: all-English inputs still resolve English", () => {
    expect(
      detectLanguage(
        "What should I tell them?",
        "Standard repair.",
        "Customer: I need help with this.",
        "You: Sure, one moment.",
      ),
    ).toBe("en");
  });

  it("reply-composer-shaped call (problem + diagnosis): Spanish problem still detected even with an English-looking diagnosis", () => {
    expect(detectLanguage("Tengo una fuga de agua.", "Standard shut-off valve repair.")).toBe("es");
  });

  it("the new accented-vowel pattern does not fire on plain English text", () => {
    expect(detectLanguage("I have a leak under the kitchen sink, can you help?")).toBe("en");
  });
});

// PRODUCTION REGRESSION (2026-11-15): an English-speaking customer opened
// with "Hola. Buenas Dias." and closed with "Muchas gracias." around a
// fully English plumbing-emergency message, and got the greeting plus the
// follow-up question in Spanish. A Spanish courtesy phrase on its own is
// politeness, not the customer's language.
describe("detectLanguage — Spanish courtesy phrases inside English messages", () => {
  const REPORTED_MESSAGE =
    "Hola. Buenas Dias. Sorry to message you early on a Sunday morning but we have a plumbing emergency. " +
    "Our plumbing in the kitchen sink and dishwasher is very backed up and it’s leaking from under our " +
    "dishwasher now. We need our plumbing lines completely cleaned out and possibly more done if that " +
    "doesn’t fix the dishwasher situation. Are you able to help??? Muchas gracias.";

  it("the exact reported message resolves English", () => {
    expect(detectLanguage(REPORTED_MESSAGE)).toBe("en");
    expect(detectCurrentLanguage(REPORTED_MESSAGE)).toBe("en");
  });

  it("an English message opened with a short Spanish greeting resolves English", () => {
    expect(detectLanguage("Hola, my sink is leaking")).toBe("en");
    expect(detectLanguage("Buenos días! Can you fix a ceiling fan this week? Gracias")).toBe("en");
  });

  it("a greeting with nothing else stays Spanish", () => {
    expect(detectLanguage("Hola")).toBe("es");
    expect(detectLanguage("Hola, buenas tardes")).toBe("es");
    expect(detectLanguage("Muchas gracias")).toBe("es");
  });

  it("a real Spanish message that starts with a greeting stays Spanish", () => {
    expect(detectLanguage("Hola, necesito ayuda con una fuga en el baño")).toBe("es");
    expect(detectLanguage("Buenos días, tengo un problema con el boiler")).toBe("es");
  });
});

// Photo-intelligence investigation (2026-10-19): the user asked whether the
// AI actually "sees" a photo or merely gets told one was attached. Traced
// end to end: getQuoteEstimate's handler builds this exact content array
// and passes it straight into callClaude, which JSON.stringifies the body
// with zero filtering before POSTing to the Anthropic Messages API — so
// buildClaudeMessageContent's output IS the real request shape, not a
// proxy for it. These tests prove the image reaches the request in the
// format Anthropic's Messages API requires for a vision input.
describe("buildClaudeMessageContent — proving the image actually reaches the model", () => {
  function baseInput(overrides: Partial<QuoteInput> = {}): QuoteInput {
    return {
      businessName: "Cabos Handyman",
      laborRate: 60,
      serviceCallFee: 89,
      serviceCallFeeMode: "fixed",
      priceSheet,
      description: "My kitchen faucet needs replacing.",
      ...overrides,
    };
  }

  const FAKE_JPEG_BASE64 = "/9j/4AAQSkZJRgABAQAAAQABAAD"; // decodes to FF D8 FF ...

  it("includes a real Anthropic vision content block when a photo is attached — not just a text mention", () => {
    const content = buildClaudeMessageContent(
      baseInput({ imageBase64: FAKE_JPEG_BASE64, imageMediaType: "image/jpeg" }),
    );
    const imageBlock = content.find((c) => c["type"] === "image") as
      { type: string; source: { type: string; media_type: string; data: string } } | undefined;
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.source).toEqual({
      type: "base64",
      media_type: "image/jpeg",
      data: FAKE_JPEG_BASE64,
    });
  });

  it("places the image block before the text block — Anthropic's own recommended ordering", () => {
    const content = buildClaudeMessageContent(
      baseInput({ imageBase64: FAKE_JPEG_BASE64, imageMediaType: "image/jpeg" }),
    );
    expect(content[0]?.["type"]).toBe("image");
    expect(content[1]?.["type"]).toBe("text");
  });

  it("defaults media_type to image/jpeg when the caller didn't specify one", () => {
    const content = buildClaudeMessageContent(baseInput({ imageBase64: FAKE_JPEG_BASE64 }));
    const imageBlock = content.find((c) => c["type"] === "image") as {
      source: { media_type: string };
    };
    expect(imageBlock.source.media_type).toBe("image/jpeg");
  });

  it("sends only the text block, with no image content at all, when no photo was attached", () => {
    const content = buildClaudeMessageContent(baseInput());
    expect(content).toHaveLength(1);
    expect(content[0]?.["type"]).toBe("text");
    expect(content.some((c) => c["type"] === "image")).toBe(false);
  });

  it("the text block itself still describes the customer's request (sanity check the two aren't swapped)", () => {
    const content = buildClaudeMessageContent(
      baseInput({ imageBase64: FAKE_JPEG_BASE64, imageMediaType: "image/jpeg" }),
    );
    const textBlock = content.find((c) => c["type"] === "text") as { text: string };
    expect(textBlock.text).toContain("My kitchen faucet needs replacing.");
  });
});

// The magic-byte validation gate that runs BEFORE buildClaudeMessageContent
// is ever called (getQuoteEstimate's handler: `if (data.imageBase64 &&
// !isSupportedImageBase64(...)) throw ...`) — proving these cases reject
// correctly closes the loop: an unsupported/invalid image can never reach
// buildClaudeMessageContent, so it can never reach the model either.
describe("isSupportedImageBase64 — the gate that must pass before any photo reaches the model", () => {
  it("accepts a real JPEG signature (FF D8 FF)", () => {
    expect(isSupportedImageBase64("/9j/4AAQSkZJRgABAQAAAQABAAD")).toBe(true);
  });

  it("accepts a real PNG signature (89 50 4E 47 0D 0A 1A 0A)", () => {
    expect(isSupportedImageBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB")).toBe(true);
  });

  it("rejects a HEIC file even if mislabeled as image/jpeg — checks magic bytes, never the caller-supplied mediaType", () => {
    // HEIC's real signature ("....ftypheic") base64-encoded — the function
    // never even looks at imageMediaType, so a HEIC file claiming to be a
    // JPEG is still rejected on its actual bytes.
    const heicBase64 = Buffer.from("....ftypheic", "latin1").toString("base64");
    expect(isSupportedImageBase64(heicBase64)).toBe(false);
  });

  it("rejects garbage/non-image data", () => {
    expect(isSupportedImageBase64("not-valid-base64-image-data")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isSupportedImageBase64("")).toBe(false);
  });
});

describe("MAX_IMAGE_BASE64_CHARS — the size ceiling applied before any photo reaches the model", () => {
  it("is set to a real, positive bound (regression guard against an accidental 0/undefined)", () => {
    expect(MAX_IMAGE_BASE64_CHARS).toBeGreaterThan(1_000_000);
  });

  it("exposes a customer-facing message for the format gate", () => {
    expect(UNSUPPORTED_IMAGE_MESSAGE.length).toBeGreaterThan(0);
  });

  it("exposes a customer-facing message for the size gate", () => {
    expect(IMAGE_TOO_LARGE_MESSAGE.length).toBeGreaterThan(0);
  });
});

// Audit finding, 2026-10-10: getFollowUpAnswer's reply was entirely free
// text with no server-side check against the real quote amounts — unlike
// validateQuoteAgainstPriceSheet's rigorous enforcement for the quote
// itself. These two functions close that gap; covers the extraction regex
// and the real/unexpected-amount comparison independently of the AI call.
describe("extractDollarAmounts", () => {
  it("extracts a single whole-dollar amount", () => {
    expect(extractDollarAmounts("That'll be $120 total.")).toEqual([120]);
  });

  it("extracts multiple amounts in one string", () => {
    expect(extractDollarAmounts("The faucet is $120 and the service call is $60.")).toEqual([
      120, 60,
    ]);
  });

  it("extracts amounts with cents", () => {
    expect(extractDollarAmounts("Total comes to $45.50.")).toEqual([45.5]);
  });

  it("extracts amounts with thousands separators", () => {
    expect(extractDollarAmounts("That job runs about $1,250.")).toEqual([1250]);
  });

  it("returns an empty array when no dollar figure is mentioned", () => {
    expect(extractDollarAmounts("The business will confirm that with you directly.")).toEqual([]);
  });
});

describe("findUnexpectedAmounts", () => {
  it("returns nothing when every mentioned amount is allowed", () => {
    expect(
      findUnexpectedAmounts("The faucet is $120 and the total is $180.", [120, 60, 180]),
    ).toEqual([]);
  });

  it("flags a dollar figure that doesn't match any real amount", () => {
    expect(findUnexpectedAmounts("That'll run about $95.", [120, 60, 180])).toEqual([95]);
  });

  it("flags every mention when nothing is priced yet (hasNoPricedWork)", () => {
    expect(findUnexpectedAmounts("It's usually around $150 for that.", [])).toEqual([150]);
  });

  it("allows an amount within floating-point tolerance of a real one", () => {
    expect(findUnexpectedAmounts("Total: $180.00", [179.995])).toEqual([]);
  });

  it("returns nothing when the answer states no dollar figure at all", () => {
    expect(
      findUnexpectedAmounts("The business will confirm the price when they're in touch.", [120]),
    ).toEqual([]);
  });
});

// Phase 2 — "configured exclusions actually control AI behavior." These
// cover the deterministic, server-side mechanism (never the AI's own
// compliance) that prevents excluded work from receiving an automatic
// quote even when a matching price-sheet item exists.
describe("findMatchingExclusion — deterministic keyword-overlap matching, no AI involved", () => {
  it("matches when the exclusion's own words appear directly in the search text", () => {
    expect(
      findMatchingExclusion(["I need a gas line run to my new stove"], [{ label: "Gas line installation" }]),
    ).toBe("Gas line installation");
  });

  it("matches a simple word-form variation (install vs installation, roof vs roofs) via lenient prefix matching", () => {
    expect(
      findMatchingExclusion(
        ["I need my roof fixed, it's a two story house"],
        [{ label: "Roofs over 2 stories" }],
      ),
    ).toBe("Roofs over 2 stories");
  });

  it("does NOT match on a single shared common word alone — majority-of-tokens avoids this false positive", () => {
    expect(findMatchingExclusion(["my truck needs repair"], [{ label: "Deck repair" }])).toBeNull();
  });

  it("returns null when nothing is configured", () => {
    expect(findMatchingExclusion(["anything at all"], [])).toBeNull();
  });

  it("returns null when none of the exclusion's words appear anywhere", () => {
    expect(
      findMatchingExclusion(["I'd like a haircut and a beard trim"], [{ label: "Gas line installation" }]),
    ).toBeNull();
  });

  it("a single-token exclusion matches on that one token's presence", () => {
    expect(findMatchingExclusion(["is there asbestos in this ceiling"], [{ label: "Asbestos" }])).toBe(
      "Asbestos",
    );
  });

  it("checks every configured exclusion, not just the first", () => {
    expect(
      findMatchingExclusion(
        ["I need a gas line installed"],
        [{ label: "Roofs over 2 stories" }, { label: "Gas line installation" }],
      ),
    ).toBe("Gas line installation");
  });
});

describe("applyExclusionGuard — overrides a priced result when it matches a configured exclusion", () => {
  const exclusionPriceSheet: PriceSheetItem[] = [
    {
      id: "ps-gas",
      task: "Gas line installation",
      category: "Gas",
      keywords: ["gas line", "gas pipe"],
      pricingType: "flat",
      priceMin: 400,
      priceMax: 400,
      hours: 0,
      bundleable: false,
      materialsPolicy: "included",
      diagnosisFee: null,
      aiNotes: null,
      alwaysRequiresInspection: false,
    },
    {
      id: "ps-faucet",
      task: "Faucet replacement",
      category: "Plumbing",
      keywords: ["faucet", "tap"],
      pricingType: "flat",
      priceMin: 180,
      priceMax: 180,
      hours: 0,
      bundleable: false,
      materialsPolicy: "included",
      diagnosisFee: null,
      aiNotes: null,
      alwaysRequiresInspection: false,
    },
  ];
  const excludedInput = (description: string, lineItemId: string, amount: number): QuoteInput => ({
    businessName: "Test Co",
    laborRate: 60,
    serviceCallFee: 89,
    serviceCallFeeMode: "fixed",
    priceSheet: exclusionPriceSheet,
    exclusions: [{ label: "Gas line installation" }],
    description,
  });
  const pricedResult = (lineItemId: string, amount: number): QuoteResult =>
    buildQuoteResult(
      {
        diagnosis: "Will install the gas line as requested.",
        lineItems: [{ description: "Gas line installation", detail: "", amount, priceSheetItemId: lineItemId }],
        matchedServices: [{ customerIssue: "gas line", priceSheetItemId: lineItemId }],
      },
      exclusionPriceSheet,
    );

  it("overrides a priced result into an outOfScope hand-off when it matches a configured exclusion — the core safety guarantee", () => {
    const input = excludedInput("I need a gas line run to my new stove", "ps-gas", 400);
    const result = applyExclusionGuard(pricedResult("ps-gas", 400), input);
    expect(result).toEqual({
      needsClarification: false,
      outOfScope: true,
      excludedServiceLabel: "Gas line installation",
    });
  });

  it("an ALLOWED service with the exact same exclusions configured still prices normally — exclusions are specific, not a blanket block", () => {
    const allowedResult = buildQuoteResult(
      {
        diagnosis: "Will replace the kitchen faucet.",
        lineItems: [{ description: "Faucet replacement", detail: "", amount: 180, priceSheetItemId: "ps-faucet" }],
        matchedServices: [{ customerIssue: "faucet", priceSheetItemId: "ps-faucet" }],
      },
      exclusionPriceSheet,
    );
    const input: QuoteInput = {
      businessName: "Test Co",
      laborRate: 60,
      serviceCallFee: 89,
      serviceCallFeeMode: "fixed",
      priceSheet: exclusionPriceSheet,
      exclusions: [{ label: "Gas line installation" }],
      description: "My kitchen faucet is leaking",
    };
    const result = applyExclusionGuard(allowedResult, input);
    expect(result).toEqual(allowedResult);
    expect(result.needsClarification).toBe(false);
  });

  it("never touches a needsClarification result, regardless of configured exclusions", () => {
    const clarifying: QuoteResult = { needsClarification: true, questions: [{ question: "Which room?", options: [] }] };
    const input = excludedInput("gas line somewhere", "ps-gas", 400);
    expect(applyExclusionGuard(clarifying, input)).toEqual(clarifying);
  });

  it("never adds excludedServiceLabel to a genuine AI-decided outOfScope result (nothing matched at all)", () => {
    const genuineOutOfScope: QuoteResult = { needsClarification: false, outOfScope: true, acknowledgment: "Got it." };
    const input = excludedInput("something unrelated", "ps-gas", 400);
    expect(applyExclusionGuard(genuineOutOfScope, input)).toEqual(genuineOutOfScope);
    expect("excludedServiceLabel" in applyExclusionGuard(genuineOutOfScope, input)).toBe(false);
  });

  it("a tenant with zero configured exclusions is completely unaffected — every priced result passes through unchanged", () => {
    const priced = pricedResult("ps-gas", 400);
    const input: QuoteInput = {
      businessName: "Test Co",
      laborRate: 60,
      serviceCallFee: 89,
      serviceCallFeeMode: "fixed",
      priceSheet: exclusionPriceSheet,
      description: "I need a gas line run",
      // exclusions deliberately omitted — the common case for every
      // existing tenant today.
    };
    expect(applyExclusionGuard(priced, input)).toEqual(priced);
  });
});

// Stage 1C of the 2026-11-06 security audit's remediation: the three AI
// classifier functions (classifyFollowUpIntent, classifyBroadServiceInquiry,
// classifyFollowUpPhotoIntent) previously relied only on the in-memory,
// per-instance withinRateLimit() counter, which doesn't hold across
// Vercel's concurrent serverless instances. These tests cover the durable,
// per-tenant fix (enforceTenantAiLimit's new "classifier" bucket,
// migration 0038) directly — the three classifiers themselves are
// createServerFn-wrapped and can't be invoked outside TanStack Start's
// runtime in this test environment (the same established limitation as
// getQuoteEstimate itself), so this tests the shared enforcement function
// every one of them now calls, with a fake admin client standing in for
// Supabase.
describe("enforceTenantAiLimit — durable per-tenant AI rate limit", () => {
  function fakeAdmin(opts: {
    tenantId?: string;
    rpcImpl: (args: any) => { data: number | null; error: Error | null };
  }) {
    const rpc = vi.fn((_name: string, args: any) => Promise.resolve(opts.rpcImpl(args)));
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve(
                opts.tenantId
                  ? { data: { id: opts.tenantId }, error: null }
                  : { data: null, error: new Error("not found") },
              ),
          }),
        }),
      }),
      rpc,
    };
  }

  beforeEach(() => {
    vi.mocked(getAdminClient).mockReset();
  });

  it("allows a request under the quote ceiling (300/day) and passes kind through to the RPC", async () => {
    const admin = fakeAdmin({ tenantId: "t1", rpcImpl: () => ({ data: 1, error: null }) });
    vi.mocked(getAdminClient).mockReturnValue(admin as any);
    await expect(enforceTenantAiLimit("acme", "quote")).resolves.toBeUndefined();
    expect(admin.rpc).toHaveBeenCalledWith(
      "increment_tenant_ai_usage",
      expect.objectContaining({ p_tenant_id: "t1", p_kind: "quote" }),
    );
  });

  it("throws once the quote ceiling (300) is exceeded", async () => {
    vi.mocked(getAdminClient).mockReturnValue(
      fakeAdmin({ tenantId: "t1", rpcImpl: () => ({ data: 301, error: null }) }) as any,
    );
    await expect(enforceTenantAiLimit("acme", "quote")).rejects.toThrow(
      "This business is getting an unusually high volume of requests right now",
    );
  });

  it("classifier kind uses its own, higher ceiling (1000) — 301 requests does NOT throw for 'classifier', unlike 'quote'", async () => {
    vi.mocked(getAdminClient).mockReturnValue(
      fakeAdmin({ tenantId: "t1", rpcImpl: () => ({ data: 301, error: null }) }) as any,
    );
    await expect(enforceTenantAiLimit("acme", "classifier")).resolves.toBeUndefined();
  });

  it("throws once the classifier ceiling (1000) is exceeded", async () => {
    vi.mocked(getAdminClient).mockReturnValue(
      fakeAdmin({ tenantId: "t1", rpcImpl: () => ({ data: 1001, error: null }) }) as any,
    );
    await expect(enforceTenantAiLimit("acme", "classifier")).rejects.toThrow(
      "This business is getting an unusually high volume of requests right now",
    );
  });

  it("defaults to 'quote' when no kind is passed — the existing getQuoteEstimate/getFollowUpAnswer call sites don't need to change", async () => {
    const admin = fakeAdmin({ tenantId: "t1", rpcImpl: () => ({ data: 1, error: null }) });
    vi.mocked(getAdminClient).mockReturnValue(admin as any);
    await enforceTenantAiLimit("acme");
    expect(admin.rpc).toHaveBeenCalledWith(
      "increment_tenant_ai_usage",
      expect.objectContaining({ p_kind: "quote" }),
    );
  });

  it("fails closed on a database error, never silently allowing unlimited spend", async () => {
    vi.mocked(getAdminClient).mockReturnValue(
      fakeAdmin({
        tenantId: "t1",
        rpcImpl: () => ({ data: null, error: new Error("connection reset") }),
      }) as any,
    );
    await expect(enforceTenantAiLimit("acme", "classifier")).rejects.toThrow(
      "This business is getting an unusually high volume of requests right now",
    );
  });

  it("does nothing when the tenant slug doesn't resolve to a real tenant", async () => {
    const rpc = vi.fn();
    vi.mocked(getAdminClient).mockReturnValue(
      fakeAdmin({ rpcImpl: () => ({ data: 1, error: null }) }) as any,
    );
    await expect(enforceTenantAiLimit("nonexistent-slug", "classifier")).resolves.toBeUndefined();
  });

  it("concurrent requests: each one sees the atomically-incremented count, and the one that crosses the ceiling throws — not an earlier or later one", async () => {
    // Simulates what the real increment_tenant_ai_usage RPC's atomic
    // "on conflict ... do update set count = count + 1" guarantees in
    // Postgres (proven separately against a real local instance this
    // session) — a shared counter that increments exactly once per
    // call, even when calls arrive concurrently, never losing or
    // duplicating an increment.
    let sharedCount = 998; // two requests under the 1000 classifier ceiling
    const admin = fakeAdmin({
      tenantId: "t1",
      rpcImpl: () => ({ data: ++sharedCount, error: null }),
    });
    vi.mocked(getAdminClient).mockReturnValue(admin as any);

    const results = await Promise.allSettled([
      enforceTenantAiLimit("acme", "classifier"), // -> 999, allowed
      enforceTenantAiLimit("acme", "classifier"), // -> 1000, allowed (boundary)
      enforceTenantAiLimit("acme", "classifier"), // -> 1001, rejected
    ]);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === "fulfilled").length).toBe(2);
    expect(statuses.filter((s) => s === "rejected").length).toBe(1);
    expect(admin.rpc).toHaveBeenCalledTimes(3);
  });
});

// PRODUCTION REGRESSION (2026-11-09): a handyman tenant received a photo of
// a car engine on WhatsApp and the AI replied "What do you need help with
// regarding this engine? (Engine won't start or is running poorly / ...)" —
// an automotive diagnostic question for a business that doesn't do
// automotive work. Root cause: a needsClarification response was returned
// to every caller with no application-side scope check at all (price-sheet
// validation and applyExclusionGuard only ever ran on priced results). These
// tests pin the fix: a clarification question only reaches a customer when
// it cites real, eligible items from THIS tenant's own price sheet and
// matches none of its configured exclusions — the AI's own scope verdict and
// cited ids are inputs to check, never proof.
describe("gateClarification — price-sheet-first scope check for clarification questions", () => {
  const handymanSheet = priceSheet; // ps-1 quick fix, ps-2 drain clearing, ps-3 AC diagnostic

  const sheetRow = (
    overrides: Partial<PriceSheetItem> & Pick<PriceSheetItem, "id" | "task" | "category">,
  ): PriceSheetItem => ({
    keywords: [],
    pricingType: "flat",
    priceMin: 100,
    priceMax: 100,
    hours: 1,
    bundleable: false,
    materialsPolicy: "included",
    diagnosisFee: null,
    aiNotes: null,
    alwaysRequiresInspection: false,
    ...overrides,
  });
  const paintingSheet = [
    sheetRow({
      id: "pt-1",
      task: "Interior room painting",
      category: "Painting",
      keywords: ["paint", "walls"],
    }),
  ];
  const applianceSheet = [
    sheetRow({
      id: "ap-1",
      task: "Washing machine repair",
      category: "Appliances",
      keywords: ["washer", "washing machine"],
    }),
  ];
  const customQuoteRow = sheetRow({
    id: "cq-1",
    task: "Custom cabinetry",
    category: "Carpentry",
    pricingType: "flat",
    priceMin: 0,
    priceMax: 0,
    alwaysRequiresInspection: true,
  });

  const input = (overrides: Partial<QuoteInput> = {}): QuoteInput => ({
    businessName: "Test Business",
    laborRate: 60,
    serviceCallFee: 89,
    serviceCallFeeMode: "fixed",
    priceSheet: handymanSheet,
    description: NO_DESCRIPTION_PLACEHOLDER,
    imageBase64: "x",
    ...overrides,
  });
  const question = { question: "What do you need done?", options: ["Repair", "Something else"] };
  // The exact shape the model produced in production: no scope verdict, no
  // cited ids — just an industry-specific question.
  const productionEngineResponse = {
    needsClarification: true,
    questions: [
      {
        question: "What do you need help with regarding this engine?",
        options: [
          "Engine won't start or is running poorly",
          "Routine maintenance or inspection",
          "Specific repair or replacement needed",
          "Something else",
        ],
      },
    ],
  };

  it("handyman + car engine photo: the exact production response (no verdict, no cited ids) is rejected", () => {
    const gate = gateClarification(productionEngineResponse, input());
    expect(gate.ok).toBe(false);
  });

  it("handyman + car engine photo: an explicit out_of_scope verdict fails closed with no retry", () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "out_of_scope",
        candidatePriceSheetItemIds: [],
        questions: [question],
      },
      input(),
    );
    expect(gate).toMatchObject({ ok: false, retryable: false });
  });

  it("handyman + car engine photo: an 'in_scope' claim citing a fabricated automotive id fails closed", () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["auto-engine-repair"],
        questions: [question],
      },
      input(),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.ownerReason).toContain("auto-engine-repair");
  });

  it("a fabricated id alongside a real one still fails — every cited id must exist on this tenant's sheet", () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["ps-1", "made-up"],
        questions: [question],
      },
      input(),
    );
    expect(gate.ok).toBe(false);
  });

  it("an id from a DIFFERENT tenant's sheet is not eligible here", () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["ap-1"],
        questions: [question],
      },
      input({ priceSheet: paintingSheet }),
    );
    expect(gate.ok).toBe(false);
  });

  it("painting business + appliance photo: an 'unclear' verdict fails closed with no retry", () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "unclear",
        candidatePriceSheetItemIds: [],
        questions: [question],
      },
      input({ priceSheet: paintingSheet }),
    );
    expect(gate).toMatchObject({ ok: false, retryable: false });
  });

  it("appliance repair business + captioned washing machine photo: a question citing its real washer row is released", () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["ap-1"],
        questions: [
          { question: "What's the washer doing?", options: ["Won't drain", "Won't spin", "Other"] },
        ],
      },
      input({ priceSheet: applianceSheet, description: "My washer is broken" }),
    );
    expect(gate).toEqual({
      ok: true,
      questions: [
        { question: "What's the washer doing?", options: ["Won't drain", "Won't spin", "Other"] },
      ],
    });
  });

  it("explicitly excluded service: fails closed with the exclusion's own label, even when the model cites a real row", () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["ps-1"],
        questions: [question],
      },
      input({
        description: "My roof is leaking, can you do roof repair?",
        exclusions: [{ label: "Roof repair" }],
      }),
    );
    expect(gate).toMatchObject({
      ok: false,
      retryable: false,
      excludedServiceLabel: "Roof repair",
    });
  });

  it("an excluded service named only inside the model's own question/options also fails closed", () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["ps-1"],
        questions: [{ question: "Is this for roof repair?", options: ["Yes", "No"] }],
      },
      input({ exclusions: [{ label: "Roof repair" }] }),
    );
    expect(gate).toMatchObject({ ok: false, excludedServiceLabel: "Roof repair" });
  });

  it("ALWAYS INSPECT custom-quote row with no fixed price stays eligible — by plain id or its ':inspection' id", () => {
    const sheet = [...handymanSheet, customQuoteRow];
    for (const id of ["cq-1", "cq-1:inspection"]) {
      const gate = gateClarification(
        {
          needsClarification: true,
          scopeVerdict: "in_scope",
          candidatePriceSheetItemIds: [id],
          questions: [question],
        },
        input({ priceSheet: sheet, description: "Can you build custom kitchen cabinets?" }),
      );
      expect(gate.ok).toBe(true);
    }
  });

  it("a row's ':diagnosis' id resolves to that row and is eligible", () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["ps-3:diagnosis"],
        questions: [question],
      },
      input({ description: "AC not cooling" }),
    );
    expect(gate.ok).toBe(true);
  });

  it("the generic service-call fee is not a service — citing only it fails", () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: [SERVICE_CALL_SENTINEL_ID],
        questions: [question],
      },
      input(),
    );
    expect(gate.ok).toBe(false);
  });

  it("ambiguous photo with no cited items fails, even with an in_scope claim", () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: [],
        questions: [question],
      },
      input(),
    );
    expect(gate.ok).toBe(false);
  });

  it("empty price sheet: nothing is eligible, fails closed with no retry even when the model claims a match", () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["ps-1"],
        questions: [question],
      },
      input({ priceSheet: [] }),
    );
    expect(gate).toMatchObject({ ok: false, retryable: false });
  });

  it("a missing verdict is a format failure the model may correct once (retryable)", () => {
    const gate = gateClarification(
      { needsClarification: true, candidatePriceSheetItemIds: ["ps-1"], questions: [question] },
      input(),
    );
    expect(gate).toMatchObject({ ok: false, retryable: true });
  });

  it("no usable question text fails, and malformed option entries are dropped from a released question", () => {
    expect(
      gateClarification(
        {
          needsClarification: true,
          scopeVerdict: "in_scope",
          candidatePriceSheetItemIds: ["ps-2"],
          questions: [{ question: "  " }],
        },
        input(),
      ).ok,
    ).toBe(false);
    expect(
      gateClarification(
        {
          needsClarification: true,
          scopeVerdict: "in_scope",
          candidatePriceSheetItemIds: ["ps-2"],
          questions: [{ question: "Which drain?", options: ["Kitchen", 42, null, "Bathroom"] }],
        },
        input({ description: "clogged drain" }),
      ),
    ).toEqual({
      ok: true,
      questions: [{ question: "Which drain?", options: ["Kitchen", "Bathroom"] }],
    });
  });
});

describe("runQuoteAttempts — every clarification, first attempt or corrective retry, passes the same gate", () => {
  const input = (overrides: Partial<QuoteInput> = {}): QuoteInput => ({
    businessName: "Test Business",
    laborRate: 60,
    serviceCallFee: 89,
    serviceCallFeeMode: "fixed",
    priceSheet,
    description: NO_DESCRIPTION_PLACEHOLDER,
    imageBase64: "x",
    ...overrides,
  });
  const scripted = (responses: Array<Record<string, unknown>>) => {
    let call = 0;
    return vi.fn(async () => {
      const parsed = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return { raw: JSON.stringify(parsed), parsed };
    });
  };
  const engineQuestion = {
    needsClarification: true,
    questions: [
      {
        question: "What do you need help with regarding this engine?",
        options: ["Engine won't start", "Something else"],
      },
    ],
  };

  it("engine photo: the production response, repeated on the corrective retry, ends as an outOfScope hand-off — never a question", async () => {
    const ask = scripted([engineQuestion, engineQuestion]);
    const result = await runQuoteAttempts(input(), [], ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result.needsClarification).toBe(false);
    expect(result).toMatchObject({ outOfScope: true });
    if (!result.needsClarification && result.outOfScope)
      expect(result.scopeGateReason).toBeTruthy();
  });

  it("a corrective retry that comes back compliant is released — and only after passing the same checks", async () => {
    const ask = scripted([
      { ...engineQuestion },
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["ps-2"],
        questions: [{ question: "Which drain is clogged?", options: ["Kitchen", "Bathroom"] }],
      },
    ]);
    const result = await runQuoteAttempts(input({ description: "clogged drain" }), [], ask);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      needsClarification: true,
      questions: [{ question: "Which drain is clogged?", options: ["Kitchen", "Bathroom"] }],
    });
  });

  it("a fabricated id on both attempts fails closed", async () => {
    const fabricated = {
      needsClarification: true,
      scopeVerdict: "in_scope",
      candidatePriceSheetItemIds: ["auto-1"],
      questions: [{ question: "Q?", options: [] }],
    };
    const result = await runQuoteAttempts(input(), [], scripted([fabricated, fabricated]));
    expect(result).toMatchObject({ needsClarification: false, outOfScope: true });
  });

  it("an explicit out_of_scope verdict fails closed immediately — no retry that could talk the model into a match", async () => {
    const ask = scripted([
      {
        needsClarification: true,
        scopeVerdict: "out_of_scope",
        candidatePriceSheetItemIds: [],
        questions: [{ question: "Q?", options: [] }],
      },
    ]);
    const result = await runQuoteAttempts(input(), [], ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ needsClarification: false, outOfScope: true });
  });

  it("excluded service fails closed immediately and carries the exclusion label for the owner's flag", async () => {
    const ask = scripted([
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["ps-1"],
        questions: [{ question: "Which part of the roof?", options: [] }],
      },
    ]);
    const result = await runQuoteAttempts(
      input({ description: "need roof repair", exclusions: [{ label: "Roof repair" }] }),
      [],
      ask,
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      needsClarification: false,
      outOfScope: true,
      excludedServiceLabel: "Roof repair",
    });
  });

  it("a legitimate in-scope question passes on the first attempt with no extra model call", async () => {
    const ask = scripted([
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["ps-3"],
        questions: [{ question: "Is it blowing warm air?", options: ["Yes", "No"] }],
      },
    ]);
    const result = await runQuoteAttempts(input({ description: "AC not cooling" }), [], ask);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.needsClarification).toBe(true);
  });

  it("the one-round clarification cap is unchanged: a second round of questions after answers still throws", async () => {
    const question = {
      needsClarification: true,
      scopeVerdict: "in_scope",
      candidatePriceSheetItemIds: ["ps-3"],
      questions: [{ question: "Q?", options: [] }],
    };
    await expect(
      runQuoteAttempts(
        input({ description: "AC not cooling", answers: [{ question: "Q?", answer: "Yes" }] }),
        [],
        scripted([question, question]),
      ),
    ).rejects.toThrow();
  });
});

describe("outOfScopeFlag — one place every caller derives the owner's flag from", () => {
  it("excluded service → excluded_service, with the exclusion label", () => {
    expect(outOfScopeFlag({ excludedServiceLabel: "Roof repair" }, "fix my roof")).toEqual({
      flagType: "excluded_service",
      flagReason: 'Matches a configured exclusion: "Roof repair" — fix my roof',
    });
  });
  it("scope-gate failure → outside_service_scope, with the gate's own reason", () => {
    expect(
      outOfScopeFlag(
        { scopeGateReason: "Couldn't match this to a price-sheet service" },
        "engine photo",
      ),
    ).toEqual({
      flagType: "outside_service_scope",
      flagReason: "Couldn't match this to a price-sheet service — engine photo",
    });
  });
  it("plain model outOfScope keeps today's exact wording", () => {
    expect(outOfScopeFlag({}, "paint a mural")).toEqual({
      flagType: "outside_service_scope",
      flagReason: "Nothing on the price sheet covers: paint a mural",
    });
  });
});

describe("buildPrompt — clarification scope rules (advisory; gateClarification is the enforcement)", () => {
  const input = (overrides: Partial<QuoteInput> = {}): QuoteInput => ({
    businessName: "Test Business",
    laborRate: 60,
    serviceCallFee: 89,
    serviceCallFeeMode: "fixed",
    priceSheet,
    description: "My doorknob is loose.",
    ...overrides,
  });

  it("always tells the model a question must cite specific price-sheet ids, and documents the fields in the JSON shape", () => {
    const prompt = buildPrompt(input());
    expect(prompt).toContain(CLARIFICATION_SCOPE_RULE);
    expect(prompt).toContain('"scopeVerdict": "in_scope", "candidatePriceSheetItemIds"');
  });

  it("a photo-only request gets the 'photo is context, not evidence' rule ahead of the open-ended-question instruction", () => {
    const prompt = buildPrompt(
      input({ imageBase64: "x", description: NO_DESCRIPTION_PLACEHOLDER }),
    );
    const scopeAt = prompt.indexOf(PHOTO_ONLY_SCOPE_RULE);
    expect(scopeAt).toBeGreaterThan(-1);
    expect(scopeAt).toBeLessThan(prompt.indexOf("No description was provided"));
  });

  it("the photo-only rule is not added when the customer also wrote a description", () => {
    expect(buildPrompt(input({ imageBase64: "x" }))).not.toContain(PHOTO_ONLY_SCOPE_RULE);
  });
});

// Adversarial-review corrections (2026-11-09): V1/V2 (service-call-only,
// deferred, and retry results escaped the scope gate), V3/V4 (a real but
// irrelevant item passed; exclusions missed photos), V5 (web price sheet
// came from the browser). Eligibility now applies to EVERY result shape and
// relevance is established only from the customer's own words.
describe("price-sheet eligibility + customer-word relevance — every result shape", () => {
  const row = (
    o: Partial<PriceSheetItem> & Pick<PriceSheetItem, "id" | "task" | "category">,
  ): PriceSheetItem => ({
    keywords: [],
    pricingType: "flat",
    priceMin: 60,
    priceMax: 60,
    hours: 1,
    bundleable: false,
    materialsPolicy: "included",
    diagnosisFee: null,
    aiNotes: null,
    alwaysRequiresInspection: false,
    ...o,
  });
  const quickFix = row({
    id: "qf",
    task: "Quick fix / minor repair",
    category: "General",
    keywords: ["doorknob"],
  });
  const faucet = row({
    id: "fc",
    task: "Faucet replacement",
    category: "Plumbing",
    keywords: ["faucet", "llave", "grifo"],
  });
  const washer = row({
    id: "wm",
    task: "Washing machine repair",
    category: "Appliances",
    keywords: ["washer", "lavadora"],
  });
  const inspectOnly = row({
    id: "ai",
    task: "Water heater replacement",
    category: "Plumbing",
    keywords: ["water heater", "boiler"],
    priceMin: 0,
    priceMax: 0,
    alwaysRequiresInspection: true,
  });
  const withDiagnosis = row({
    id: "ac",
    task: "AC repair",
    category: "HVAC",
    keywords: ["air conditioner", "cooling"],
    diagnosisFee: { pricingType: "flat", amount: 75 },
  });
  const sheet = [quickFix, faucet, washer, inspectOnly, withDiagnosis];

  const input = (o: Partial<QuoteInput> = {}): QuoteInput => ({
    businessName: "Test Business",
    laborRate: 60,
    serviceCallFee: 89,
    serviceCallFeeMode: "fixed",
    priceSheet: sheet,
    description: NO_DESCRIPTION_PLACEHOLDER,
    imageBase64: "x",
    ...o,
  });
  const scripted = (responses: Array<Record<string, unknown>>) => {
    let call = 0;
    return vi.fn(async () => {
      const parsed = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return { raw: JSON.stringify(parsed), parsed };
    });
  };
  const priced = (o: Record<string, unknown>) => ({
    needsClarification: false,
    outOfScope: false,
    isEmergency: false,
    issueType: "x",
    severity: "Low",
    confidence: "Medium",
    diagnosis: "Engine needs an inspection.",
    ...o,
  });
  const serviceCallOnly = priced({
    matchedServices: [{ customerIssue: "engine", priceSheetItemId: "service_call" }],
    lineItems: [
      { description: "Service call", detail: "", amount: 89, priceSheetItemId: "service_call" },
    ],
  });
  const qfFor = (issue: string) =>
    priced({
      matchedServices: [{ customerIssue: issue, priceSheetItemId: "qf" }],
      lineItems: [
        { description: "Quick fix / minor repair", detail: "", amount: 60, priceSheetItemId: "qf" },
      ],
    });
  const faucetPriced = priced({
    matchedServices: [{ customerIssue: "faucet", priceSheetItemId: "fc" }],
    lineItems: [
      { description: "Faucet replacement", detail: "", amount: 60, priceSheetItemId: "fc" },
    ],
  });

  it("V1: fixed-fee engine photo priced at the generic service-call fee alone fails closed", async () => {
    const result = await runQuoteAttempts(
      input({ description: "my car engine won't start" }),
      [],
      scripted([serviceCallOnly]),
    );
    expect(result).toMatchObject({ needsClarification: false, outOfScope: true });
  });

  it("V1: negotiated-mode engine 'deferred' result (null match, nothing priced) fails closed", async () => {
    const deferred = priced({
      matchedServices: [{ customerIssue: "engine", priceSheetItemId: null }],
      lineItems: [],
    });
    const result = await runQuoteAttempts(
      input({ serviceCallFeeMode: "negotiated", description: "my car engine won't start" }),
      [],
      scripted([deferred, deferred]),
    );
    expect(result).toMatchObject({ needsClarification: false, outOfScope: true });
  });

  it("V1: a null-matched (unidentified) issue alongside real priced work still fails closed", async () => {
    const mixed = priced({
      matchedServices: [
        { customerIssue: "faucet", priceSheetItemId: "fc" },
        { customerIssue: "car engine", priceSheetItemId: null },
      ],
      lineItems: [
        { description: "Faucet replacement", detail: "", amount: 60, priceSheetItemId: "fc" },
      ],
    });
    const result = await runQuoteAttempts(
      input({ description: "replace my faucet and look at my car engine" }),
      [],
      scripted([mixed, mixed]),
    );
    expect(result).toMatchObject({ outOfScope: true });
  });

  it("V1: an empty price sheet fails closed even for a service-call-only result", async () => {
    const result = await runQuoteAttempts(
      input({ priceSheet: [], description: "my car engine won't start" }),
      [],
      scripted([serviceCallOnly]),
    );
    expect(result).toMatchObject({ outOfScope: true });
  });

  it("V2: the retry cannot escape — ungated question, then a service-call quote on retry, still fails closed", async () => {
    const ask = scripted([
      {
        needsClarification: true,
        questions: [{ question: "What's wrong with the engine?", options: [] }],
      },
      serviceCallOnly,
    ]);
    const result = await runQuoteAttempts(
      input({ description: "my car engine won't start" }),
      [],
      ask,
    );
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ outOfScope: true });
  });

  it("V3: a real but irrelevant generic item fails — 'fix'/'repair' are not evidence the request is about that item", async () => {
    const result = await runQuoteAttempts(
      input({ description: "can you fix my car engine? it needs repair" }),
      [],
      scripted([qfFor("car engine"), qfFor("car engine")]),
    );
    expect(result).toMatchObject({ outOfScope: true });
  });

  it("V3: the same generic item IS released when the customer's own words match it", async () => {
    const result = await runQuoteAttempts(
      input({ description: "my doorknob is loose" }),
      [],
      scripted([qfFor("loose doorknob")]),
    );
    expect(result).toMatchObject({ needsClarification: false, outOfScope: false });
  });

  it("V3: AI text never establishes relevance — a diagnosis/question that names the item doesn't count", async () => {
    const r1 = await runQuoteAttempts(
      input({ description: "my car engine is making noise" }),
      [],
      scripted([{ ...qfFor("doorknob"), diagnosis: "Loose doorknob needs tightening." }]),
    );
    expect(r1).toMatchObject({ outOfScope: true });
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["qf"],
        questions: [{ question: "Is the doorknob loose?", options: ["Yes", "No"] }],
      },
      input({ description: "my car engine is making noise" }),
    );
    expect(gate.ok).toBe(false);
  });

  it("V3: a captionless photo has no customer words — fails closed for questions and priced results alike", async () => {
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["wm"],
        questions: [{ question: "What's the washer doing?", options: [] }],
      },
      input(),
    );
    expect(gate).toMatchObject({ ok: false, retryable: false });
    const washerPriced = priced({
      matchedServices: [{ customerIssue: "washer", priceSheetItemId: "wm" }],
      lineItems: [
        { description: "Washing machine repair", detail: "", amount: 60, priceSheetItemId: "wm" },
      ],
    });
    const ask = scripted([washerPriced]);
    expect(await runQuoteAttempts(input(), [], ask)).toMatchObject({ outOfScope: true });
    expect(ask).toHaveBeenCalledTimes(1); // no customer words a retry could find — fails closed immediately
  });

  it("V3: a first attempt citing the wrong item may be corrected once, and the retry passes the same deterministic check", async () => {
    const ask = scripted([qfFor("faucet"), faucetPriced]);
    const result = await runQuoteAttempts(
      input({ description: "my kitchen faucet drips" }),
      [],
      ask,
    );
    expect(ask).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ outOfScope: false });
  });

  it("Spanish customer words match a tenant's own Spanish keywords, accents folded", async () => {
    const lavadora = priced({
      matchedServices: [{ customerIssue: "lavadora", priceSheetItemId: "wm" }],
      lineItems: [
        { description: "Washing machine repair", detail: "", amount: 60, priceSheetItemId: "wm" },
      ],
    });
    expect(
      await runQuoteAttempts(
        input({ description: "Mi lavadora no centrifuga, necesito reparación" }),
        [],
        scripted([lavadora]),
      ),
    ).toMatchObject({ outOfScope: false });
  });

  it("Spanish generic request words (arreglar, reparación…) are not evidence either — even against a Spanish-named generic row", async () => {
    const arreglos = row({
      id: "am",
      task: "Arreglos menores / reparación rápida",
      category: "General",
      keywords: ["perilla"],
    });
    const amFor = priced({
      matchedServices: [{ customerIssue: "motor", priceSheetItemId: "am" }],
      lineItems: [
        { description: "Arreglos menores", detail: "", amount: 60, priceSheetItemId: "am" },
      ],
    });
    expect(
      await runQuoteAttempts(
        input({
          priceSheet: [...sheet, arreglos],
          description: "¿Pueden arreglar el motor de mi carro? Necesito reparación rápida",
        }),
        [],
        scripted([amFor, amFor]),
      ),
    ).toMatchObject({ outOfScope: true });
  });

  it("V4: exclusions win over a relevant item, and accented Spanish exclusions match", async () => {
    const ask = scripted([faucetPriced]);
    const result = await runQuoteAttempts(
      input({
        description: "necesito reparación de techos y cambiar la llave",
        exclusions: [{ label: "Reparación de techos" }],
      }),
      [],
      ask,
    );
    expect(result).toMatchObject({
      outOfScope: true,
      excludedServiceLabel: "Reparación de techos",
    });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("ALWAYS INSPECT (no fee) stays eligible via its ':inspection' id when the customer names it", async () => {
    const inspection = priced({
      matchedServices: [{ customerIssue: "water heater", priceSheetItemId: "ai:inspection" }],
      lineItems: [],
    });
    const result = await runQuoteAttempts(
      input({ description: "my water heater is leaking" }),
      [],
      scripted([inspection]),
    );
    expect(result).toMatchObject({
      outOfScope: false,
      hasNoPricedWork: true,
      hasFeeFreeDeferralOnly: true,
    });
  });

  it("a diagnosis-fee id resolves to its own row and is eligible when relevant", async () => {
    const diag = priced({
      matchedServices: [{ customerIssue: "AC", priceSheetItemId: "ac:diagnosis" }],
      lineItems: [
        {
          description: "AC repair — diagnosis",
          detail: "",
          amount: 75,
          priceSheetItemId: "ac:diagnosis",
        },
      ],
    });
    const result = await runQuoteAttempts(
      input({ description: "my air conditioner stopped cooling" }),
      [],
      scripted([diag]),
    );
    expect(result).toMatchObject({ outOfScope: false, isDiagnosisOnly: true });
  });

  it("a service-call fee alongside a real, relevant item is still fine — the fee just can't stand alone", async () => {
    const both = priced({
      diagnosis: "Faucet replacement. The service-call fee applies toward the approved repair.",
      matchedServices: [
        { customerIssue: "faucet", priceSheetItemId: "fc" },
        { customerIssue: "visit", priceSheetItemId: "service_call" },
      ],
      lineItems: [
        { description: "Faucet replacement", detail: "", amount: 60, priceSheetItemId: "fc" },
        { description: "Service call", detail: "", amount: 89, priceSheetItemId: "service_call" },
      ],
    });
    expect(
      await runQuoteAttempts(
        input({ description: "replace my faucet please" }),
        [],
        scripted([both]),
      ),
    ).toMatchObject({ outOfScope: false });
  });

  it("a follow-up photo's caption (photoFollowUpNote) is prompt context only — never evidence", async () => {
    expect(
      await runQuoteAttempts(
        input({
          description: "my car engine won't start",
          photoFollowUpNote: "my kitchen faucet drips",
        }),
        [],
        scripted([faucetPriced, faucetPriced]),
      ),
    ).toMatchObject({ outOfScope: true });
  });
});

// D1 (2026-11-09 review package): a tampered browser request used to be able
// to send customerEvidence that differed from the description the AI saw.
// The field no longer exists — evidence is exactly the evaluated description.
describe("D1 — browser-supplied evidence can't replace the evaluated description", () => {
  const garageDoor: PriceSheetItem = {
    ...priceSheet[0]!,
    id: "gd",
    task: "Garage door repair",
    category: "Doors",
    keywords: ["garage door", "opener"],
  };
  const tampered = {
    businessName: "Biz",
    laborRate: 60,
    serviceCallFee: 89,
    serviceCallFeeMode: "fixed" as const,
    priceSheet: [garageDoor],
    exclusions: [],
    description: "fix my car engine",
    // The exact attack from the review package — now an unknown field.
    customerEvidence: ["my garage door"],
  } as unknown as QuoteInput;
  const garageQuestion = {
    needsClarification: true,
    scopeVerdict: "in_scope",
    candidatePriceSheetItemIds: ["gd"],
    questions: [{ question: "Is the door off its track?", options: ["Yes", "No"] }],
  };

  it("the exact attack: description 'fix my car engine' + injected garage-door evidence no longer releases the question", () => {
    expect(gateClarification(garageQuestion, tampered).ok).toBe(false);
  });

  it("…nor a priced garage-door quote", async () => {
    const garagePriced = {
      needsClarification: false,
      outOfScope: false,
      isEmergency: false,
      issueType: "Doors",
      severity: "Low",
      confidence: "High",
      diagnosis: "Garage door repair.",
      matchedServices: [{ customerIssue: "garage door", priceSheetItemId: "gd" }],
      lineItems: [
        { description: "Garage door repair", detail: "", amount: 60, priceSheetItemId: "gd" },
      ],
    };
    let call = 0;
    const ask = vi.fn(async () => {
      call += 1;
      return { raw: JSON.stringify(garagePriced), parsed: garagePriced };
    });
    expect(await runQuoteAttempts(tampered, [], ask)).toMatchObject({ outOfScope: true });
    expect(call).toBeGreaterThan(0);
  });

  it("legitimate: the same question is released when the description itself asks for it", () => {
    expect(
      gateClarification(garageQuestion, { ...tampered, description: "my garage door won't open" })
        .ok,
    ).toBe(true);
  });
});

describe("withAuthoritativeCatalog — V5: the server's price sheet, never the browser's", () => {
  const tampered: QuoteInput = {
    businessName: "Biz",
    laborRate: 60,
    serviceCallFee: 89,
    serviceCallFeeMode: "fixed",
    tenantSlug: "real-tenant",
    description: "fix my car engine",
    priceSheet: [
      { ...priceSheet[0]!, id: "fake", task: "Car engine repair", keywords: ["engine"] },
    ],
    exclusions: [],
  };
  const realCatalog = {
    businessName: "Real Biz",
    laborRate: 75,
    serviceCallFee: 95,
    serviceCallFeeMode: "negotiated" as const,
    priceSheet: [priceSheet[1]!],
    exclusions: [{ label: "Automotive work" }],
    specialties: [],
  };

  it("replaces a browser-supplied price sheet and exclusions with the tenant's real ones", async () => {
    const load = vi.fn(async () => realCatalog);
    const resolved = await withAuthoritativeCatalog(tampered, load);
    expect(load).toHaveBeenCalledWith("real-tenant");
    expect(resolved.priceSheet).toEqual(realCatalog.priceSheet);
    expect(resolved.exclusions).toEqual(realCatalog.exclusions);
  });

  it("C: labor rate, service-call fee, fee mode and business name also come from the server, never the browser", async () => {
    const resolved = await withAuthoritativeCatalog(
      {
        ...tampered,
        laborRate: 1,
        serviceCallFee: 0,
        serviceCallFeeMode: "fixed",
        businessName: "Fake",
      },
      async () => realCatalog,
    );
    expect(resolved).toMatchObject({
      businessName: "Real Biz",
      laborRate: 75,
      serviceCallFee: 95,
      serviceCallFeeMode: "negotiated",
    });
  });

  it("the tampered 'Car engine repair' item can no longer authorize a question", async () => {
    const resolved = await withAuthoritativeCatalog(tampered, async () => realCatalog);
    const gate = gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: ["fake"],
        questions: [{ question: "Q?", options: [] }],
      },
      resolved,
    );
    expect(gate.ok).toBe(false);
  });

  it("/demo (no tenant) keeps its own sample catalog and loads nothing", async () => {
    const load = vi.fn();
    const demo = { ...tampered, tenantSlug: undefined };
    expect(await withAuthoritativeCatalog(demo, load)).toBe(demo);
    expect(load).not.toHaveBeenCalled();
  });

  it("a catalog load failure propagates — never falls back to the browser's copy", async () => {
    await expect(
      withAuthoritativeCatalog(tampered, async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
  });
});

// Third review round (2026-11-09).
// A: an item's words merely appearing in the customer's message isn't a
// request for that service — multi-word items must match as a phrase, and
// an occurrence inside a location phrase ("in the garage", "frente a mi
// garaje") is incidental, not the thing to be worked on.
describe("A — phrase-level, non-incidental relevance from the customer's own words", () => {
  const garageDoor: PriceSheetItem = {
    id: "gd",
    task: "Garage door repair",
    category: "Garage",
    keywords: ["garage door", "opener", "puerta de garaje", "garaje"],
    pricingType: "flat",
    priceMin: 150,
    priceMax: 150,
    hours: 1,
    bundleable: false,
    materialsPolicy: "included",
    diagnosisFee: null,
    aiNotes: null,
    alwaysRequiresInspection: false,
  };
  const cabinetry: PriceSheetItem = {
    ...garageDoor,
    id: "cab",
    task: "Custom cabinetry",
    category: "Carpentry",
    keywords: [],
    priceMin: 0,
    priceMax: 0,
    alwaysRequiresInspection: true,
  };
  const heater: PriceSheetItem = {
    ...garageDoor,
    id: "wh",
    task: "Water heater replacement",
    category: "Plumbing",
    keywords: ["water heater", "calentador"],
    priceMin: 0,
    priceMax: 0,
    alwaysRequiresInspection: true,
  };
  const gate = (description: string, id = "gd") =>
    gateClarification(
      {
        needsClarification: true,
        scopeVerdict: "in_scope",
        candidatePriceSheetItemIds: [id],
        questions: [{ question: "Q?", options: [] }],
      },
      {
        priceSheet: [garageDoor, cabinetry, heater],
        exclusions: [],
        description,
      },
    );

  it.each([
    "My car is parked in the garage.",
    "There is a car in front of my garage.",
    "My car is next to the garage and won't start",
    "Mi carro está estacionado en el garaje.",
    "Hay un carro frente a mi garaje.",
    "El carro está dentro del garaje y no arranca",
  ])("incidental mention fails closed: %s", (description) => {
    expect(gate(description).ok).toBe(false);
  });

  it.each([
    "My garage door won't open.",
    "The garage door opener is broken",
    "I need my garage door fixed, my car is stuck inside",
    "La puerta de mi garaje no abre.",
    "Mi garaje no abre",
  ])("actual request is released: %s", (description) => {
    expect(gate(description).ok).toBe(true);
  });

  it.each(["My car door won't close.", "La puerta de mi carro no cierra."])(
    "sharing one word of a multi-word item isn't a request for it: %s",
    (description) => {
      expect(gate(description).ok).toBe(false);
    },
  );

  it("a multi-word item doesn't match on one of its words alone", () => {
    // "garage" without "door" can only match the single-word category /
    // keyword, and here that occurrence is locative.
    expect(gate("There's a door in my garage").ok).toBe(false);
  });

  it("custom-quote (ALWAYS INSPECT, no price) services stay eligible when actually requested", () => {
    expect(gate("Can you build custom kitchen cabinets?", "cab").ok).toBe(true);
    expect(gate("My water heater is leaking", "wh:inspection").ok).toBe(true);
    expect(gate("Mi calentador no calienta", "wh").ok).toBe(true);
  });

  it("…and stay ineligible when only mentioned incidentally", () => {
    expect(gate("There's a leak next to the water heater in my garage", "gd").ok).toBe(false);
  });
});

// B: the quoted-job follow-up path must not let a "same job" classification
// expand the scope of the original quote.
describe("B — evaluateFollowUpScope: deterministic quoted-scope check", () => {
  const scope = ["Kitchen faucet needs replacing.", "Faucet replacement"];

  it.each([
    "Can you also fix my car engine while you're there?",
    "Could you install a ceiling fan too?",
    "¿Pueden también arreglar el motor de mi carro?",
    "Can you repair the garage door as well?",
  ])("new work on a quoted job is detected: %s", (question) => {
    expect(evaluateFollowUpScope(question, scope, []).kind).toBe("new_work");
  });

  it.each([
    "When can you come?",
    "Is the price for the faucet still the same?",
    "Can you replace the faucet on Tuesday morning?",
    "¿Pueden cambiar el faucet el lunes?",
    "Do you take cash?",
  ])("questions about the quoted job are allowed: %s", (question) => {
    expect(evaluateFollowUpScope(question, scope, []).kind).toBe("allowed");
  });

  it("a configured exclusion wins over everything", () => {
    expect(
      evaluateFollowUpScope("can you do a roof repair?", scope, [{ label: "Roof repair" }]),
    ).toEqual({
      kind: "excluded",
      label: "Roof repair",
    });
  });
});

// C: anything the web flow hands back to the server that the server itself
// produced must carry a server signature, so browser-supplied history can't
// pass as something JIR asked, quoted, or approved.
describe("C — server-issued scope signatures", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  });

  const quote = {
    problem: "My kitchen faucet drips",
    diagnosis: "Worn cartridge.",
    confidence: "High" as const,
    items: [{ priceSheetItemId: "fc", amount: 60 }],
    hasNoPricedWork: false,
    hasPartiallyDeferredWork: false,
  };

  it("a quote signature verifies only for the exact tenant and quote it was issued for", () => {
    const token = signQuoteScope("acme", quote);
    expect(verifyQuoteScope("acme", quote, token)).toBe(true);
    expect(verifyQuoteScope("other-tenant", quote, token)).toBe(false);
    expect(
      verifyQuoteScope("acme", { ...quote, items: [{ priceSheetItemId: "fc", amount: 6 }] }, token),
    ).toBe(false);
    expect(verifyQuoteScope("acme", { ...quote, diagnosis: "Engine rebuild." }, token)).toBe(false);
    // D2: the request the quote was issued for is bound too.
    expect(
      verifyQuoteScope(
        "acme",
        { ...quote, problem: "My kitchen faucet drips, and my car engine" },
        token,
      ),
    ).toBe(false);
    expect(verifyQuoteScope("acme", quote, undefined)).toBe(false);
    expect(verifyQuoteScope("acme", quote, "garbage")).toBe(false);
  });

  it("question signatures bind the exact question texts", () => {
    const token = signQuestionsScope("acme", ["Which drain?"]);
    expect(verifyQuestionsScope("acme", ["Which drain?"], token)).toBe(true);
    expect(verifyQuestionsScope("acme", ["Is it your car engine?"], token)).toBe(false);
  });

  it("signing fails closed when the server secret is missing", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => signQuoteScope("acme", quote)).toThrow();
  });

  it("attachScopeTokens signs released questions and priced results for a tenant, and nothing for /demo or a hand-off", () => {
    const input = {
      businessName: "B",
      laborRate: 60,
      serviceCallFee: 89,
      serviceCallFeeMode: "fixed" as const,
      priceSheet,
      description: "clogged drain",
      tenantSlug: "acme",
    };
    const clarifying = attachScopeTokens(
      { needsClarification: true, questions: [{ question: "Which drain?", options: [] }] },
      input,
    );
    expect(
      clarifying.needsClarification &&
        verifyQuestionsScope("acme", ["Which drain?"], clarifying.questionsToken),
    ).toBe(true);
    const priced = attachScopeTokens(
      {
        needsClarification: false,
        outOfScope: false,
        isEmergency: false,
        issueType: "Plumbing",
        severity: "Low",
        confidence: "High",
        diagnosis: "Clog.",
        lineItems: [
          { description: "Drain clearing", detail: "", amount: 150, priceSheetItemId: "ps-2" },
        ],
        totalLow: 150,
        totalHigh: 150,
        isDiagnosisOnly: false,
        hasNoPricedWork: false,
        hasFeeFreeDeferralOnly: false,
        hasPartiallyDeferredWork: false,
      },
      input,
    );
    const pricedScope = {
      diagnosis: "Clog.",
      confidence: "High",
      items: [{ priceSheetItemId: "ps-2", amount: 150 }],
      hasNoPricedWork: false,
      hasPartiallyDeferredWork: false,
    };
    const quoteToken =
      !priced.needsClarification && !priced.outOfScope ? priced.quoteToken : undefined;
    // D2: the quote signature binds the description the server evaluated.
    expect(verifyQuoteScope("acme", { ...pricedScope, problem: "clogged drain" }, quoteToken)).toBe(
      true,
    );
    expect(
      verifyQuoteScope(
        "acme",
        { ...pricedScope, problem: "clogged drain and car engine" },
        quoteToken,
      ),
    ).toBe(false);
    const handedOff = attachScopeTokens({ needsClarification: false, outOfScope: true }, input);
    expect(handedOff).toEqual({ needsClarification: false, outOfScope: true });
    const demo = attachScopeTokens(
      { needsClarification: true, questions: [{ question: "Which drain?", options: [] }] },
      { ...input, tenantSlug: undefined },
    );
    expect(demo).toEqual({
      needsClarification: true,
      questions: [{ question: "Which drain?", options: [] }],
    });
  });
});

// D: the server-side follow-up validation, as a plain testable function.
describe("D — checkFollowUpRequest (web + WhatsApp follow-up answers)", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  });

  const catalog = {
    businessName: "Acme",
    laborRate: 60,
    serviceCallFee: 89,
    serviceCallFeeMode: "fixed" as const,
    priceSheet,
    exclusions: [{ label: "Roof repair" }],
    specialties: [],
  };
  const quoted = {
    problem: "My kitchen faucet drips",
    diagnosis: "Worn cartridge.",
    items: [{ description: "Faucet replacement", amount: 60 }],
  };
  const followUp = (question: string, overrides: Record<string, unknown> = {}) => ({
    businessName: "Acme",
    tenantSlug: "acme",
    problem: quoted.problem,
    diagnosis: quoted.diagnosis,
    lineItems: [{ description: "Faucet replacement", detail: "", amount: 60 }],
    question,
    history: [],
    followUpToken: signFollowUpScope("acme", quoted),
    ...overrides,
  });
  const load = async () => catalog;

  it("a normal question about the quoted job is allowed", async () => {
    expect(await checkFollowUpRequest(followUp("When can you come?"), load)).toEqual({ ok: true });
  });

  it("an excluded service is refused", async () => {
    expect(await checkFollowUpRequest(followUp("Can you also do a roof repair?"), load)).toEqual({
      ok: false,
      reason: "excluded_service",
    });
  });

  it("out-of-scope new work is refused", async () => {
    expect(await checkFollowUpRequest(followUp("Can you also fix my car engine?"), load)).toEqual({
      ok: false,
      reason: "new_work",
    });
  });

  it("a browser-forged quoted scope (an extra 'Car engine repair' line) fails verification", async () => {
    const forged = followUp("Can you fix the car engine on Tuesday?", {
      lineItems: [
        { description: "Faucet replacement", detail: "", amount: 60 },
        { description: "Car engine repair", detail: "", amount: 300 },
      ],
    });
    expect(await checkFollowUpRequest(forged, load)).toEqual({
      ok: false,
      reason: "unverified_scope",
    });
  });

  it("a missing signature fails verification", async () => {
    expect(
      await checkFollowUpRequest(
        followUp("When can you come?", { followUpToken: undefined }),
        load,
      ),
    ).toEqual({
      ok: false,
      reason: "unverified_scope",
    });
  });

  it("/demo (no tenant) has no catalog or signature to check", async () => {
    const demo = followUp("Can you also fix my car engine?", {
      tenantSlug: undefined,
      followUpToken: undefined,
    });
    expect(await checkFollowUpRequest(demo, vi.fn())).toEqual({ ok: true });
  });
});
