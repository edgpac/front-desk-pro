import { describe, expect, it } from "vitest";
import { buildPriceSheetBackup, parsePriceSheetBackup, PRICE_SHEET_BACKUP_FORMAT } from "./price-sheet-backup";
import type { PriceSheetRow } from "@/lib/mock-data";

const FULL_ROW: PriceSheetRow = {
  id: "row-1",
  task: "Window repair",
  category: "General",
  keywords: ["window", "glass"],
  pricingType: "range",
  priceMin: 60,
  priceMax: 120,
  hours: 2,
  bundleable: true,
  materialsPolicy: "customer_pays_receipt",
  diagnosisFee: { pricingType: "hourly", amount: 40 },
  aiNotes: "Always needs an in-person look before quoting — don't estimate from a photo alone",
};

// A complete, valid item shape other tests build on by overriding one
// field at a time — keeps each malformed-field test focused on exactly
// the one thing it's checking.
const VALID_ITEM = {
  task: "Window repair",
  category: "General",
  keywords: ["window"],
  pricingType: "flat",
  priceMin: 10,
  priceMax: 10,
  hours: 1,
  bundleable: false,
  materialsPolicy: "included",
  diagnosisFee: null,
  aiNotes: null,
};

function backupWith(items: unknown[]) {
  return JSON.stringify({ format: PRICE_SHEET_BACKUP_FORMAT, items });
}

describe("buildPriceSheetBackup / parsePriceSheetBackup round-trip", () => {
  it("round-trips every field exactly, including the ones AI import never captures", () => {
    const backup = buildPriceSheetBackup([FULL_ROW]);
    expect(backup.format).toBe(PRICE_SHEET_BACKUP_FORMAT);
    const result = parsePriceSheetBackup(JSON.stringify(backup));
    expect(result).toEqual({
      ok: true,
      items: [
        {
          task: "Window repair",
          category: "General",
          keywords: ["window", "glass"],
          pricingType: "range",
          priceMin: 60,
          priceMax: 120,
          hours: 2,
          bundleable: true,
          materialsPolicy: "customer_pays_receipt",
          diagnosisFee: { pricingType: "hourly", amount: 40 },
          aiNotes: "Always needs an in-person look before quoting — don't estimate from a photo alone",
        },
      ],
    });
  });

  it("strips the row id — a restored row always gets a fresh one, same as a normal save already does", () => {
    const backup = buildPriceSheetBackup([FULL_ROW]);
    expect(backup.items[0]).not.toHaveProperty("id");
  });

  it("round-trips a row with no diagnosis fee and no AI note (both null)", () => {
    const row: PriceSheetRow = { ...FULL_ROW, diagnosisFee: null, aiNotes: null };
    const result = parsePriceSheetBackup(JSON.stringify(buildPriceSheetBackup([row])));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items[0]?.diagnosisFee).toBeNull();
      expect(result.items[0]?.aiNotes).toBeNull();
    }
  });

  it("an entire real price sheet (many legitimate rows, varied field combinations) round-trips with every field intact", () => {
    const rows: PriceSheetRow[] = [
      FULL_ROW,
      {
        id: "row-2",
        task: "Concrete walls",
        category: "General",
        keywords: [],
        pricingType: "flat",
        priceMin: 0,
        priceMax: 0,
        hours: 0,
        bundleable: false,
        materialsPolicy: "included",
        diagnosisFee: null,
        aiNotes: null,
      },
      {
        id: "row-3",
        task: "",
        category: "",
        keywords: ["a", "b", "c"],
        pricingType: "hourly",
        priceMin: 60,
        priceMax: 60,
        hours: 1,
        bundleable: true,
        materialsPolicy: "confirmed_after_inspection",
        diagnosisFee: { pricingType: "flat", amount: 0 },
        aiNotes: "",
      },
    ];
    const result = parsePriceSheetBackup(JSON.stringify(buildPriceSheetBackup(rows)));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(3);
      expect(result.items.map(({ id: _ignored, ...rest }: any) => rest)).toEqual(
        rows.map(({ id: _id, ...rest }) => rest),
      );
    }
  });
});

describe("parsePriceSheetBackup — legitimate optional/nullable/zero/boolean/empty values are preserved, not rejected", () => {
  it("accepts priceMin, priceMax, and hours all at 0", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, priceMin: 0, priceMax: 0, hours: 0 }]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toMatchObject({ priceMin: 0, priceMax: 0, hours: 0 });
  });

  it("accepts bundleable: false explicitly (not just truthy/falsy coercion)", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, bundleable: false }]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]?.bundleable).toBe(false);
  });

  it("accepts an empty keywords array", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, keywords: [] }]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]?.keywords).toEqual([]);
  });

  it("accepts an empty-string task and category — a real, legitimate value this app's own save-time validation never forbids", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, task: "", category: "" }]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]).toMatchObject({ task: "", category: "" });
  });

  it("accepts diagnosisFee: null", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, diagnosisFee: null }]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]?.diagnosisFee).toBeNull();
  });

  it("accepts a real diagnosisFee with amount: 0", () => {
    const result = parsePriceSheetBackup(
      backupWith([{ ...VALID_ITEM, diagnosisFee: { pricingType: "flat", amount: 0 } }]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]?.diagnosisFee).toEqual({ pricingType: "flat", amount: 0 });
  });

  it("accepts aiNotes: null", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, aiNotes: null }]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items[0]?.aiNotes).toBeNull();
  });

  it("treats a completely MISSING diagnosisFee/aiNotes key the same as an explicit null — a legitimate omission, not a malformed field", () => {
    const { diagnosisFee: _d, aiNotes: _a, ...withoutNullableKeys } = VALID_ITEM;
    const result = parsePriceSheetBackup(backupWith([withoutNullableKeys]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items[0]?.diagnosisFee).toBeNull();
      expect(result.items[0]?.aiNotes).toBeNull();
    }
  });
});

