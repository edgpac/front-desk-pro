// Pure math for the "convert my price sheet" action on Business
// Settings — no network calls, no React. Deliberately does NOT fetch a
// live exchange rate: the owner types in the rate themselves, which
// keeps this self-contained (no new external dependency/failure mode)
// and matches the actual design decision — every conversion is an
// explicit, owner-reviewed action, never something the system decides
// to do or fetches on its own. Composes with the EXISTING
// listMyPriceSheet/saveMyPriceSheet/updateMyTenant server functions
// (see dashboard.settings.business.tsx) rather than introducing new
// server-side persistence or validation logic that would duplicate
// what those already do and already have tested.

import type { PriceSheetRow } from "./mock-data";

// Rounds to the nearest whole unit — matches how prices are already
// DISPLAYED everywhere (money() uses maximumFractionDigits: 0), and is
// the simplest, most predictable default; the owner adjusts the RATE
// before converting (e.g. padding it) rather than being offered a
// separate per-item rounding knob, which would be a second thing to
// configure for little real benefit at typical service-business price
// points.
export function convertAmount(amount: number, rate: number): number {
  return Math.round(amount * rate);
}

export function isValidConversionRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > 0;
}

export type PriceConversionPreviewItem = {
  id: string;
  task: string;
  currentPriceMin: number;
  currentPriceMax: number;
  newPriceMin: number;
  newPriceMax: number;
  currentDiagnosisFee: number | null;
  newDiagnosisFee: number | null;
};

export function buildPriceSheetConversionPreview(
  items: PriceSheetRow[],
  rate: number,
): PriceConversionPreviewItem[] {
  return items.map((item) => ({
    id: item.id,
    task: item.task,
    currentPriceMin: item.priceMin,
    currentPriceMax: item.priceMax,
    newPriceMin: convertAmount(item.priceMin, rate),
    newPriceMax: convertAmount(item.priceMax, rate),
    currentDiagnosisFee: item.diagnosisFee?.amount ?? null,
    newDiagnosisFee: item.diagnosisFee ? convertAmount(item.diagnosisFee.amount, rate) : null,
  }));
}

// Returns a full replacement item list with every price-bearing field
// converted — intended to be passed straight to the existing
// saveMyPriceSheet (which already does a full-replace save), so no new
// write path is introduced for price-sheet persistence.
export function applyConversionToPriceSheet(items: PriceSheetRow[], rate: number): PriceSheetRow[] {
  return items.map((item) => ({
    ...item,
    priceMin: convertAmount(item.priceMin, rate),
    priceMax: convertAmount(item.priceMax, rate),
    diagnosisFee: item.diagnosisFee
      ? { ...item.diagnosisFee, amount: convertAmount(item.diagnosisFee.amount, rate) }
      : null,
  }));
}

export function convertLaborRateAndFee(
  laborRate: number,
  serviceCallFee: number,
  rate: number,
): { laborRate: number; serviceCallFee: number } {
  return {
    laborRate: convertAmount(laborRate, rate),
    serviceCallFee: convertAmount(serviceCallFee, rate),
  };
}
