import { describe, expect, it } from "vitest";
import {
  applyConversionToPriceSheet,
  buildPriceSheetConversionPreview,
  convertAmount,
  convertLaborRateAndFee,
  isValidConversionRate,
} from "./price-sheet-currency-conversion";
import type { PriceSheetRow } from "./mock-data";

function item(overrides: Partial<PriceSheetRow> = {}): PriceSheetRow {
  return {
    id: "item-1",
    task: "Ceiling light installation",
    category: "General",
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
    ...overrides,
  };
}

describe("convertAmount", () => {
  it("multiplies and rounds to the nearest whole unit", () => {
    expect(convertAmount(60, 18.69)).toBe(1121);
  });

  it("rounds up at the .5 boundary", () => {
    expect(convertAmount(10, 1.25)).toBe(13); // 12.5 -> 13 (round-half-up)
  });

  it("handles a rate below 1 (converting to a stronger currency)", () => {
    expect(convertAmount(1000, 0.05)).toBe(50);
  });
});

describe("isValidConversionRate", () => {
  it("accepts a normal positive rate", () => {
    expect(isValidConversionRate(18.69)).toBe(true);
  });

  it("rejects zero, negative, NaN, and Infinity", () => {
    expect(isValidConversionRate(0)).toBe(false);
    expect(isValidConversionRate(-5)).toBe(false);
    expect(isValidConversionRate(Number.NaN)).toBe(false);
    expect(isValidConversionRate(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("buildPriceSheetConversionPreview", () => {
  it("computes old and new values for a flat-priced item, per the user's own worked example", () => {
    const preview = buildPriceSheetConversionPreview([item({ priceMin: 60, priceMax: 60 })], 18.69);
    expect(preview[0]).toMatchObject({
      currentPriceMin: 60,
      currentPriceMax: 60,
      newPriceMin: 1121,
      newPriceMax: 1121,
    });
  });

  it("converts both ends of a price range independently", () => {
    const preview = buildPriceSheetConversionPreview(
      [item({ pricingType: "range", priceMin: 50, priceMax: 100 })],
      10,
    );
    expect(preview[0]?.newPriceMin).toBe(500);
    expect(preview[0]?.newPriceMax).toBe(1000);
  });

  it("converts a diagnosis fee when present", () => {
    const preview = buildPriceSheetConversionPreview(
      [item({ diagnosisFee: { pricingType: "flat", amount: 25 } })],
      10,
    );
    expect(preview[0]?.currentDiagnosisFee).toBe(25);
    expect(preview[0]?.newDiagnosisFee).toBe(250);
  });

  it("leaves diagnosisFee null when the item has none", () => {
    const preview = buildPriceSheetConversionPreview([item({ diagnosisFee: null })], 10);
    expect(preview[0]?.currentDiagnosisFee).toBeNull();
    expect(preview[0]?.newDiagnosisFee).toBeNull();
  });

  it("produces one preview row per item, preserving order and identity", () => {
    const items = [item({ id: "a", task: "A" }), item({ id: "b", task: "B" })];
    const preview = buildPriceSheetConversionPreview(items, 2);
    expect(preview.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("returns an empty preview for an empty price sheet", () => {
    expect(buildPriceSheetConversionPreview([], 10)).toEqual([]);
  });
});

describe("applyConversionToPriceSheet", () => {
  it("returns a full replacement list with every price field converted, matching the preview exactly", () => {
    const items = [
      item({ priceMin: 60, priceMax: 60, diagnosisFee: { pricingType: "flat", amount: 25 } }),
    ];
    const preview = buildPriceSheetConversionPreview(items, 18.69);
    const converted = applyConversionToPriceSheet(items, 18.69);
    expect(converted[0]?.priceMin).toBe(preview[0]?.newPriceMin);
    expect(converted[0]?.priceMax).toBe(preview[0]?.newPriceMax);
    expect(converted[0]?.diagnosisFee?.amount).toBe(preview[0]?.newDiagnosisFee);
  });

  it("preserves every other field unchanged (task, category, keywords, pricingType, hours, etc.)", () => {
    const original = item({
      task: "Fix sliding door",
      category: "Doors",
      keywords: ["door", "lock"],
      hours: 2,
    });
    const [converted] = applyConversionToPriceSheet([original], 10);
    expect(converted).toMatchObject({
      task: "Fix sliding door",
      category: "Doors",
      keywords: ["door", "lock"],
      hours: 2,
      pricingType: "flat",
    });
  });

  it("does not mutate the original items array", () => {
    const original = item({ priceMin: 60, priceMax: 60 });
    applyConversionToPriceSheet([original], 10);
    expect(original.priceMin).toBe(60);
  });
});

describe("convertLaborRateAndFee", () => {
  it("converts both values using the same rate", () => {
    const result = convertLaborRateAndFee(50, 75, 18.69);
    expect(result).toEqual({
      laborRate: convertAmount(50, 18.69),
      serviceCallFee: convertAmount(75, 18.69),
    });
  });
});
