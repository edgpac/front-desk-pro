import { describe, expect, it } from "vitest";
import { validatePriceSheetItem } from "./price-sheet-server";
import type { MaterialsPolicy, PricingType } from "@/lib/mock-data";

// Business-rule validation coverage for the Save-changes path
// (saveMyPriceSheet), requested ahead of pushing the price-sheet backup
// feature — the backup parser (price-sheet-backup.ts) deliberately only
// validates STRUCTURE (is this a number, is this one of the real enum
// values), never business rules like "not negative" or "min <= max",
// since those are saveMyPriceSheet's job at the one point that actually
// decides what gets persisted. This file verifies that job is actually
// done.
//
// IMPORTANT, EMPIRICALLY CONFIRMED LIMITATION: saveMyPriceSheet itself
// (a bare `createServerFn`, never extracted into a plain callable
// function the way performCreateClarifyingLead/performFinalizeLeadWithQuote
// in public-lead-server.ts were specifically for this reason) CANNOT be
// invoked directly in this test environment. A direct call was attempted
// and throws, every time: "No Start context found in AsyncLocalStorage.
// Make sure you are using the function within the server runtime." —
// this is TanStack Start's own server-function runtime machinery, which
// vitest does not provide.
//
// This file is split into two describe blocks that are deliberately NOT
// the same kind of test:
//
// - "Unit tests" calls validatePriceSheetItem directly with exactly its
//   own declared parameter shape ({task, priceMin, priceMax, hours}) —
//   nothing more. This proves the validator's own logic in isolation.
//
// - "Integration-style tests" constructs the FULL item shape
//   saveMyPriceSheet's own `data.items` elements actually have (every
//   price-sheet field, not just the four validatePriceSheetItem reads)
//   and calls validatePriceSheetItem through the exact same expression
//   saveMyPriceSheet's handler uses — `data.items.map(validatePriceSheetItem)`
//   (price-sheet-server.ts:133). This is the closest this test
//   environment can get to an integration test of the real save path,
//   and it is still NOT a full integration test: it does not invoke
//   saveMyPriceSheet itself, so it proves nothing about
//   requireSupabaseAuth gating, the tenant lookup, or the delete/insert
//   sequence that follows a successful validation. Those three are true
//   only by direct reading of price-sheet-server.ts:125-166
//   (validationErrors is computed and checked at lines 133-136, strictly
//   before the delete call at lines 138-141) — confirmed by source
//   inspection, not by any test in this file.

function fullItem(overrides: Partial<{
  task: string;
  category: string;
  keywords: string[];
  pricingType: PricingType;
  priceMin: number;
  priceMax: number;
  hours: number;
  bundleable: boolean;
  materialsPolicy: MaterialsPolicy;
  diagnosisFee: { pricingType: "flat" | "hourly"; amount: number } | null;
  aiNotes: string | null;
}>) {
  // The FULL shape saveMyPriceSheet's own `data.items` elements actually
  // have — not validatePriceSheetItem's own narrower parameter type.
  // TypeScript's structural typing is exactly why saveMyPriceSheet can
  // call `data.items.map(validatePriceSheetItem)` at all: a wider-typed
  // variable may be passed where a narrower type is expected. Using the
  // full shape here, the same way, is what makes this an honest
  // reproduction of that real call site rather than a narrower duplicate.
  return {
    task: "Window repair",
    category: "General",
    keywords: [] as string[],
    pricingType: "flat" as PricingType,
    priceMin: 100,
    priceMax: 100,
    hours: 1,
    bundleable: false,
    materialsPolicy: "included" as MaterialsPolicy,
    diagnosisFee: null,
    aiNotes: null,
    ...overrides,
  };
}

