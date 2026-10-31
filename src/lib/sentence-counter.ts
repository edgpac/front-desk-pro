// Counts sentences in customer-facing reply text — the deterministic
// backbone of a future reply-drafting feature's two-sentence maximum. Not
// a real NLP tokenizer: it treats '.', '!', and '?' as sentence-enders,
// but deliberately does NOT split on:
// - a decimal point between two digits ("$75.50", "3.5 hours")
// - a known single-word abbreviation's period (Dr., Sra., Lic., Mr., etc.)
// - a protected multi-part abbreviation (a.m., p.m., e.g., i.e.)
// Consecutive end-punctuation ("?!", "...") counts as ONE boundary, not
// several. Works across English and Spanish. Ported from Cabos Chat's
// reference implementation (src/core/sentence-counter.ts there) — zero
// dependencies, unchanged behavior.

const PROTECTED_MULTI_DOT = [/\ba\.m\./gi, /\bp\.m\./gi, /\be\.g\./gi, /\bi\.e\./gi];

const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "sra",
  "srta",
  "lic",
  "ing",
  "vs",
  "etc",
  "approx",
  "jr",
]);

const MASK_CHAR = "\u0000";
const END_PUNCTUATION = new Set(["!", "?", ".", MASK_CHAR]);

function maskProtectedPatterns(text: string): string {
  let masked = text;
  for (const pattern of PROTECTED_MULTI_DOT) {
    masked = masked.replace(pattern, (match) => match.replace(/\./g, MASK_CHAR));
  }
  return masked;
}

export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;

  const masked = maskProtectedPatterns(trimmed);
  let count = 0;
  let i = 0;

  while (i < masked.length) {
    const ch = masked[i];

    if (ch === "!" || ch === "?") {
      count++;
      while (i < masked.length && END_PUNCTUATION.has(masked[i]!)) i++;
      continue;
    }

    if (ch === ".") {
      const prevChar = masked[i - 1];
      const nextChar = masked[i + 1];
      const isDecimal =
        prevChar !== undefined &&
        /\d/.test(prevChar) &&
        nextChar !== undefined &&
        /\d/.test(nextChar);
      const wordBefore = (masked.slice(0, i).match(/[A-Za-zÀ-ÿ]+$/)?.[0] ?? "").toLowerCase();
      const isAbbreviation = ABBREVIATIONS.has(wordBefore);

      if (!isDecimal && !isAbbreviation) {
        count++;
        while (i < masked.length && END_PUNCTUATION.has(masked[i]!)) i++;
        continue;
      }
    }

    i++;
  }

  // Real content with no terminal punctuation at all ("Gracias", "Sure")
  // is still exactly one sentence, not zero.
  return count === 0 ? 1 : count;
}
