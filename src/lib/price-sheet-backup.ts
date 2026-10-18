import type { MaterialsPolicy, PriceSheetRow, PricingType } from "@/lib/mock-data";

// Lossless local backup/restore for the price-sheet dashboard page —
// distinct from price-sheet-server.ts's AI photo/URL import, which only
// ever recovers task/category/price/hours (see its own
// ExtractedPriceSheetItem — bundleable/materialsPolicy/diagnosisFee/
// aiNotes always come back reset to defaults there, since a printed
// price list never states them). This instead round-trips every field
// exactly. Entirely client-side, no server function: the data is already
// fully present in the dashboard page's own loaded rows, and a restored
// file only ever replaces local editor state — nothing is written to the
// database until the user reviews it and explicitly saves, the same
// review step the AI-import path already requires.
export const PRICE_SHEET_BACKUP_FORMAT = "job-it-ready-price-sheet-backup";
export const PRICE_SHEET_BACKUP_VERSION = 1;

export type PriceSheetBackupFile = {
  format: typeof PRICE_SHEET_BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  items: Array<Omit<PriceSheetRow, "id">>;
};

export function buildPriceSheetBackup(rows: PriceSheetRow[]): PriceSheetBackupFile {
  return {
    format: PRICE_SHEET_BACKUP_FORMAT,
    version: PRICE_SHEET_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    items: rows.map(({ id: _id, ...rest }) => rest),
  };
}

const VALID_PRICING_TYPES: PricingType[] = ["flat", "hourly", "range"];
const VALID_MATERIALS_POLICIES: MaterialsPolicy[] = [
  "included",
  "customer_pays_receipt",
  "confirmed_after_inspection",
];
const VALID_DIAGNOSIS_FEE_PRICING_TYPES = ["flat", "hourly"] as const;

// Result of parsing one item. Never throws — every failure is a value, so
// the caller (parsePriceSheetBackup) can fail the WHOLE backup atomically
// on the first bad item rather than letting a partially-parsed array leak
// out. See that function's own comment for why this replaced the earlier
// coerce-everything-to-a-default design.
type ItemValidationResult =
  | { ok: true; value: Omit<PriceSheetRow, "id"> }
  | { ok: false; reason: string };