describe("parsePriceSheetBackup — rejects the ENTIRE backup atomically on any malformed item (the fix for the prior silent-partial-restore finding)", () => {
  it("a mix of valid items and one malformed item rejects the WHOLE file, not just the bad row", () => {
    const result = parsePriceSheetBackup(
      backupWith([VALID_ITEM, {}, { ...VALID_ITEM, task: "Gas line installation" }]),
    );
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("Item 2"),
    });
  });

  it("a file containing only malformed items is rejected (not partially restored as empty-default rows)", () => {
    const result = parsePriceSheetBackup(backupWith([{}, {}, {}]));
    expect(result.ok).toBe(false);
  });

  it("names which item failed (1-indexed) and includes its task name when readable", () => {
    const result = parsePriceSheetBackup(
      backupWith([VALID_ITEM, VALID_ITEM, { ...VALID_ITEM, task: "Gas line installation", pricingType: "nonsense" }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Item 3");
      expect(result.reason).toContain("Gas line installation");
    }
  });

  it.each([
    ["missing task", { ...VALID_ITEM, task: undefined }],
    ["non-string task", { ...VALID_ITEM, task: 123 }],
    ["missing category", { ...VALID_ITEM, category: undefined }],
    ["non-string category", { ...VALID_ITEM, category: {} }],
    ["missing keywords", { ...VALID_ITEM, keywords: undefined }],
    ["keywords not an array", { ...VALID_ITEM, keywords: "window,glass" }],
    ["keywords array with a non-string element", { ...VALID_ITEM, keywords: ["window", 5] }],
    ["missing priceMin", { ...VALID_ITEM, priceMin: undefined }],
    ["priceMin as a string", { ...VALID_ITEM, priceMin: "10" }],
    ["priceMin as NaN", { ...VALID_ITEM, priceMin: Number.NaN }],
    ["missing priceMax", { ...VALID_ITEM, priceMax: undefined }],
    ["missing hours", { ...VALID_ITEM, hours: undefined }],
    ["missing bundleable", { ...VALID_ITEM, bundleable: undefined }],
    ["bundleable as a truthy non-boolean", { ...VALID_ITEM, bundleable: 1 }],
  ])("rejects a backup whose item has: %s", (_label, malformedItem) => {
    const result = parsePriceSheetBackup(backupWith([malformedItem]));
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid pricingType enum value (previously silently coerced to 'flat')", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, pricingType: "nonsense" }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("pricingType");
  });

  it("rejects a missing pricingType", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, pricingType: undefined }]));
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid materialsPolicy enum value (previously silently coerced to 'included')", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, materialsPolicy: "literally anything" }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("materialsPolicy");
  });

  it("rejects a missing materialsPolicy", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, materialsPolicy: undefined }]));
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed diagnosisFee: invalid nested pricingType (previously silently dropped to null)", () => {
    const result = parsePriceSheetBackup(
      backupWith([{ ...VALID_ITEM, diagnosisFee: { pricingType: "weekly", amount: 5 } }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("diagnosisFee");
  });

  it("rejects a malformed diagnosisFee: missing amount", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, diagnosisFee: { pricingType: "flat" } }]));
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed diagnosisFee: amount as a non-finite number", () => {
    const result = parsePriceSheetBackup(
      backupWith([{ ...VALID_ITEM, diagnosisFee: { pricingType: "flat", amount: Number.POSITIVE_INFINITY } }]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed diagnosisFee: not an object at all", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, diagnosisFee: "none" }]));
    expect(result.ok).toBe(false);
  });

  it("rejects a non-string, non-null aiNotes", () => {
    const result = parsePriceSheetBackup(backupWith([{ ...VALID_ITEM, aiNotes: 12345 }]));
    expect(result.ok).toBe(false);
  });

  it("rejects an item that isn't an object at all (a bare string/number/array in the items list)", () => {
    expect(parsePriceSheetBackup(backupWith(["not an item"])).ok).toBe(false);
    expect(parsePriceSheetBackup(backupWith([42])).ok).toBe(false);
    expect(parsePriceSheetBackup(backupWith([["nested", "array"]])).ok).toBe(false);
  });

  it("failure never includes the full malformed JSON/raw item in the reason — only a field-level description", () => {
    const result = parsePriceSheetBackup(
      backupWith([{ ...VALID_ITEM, task: "ok", aiNotes: { secret: "should not leak" } }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain("should not leak");
  });
});

describe("parsePriceSheetBackup — outer-shape rejection (unchanged from before this fix)", () => {
  it("rejects plain invalid JSON, never throws", () => {
    expect(() => parsePriceSheetBackup("{not valid json")).not.toThrow();
    expect(parsePriceSheetBackup("{not valid json").ok).toBe(false);
  });

  it("rejects well-formed JSON that isn't one of this app's own backup files", () => {
    expect(parsePriceSheetBackup(JSON.stringify({ some: "other json file" })).ok).toBe(false);
    expect(parsePriceSheetBackup(JSON.stringify([1, 2, 3])).ok).toBe(false);
    expect(parsePriceSheetBackup(JSON.stringify({ format: "something-else", items: [] })).ok).toBe(false);
  });

  it("rejects when format matches but items isn't an array", () => {
    expect(
      parsePriceSheetBackup(JSON.stringify({ format: PRICE_SHEET_BACKUP_FORMAT, items: "not an array" })).ok,
    ).toBe(false);
  });

  it("an empty items array is accepted (ok: true, items: []) — the caller decides how to handle zero rows", () => {
    expect(parsePriceSheetBackup(backupWith([]))).toEqual({ ok: true, items: [] });
  });
});