describe("Unit tests — validatePriceSheetItem called directly with its own declared shape", () => {
  it("rejects a negative priceMin", () => {
    const error = validatePriceSheetItem({ task: "Window repair", priceMin: -10, priceMax: 100, hours: 1 });
    expect(error).not.toBeNull();
    expect(error).toContain("minimum price can't be negative");
  });

  it("rejects a negative priceMax", () => {
    const error = validatePriceSheetItem({ task: "Window repair", priceMin: 0, priceMax: -10, hours: 1 });
    expect(error).not.toBeNull();
    expect(error).toContain("maximum price can't be negative");
  });

  it("rejects priceMin > priceMax", () => {
    const error = validatePriceSheetItem({ task: "Window repair", priceMin: 200, priceMax: 100, hours: 1 });
    expect(error).not.toBeNull();
    expect(error).toContain("can't be greater than the maximum");
  });

  it("rejects a negative hours value (fix: previously accepted — see integration-style test below for the full-item reproduction)", () => {
    const error = validatePriceSheetItem({ task: "Window repair", priceMin: 100, priceMax: 100, hours: -5 });
    expect(error).not.toBeNull();
    expect(error).toContain("hours can't be negative");
  });

  it("accepts a legitimate row with priceMin, priceMax, AND hours all at zero — a real, intentional 'not yet priced' state, not a bug", () => {
    const error = validatePriceSheetItem({ task: "Window repair", priceMin: 0, priceMax: 0, hours: 0 });
    expect(error).toBeNull();
  });

  it("accepts priceMin === priceMax (a flat/hourly price, not a range) — explicitly permitted, only priceMin > priceMax is rejected", () => {
    const error = validatePriceSheetItem({ task: "Window repair", priceMin: 150, priceMax: 150, hours: 1 });
    expect(error).toBeNull();
  });

  it("confirms the exact rejection message includes the task name, matching saveMyPriceSheet's own error-joining behavior", () => {
    const error = validatePriceSheetItem({ task: "Gas line installation", priceMin: -1, priceMax: 100, hours: 1 });
    expect(error).toBe("\"Gas line installation\": minimum price can't be negative.");
  });

  it("confirms the exact rejection message for negative hours includes the task name", () => {
    const error = validatePriceSheetItem({ task: "Gas line installation", priceMin: 0, priceMax: 100, hours: -2 });
    expect(error).toBe("\"Gas line installation\": hours can't be negative.");
  });
});

describe("Integration-style tests — mirroring saveMyPriceSheet's exact call shape (data.items.map(validatePriceSheetItem), full item objects, NOT a call to saveMyPriceSheet itself — see file header)", () => {
  it("fix verified: a negative hours value on a full item is now rejected, not silently accepted", () => {
    const item = fullItem({ hours: -5 });
    const error = validatePriceSheetItem(item);
    expect(error).not.toBeNull();
    expect(error).toContain("hours can't be negative");
    // Database-level backstop still does not exist (0001_init.sql:
    // price_sheet_items.hours has no CHECK constraint, unlike
    // pricing_type) — this fix closes the gap at the one place
    // saveMyPriceSheet actually calls, which is sufficient since that
    // call is unconditionally reached before any delete/insert
    // (price-sheet-server.ts:133-141), but a CHECK constraint would be a
    // reasonable defense-in-depth addition, not implemented here.
  });

  it("a full item with hours: 0 alongside zero prices is still accepted — the fix does not reject legitimate zero values", () => {
    const error = validatePriceSheetItem(fullItem({ priceMin: 0, priceMax: 0, hours: 0 }));
    expect(error).toBeNull();
  });

  it("a full item with a realistic positive hours value and no other defect is accepted", () => {
    const error = validatePriceSheetItem(fullItem({ pricingType: "hourly", priceMin: 60, priceMax: 60, hours: 2.5 }));
    expect(error).toBeNull();
  });

  it("existing valid data representative of a real price sheet remains accepted across pricingType variants, run through the exact saveMyPriceSheet call shape", () => {
    const items = [
      fullItem({ pricingType: "flat", priceMin: 80, priceMax: 80, hours: 1 }),
      fullItem({ pricingType: "hourly", priceMin: 60, priceMax: 60, hours: 1 }),
      fullItem({ pricingType: "range", priceMin: 60, priceMax: 120, hours: 2 }),
    ];
    const errors = items.map(validatePriceSheetItem).filter((e): e is string => e !== null);
    expect(errors).toEqual([]);
  });

  it("a mixed batch with one bad item (negative hours) and otherwise-valid items reports exactly the one failure — matching saveMyPriceSheet's validationErrors.join behavior", () => {
    const items = [
      fullItem({ task: "Good item", priceMin: 50, priceMax: 50, hours: 1 }),
      fullItem({ task: "Bad item", priceMin: 50, priceMax: 50, hours: -1 }),
    ];
    const errors = items.map(validatePriceSheetItem).filter((e): e is string => e !== null);
    expect(errors).toEqual(["\"Bad item\": hours can't be negative."]);
  });
});
