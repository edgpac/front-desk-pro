import { describe, expect, it } from "vitest";
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
