import { describe, expect, it } from "vitest";
import {
  validateSubmittedLineItem,
  validateQuoteAgainstPriceSheet,
  buildPrompt,
  SERVICE_CALL_SENTINEL_ID,
  type PriceSheetItem,
  type QuoteInput,
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
    const failure = validateSubmittedLineItem({ description: "Made up job", amount: 999 }, priceSheet, 89, "fixed");
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
  function base(overrides: Partial<{ matchedServices: unknown; lineItems: unknown; diagnosis: unknown }> = {}) {
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
      base({ lineItems: [{ description: "Doorknob", detail: "", amount: 9999, priceSheetItemId: "ps-1" }] }),
      priceSheet,
      89,
      "fixed",
    );
    expect(failures.some((f) => f.includes("doesn't match the configured price"))).toBe(true);
  });

  it("rejects the service-call sentinel as a priced lineItem when the tenant's fee is negotiated", () => {
    const failures = validateQuoteAgainstPriceSheet(
      base({
        matchedServices: [{ customerIssue: "diagnostic visit", priceSheetItemId: SERVICE_CALL_SENTINEL_ID }],
        lineItems: [
          { description: "Service call", detail: "", amount: 89, priceSheetItemId: SERVICE_CALL_SENTINEL_ID },
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
          { description: "Service call", detail: "", amount: 89, priceSheetItemId: SERVICE_CALL_SENTINEL_ID },
          { description: "Doorknob", detail: "", amount: 60, priceSheetItemId: "ps-1" },
        ],
        diagnosis: "Diagnostic visit plus a doorknob fix — no mention of how the fee relates to the repair.",
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
          { description: "Service call", detail: "", amount: 89, priceSheetItemId: SERVICE_CALL_SENTINEL_ID },
          { description: "Doorknob", detail: "", amount: 60, priceSheetItemId: "ps-1" },
        ],
        diagnosis: "The service call fee goes toward the approved repair if you proceed with the doorknob fix.",
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
        lineItems: [{ description: "Doorknob", detail: "", amount: 60, priceSheetItemId: "ps-parts" }],
        diagnosis: "The doorknob is loose and needs a new part.",
      }),
      partsPriceSheet,
      89,
      "fixed",
    );
    expect(failures.some((f) => f.includes("materials_policy"))).toBe(true);
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
});
