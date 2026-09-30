import { describe, expect, it } from "vitest";
import { validateSubmittedLineItem, SERVICE_CALL_SENTINEL_ID, type PriceSheetItem } from "./estimate-server";

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