// Strict, per-field structural validation — deliberately NOT business-rule
// validation (e.g. priceMin <= priceMax, no negative prices): that's
// already enforced server-side by price-sheet-server.ts's own
// validatePriceSheetItem at Save-changes time, and duplicating it here
// would be exactly the "unnecessary complexity" this fix was told to
// avoid. This only answers "is this item SHAPED like a real
// PriceSheetRow" — present, correctly-typed, and (for the two enums and
// the nested diagnosisFee) one of the values this app's own schema
// actually allows. A value that passes here but fails a business rule
// (e.g. a negative price) still reaches the editor and is still caught,
// visibly, when the user tries to save — same safety net as hand-typing
// it into the form.
function validateBackupItem(raw: unknown, index: number): ItemValidationResult {
  const fail = (reason: string): ItemValidationResult => ({
    ok: false,
    reason: `Item ${index + 1}${isReadableTask(raw) ? ` ("${(raw as { task: string }).task}")` : ""}: ${reason}`,
  });

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("isn't a valid service entry.");
  }
  const item = raw as Record<string, unknown>;

  if (typeof item["task"] !== "string") {
    return fail("missing or invalid \"task\" (expected text).");
  }
  if (typeof item["category"] !== "string") {
    return fail("missing or invalid \"category\" (expected text).");
  }
  if (!Array.isArray(item["keywords"]) || !item["keywords"].every((k) => typeof k === "string")) {
    return fail("\"keywords\" must be a list of text (an empty list is fine).");
  }
  if (!VALID_PRICING_TYPES.includes(item["pricingType"] as PricingType)) {
    return fail(`"pricingType" must be one of: ${VALID_PRICING_TYPES.join(", ")}.`);
  }
  if (typeof item["priceMin"] !== "number" || !Number.isFinite(item["priceMin"])) {
    return fail("missing or invalid \"priceMin\" (expected a number — 0 is fine).");
  }
  if (typeof item["priceMax"] !== "number" || !Number.isFinite(item["priceMax"])) {
    return fail("missing or invalid \"priceMax\" (expected a number — 0 is fine).");
  }
  if (typeof item["hours"] !== "number" || !Number.isFinite(item["hours"])) {
    return fail("missing or invalid \"hours\" (expected a number — 0 is fine).");
  }
  if (typeof item["bundleable"] !== "boolean") {
    return fail("missing or invalid \"bundleable\" (expected true or false).");
  }
  if (!VALID_MATERIALS_POLICIES.includes(item["materialsPolicy"] as MaterialsPolicy)) {
    return fail(`"materialsPolicy" must be one of: ${VALID_MATERIALS_POLICIES.join(", ")}.`);
  }

  // Nullable nested object — a missing key is treated the same as an
  // explicit null (a legitimate "no diagnosis fee configured" omission,
  // not a malformed field); anything else must be fully well-formed.
  let diagnosisFee: { pricingType: "flat" | "hourly"; amount: number } | null;
  const rawDiagnosisFee = item["diagnosisFee"];
  if (rawDiagnosisFee == null) {
    diagnosisFee = null;
  } else if (
    typeof rawDiagnosisFee === "object" &&
    !Array.isArray(rawDiagnosisFee) &&
    VALID_DIAGNOSIS_FEE_PRICING_TYPES.includes(
      (rawDiagnosisFee as Record<string, unknown>)["pricingType"] as "flat" | "hourly",
    ) &&
    typeof (rawDiagnosisFee as Record<string, unknown>)["amount"] === "number" &&
    Number.isFinite((rawDiagnosisFee as Record<string, unknown>)["amount"])
  ) {
    diagnosisFee = {
      pricingType: (rawDiagnosisFee as Record<string, unknown>)["pricingType"] as "flat" | "hourly",
      amount: (rawDiagnosisFee as Record<string, unknown>)["amount"] as number,
    };
  } else {
    return fail("\"diagnosisFee\" must be null, or {pricingType: \"flat\"|\"hourly\", amount: number}.");
  }

  // Nullable string — same "missing key == null" leniency as diagnosisFee.
  const rawAiNotes = item["aiNotes"];
  if (rawAiNotes != null && typeof rawAiNotes !== "string") {
    return fail("\"aiNotes\" must be null or text.");
  }
  const aiNotes: string | null = typeof rawAiNotes === "string" ? rawAiNotes : null;

  return {
    ok: true,
    value: {
      task: item["task"] as string,
      category: item["category"] as string,
      keywords: item["keywords"] as string[],
      pricingType: item["pricingType"] as PricingType,
      priceMin: item["priceMin"] as number,
      priceMax: item["priceMax"] as number,
      hours: item["hours"] as number,
      bundleable: item["bundleable"] as boolean,
      materialsPolicy: item["materialsPolicy"] as MaterialsPolicy,
      diagnosisFee,
      aiNotes,
    },
  };
}

function isReadableTask(raw: unknown): raw is { task: string } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as Record<string, unknown>)["task"] === "string" &&
    (raw as Record<string, unknown>)["task"] !== ""
  );
}

export type PriceSheetBackupParseResult =
  | { ok: true; items: Array<Omit<PriceSheetRow, "id">> }
  | { ok: false; reason: string };

// Validates the ENTIRE file before returning anything — never throws, and
// never returns a partial result. A prior version of this function
// coerced each malformed item into a generic default row (empty task,
// $0, "included", etc.) rather than rejecting it; a review found this let
// a file with even one corrupted item silently restore as if it were
// fully valid, with no error and no visible signal beyond the garbage row
// itself possibly being noticed on screen. This version instead validates
// every item strictly (see validateBackupItem) and rejects the whole
// backup — atomically, nothing partially applied — the moment any single
// item fails, naming which one and why.
export function parsePriceSheetBackup(raw: string): PriceSheetBackupParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "That file isn't valid JSON." };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>)["format"] !== PRICE_SHEET_BACKUP_FORMAT ||
    !Array.isArray((parsed as Record<string, unknown>)["items"])
  ) {
    return { ok: false, reason: "That doesn't look like a price sheet backup file from this app." };
  }

  const rawItems = (parsed as { items: unknown[] }).items;
  const items: Array<Omit<PriceSheetRow, "id">> = [];
  for (let i = 0; i < rawItems.length; i++) {
    const result = validateBackupItem(rawItems[i], i);
    if (!result.ok) {
      return { ok: false, reason: `${result.reason} This backup may be corrupted — nothing was restored.` };
    }
    items.push(result.value);
  }
  return { ok: true, items };
}

// Browser-only (uses document/Blob/URL) — kept separate from
// parsePriceSheetBackup/buildPriceSheetBackup above so those stay plain,
// environment-free functions a test can call directly with no DOM.
export function downloadPriceSheetBackup(rows: PriceSheetRow[]): void {
  const backup = buildPriceSheetBackup(rows);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `price-sheet-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
