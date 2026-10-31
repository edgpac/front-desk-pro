// Best-effort PII redaction, applied to imported conversation text
// before it is ever sent to an AI provider for profile generation. This
// is explicitly NOT a guarantee: regex patterns cannot reliably catch
// every phone number, email, or address format across languages and
// conventions, and nothing here attempts named-entity recognition.
// Redaction is intentionally NOT applied to the owner-facing import
// preview — the owner is reviewing their own data under their own
// tenant's isolation, and showing them a mangled version of their own
// conversation would make review harder, not safer. It is applied only
// at the point text leaves this system for a third-party AI call.
//
// Adapted from the reference implementation's core/redaction.ts
// (read-only reference at ~/Downloads/cabos-chat, untouched by this
// work) — rewritten here, not copied.

export type RedactionMatch = {
  kind: "phone" | "email" | "address";
  original: string;
  start: number;
  end: number;
};

// Phone numbers: an optional country code and/or area code, followed by
// a required two-group core (3-4 digits, a separator, 3-4 digits — e.g.
// "555-0110"). The leading (?<!\$) excludes a match starting right after
// a dollar sign, so a price range like "$120-250" is never mangled into
// "$[REDACTED PHONE]" — a predictable shape in a pricing conversation,
// not a rare edge case.
const PHONE_PATTERN =
  /(?<!\$)(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])?\d{3,4}[\s.-]?\d{3,4}\b/g;

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Heuristic only, and intentionally bilingual in both word orders:
// English addresses put the number first and the street-type word last
// ("123 Main Street"); Spanish addresses conventionally put the
// street-type word first and the number last ("Calle Janette Wilson
// 45"). Will still miss addresses with no recognizable street-type word.
const STREET_TYPES =
  "St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Calle|Avenida|Camino|Carretera";
const WORD = "[A-Za-zÀ-ÿ0-9.'-]+";
const ADDRESS_PATTERN = new RegExp(
  `\\b(?:` +
    `\\d{1,6}\\s+${WORD}(?:\\s+${WORD}){0,4}\\s+(?:${STREET_TYPES})\\b\\.?` +
    `|` +
    `(?:${STREET_TYPES})\\s+${WORD}(?:\\s+${WORD}){0,4}\\s+\\d{1,6}\\b` +
    `)`,
  "g",
);

function findMatches(
  text: string,
  pattern: RegExp,
  kind: RedactionMatch["kind"],
): RedactionMatch[] {
  const matches: RedactionMatch[] = [];
  for (const m of text.matchAll(pattern)) {
    if (m.index === undefined) continue;
    matches.push({ kind, original: m[0], start: m.index, end: m.index + m[0].length });
  }
  return matches;
}

// Later patterns in this list never override an earlier match that
// already covers the same span — email addresses can contain digit
// sequences that would otherwise also match the phone pattern, so email
// is checked first and its spans are protected.
export function redactText(text: string): { redacted: string; matches: RedactionMatch[] } {
  const emailMatches = findMatches(text, EMAIL_PATTERN, "email");
  const addressMatches = findMatches(text, ADDRESS_PATTERN, "address");
  const phoneMatchesRaw = findMatches(text, PHONE_PATTERN, "phone");

  const taken: Array<[number, number]> = [
    ...emailMatches.map((m): [number, number] => [m.start, m.end]),
    ...addressMatches.map((m): [number, number] => [m.start, m.end]),
  ];
  const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
  const phoneMatches = phoneMatchesRaw.filter(
    (m) => !taken.some((t) => overlaps(t, [m.start, m.end])),
  );

  const all = [...emailMatches, ...addressMatches, ...phoneMatches].sort(
    (a, b) => a.start - b.start,
  );

  let redacted = "";
  let cursor = 0;
  for (const match of all) {
    if (match.start < cursor) continue; // defensive: skip any residual overlap
    redacted += text.slice(cursor, match.start);
    redacted += `[REDACTED ${match.kind.toUpperCase()}]`;
    cursor = match.end;
  }
  redacted += text.slice(cursor);

  return { redacted, matches: all };
}
