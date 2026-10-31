// Parses WhatsApp's plain-text "Export Chat" format. There is no official
// spec for this format and it drifts across iOS/Android and app versions,
// so this is a best-effort, heuristic parser over the variants actually
// seen in the wild. It is deliberately conservative: anything it cannot
// confidently interpret is surfaced as a warning, never silently dropped
// and never guessed at without saying so.
//
// Adapted from the reference implementation at
// ~/Downloads/cabos-chat/src/core/parser/whatsapp-export.ts (read-only
// reference; that project is untouched by this work) — rewritten here,
// not copied, since this module has no dependency on or shared code with
// that standalone project.
//
// Pure and synchronous: no I/O, no database, no AI calls. Every function
// here is directly unit-testable with plain string input.

export type WhatsAppParticipantRole = "owner" | "customer" | "unknown";

export type ParsedWhatsAppEntry = {
  lineNumber: number;
  kind: "message" | "system" | "unparseable";
  // null for a system notification (WhatsApp never attributes those to a
  // sender) and for an unparseable line.
  senderLabel: string | null;
  // ISO 8601 local time (no timezone — exports never carry one), or null
  // when no timestamp could be read for this line at all.
  occurredAt: string | null;
  // true when a date like "03/04/25" was read but day/month order
  // genuinely can't be determined from this line alone (both candidate
  // values are <=12). occurredAt still holds a best guess so sorting
  // degrades gracefully, but that guess must never be treated as a fact.
  dateAmbiguous: boolean;
  body: string;
  isMediaPlaceholder: boolean;
};

export type ParseWhatsAppExportResult = {
  entries: ParsedWhatsAppEntry[];
  messageCount: number;
  systemCount: number;
  unparseableCount: number;
  ambiguousDateCount: number;
  // Unique sender labels, in first-seen order — a display aid only, never
  // a stable identifier (two people can share a label; the same person
  // can appear under different labels across exports).
  participantLabels: string[];
  dateRange: { start: string | null; end: string | null };
  warnings: string[];
};

const MEDIA_PLACEHOLDER_PATTERNS = [
  /^<media omitted>$/i,
  /^image omitted$/i,
  /^video omitted$/i,
  /^audio omitted$/i,
  /^document omitted$/i,
  /^sticker omitted$/i,
  /^gif omitted$/i,
  /^contact card omitted$/i,
  /^‎?<attached:.*>$/i,
];

function isMediaPlaceholder(body: string): boolean {
  const trimmed = body.trim();
  return MEDIA_PLACEHOLDER_PATTERNS.some((p) => p.test(trimmed));
}

// The two well-documented line-start shapes:
//   iOS:     [3/4/25, 2:31:09 PM] Sender Name: message
//   Android: 3/4/25, 2:31 PM - Sender Name: message
// The sender capture is optional — a system notification has no
// "Name: " prefix in either format.
const IOS_LINE =
  /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\]\s*(?:([^:]+?):\s)?(.*)$/;
const ANDROID_LINE =
  /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\s*-\s*(?:([^:]+?):\s)?(.*)$/;

type TimestampMatch = {
  a: number;
  b: number;
  year: number;
  hour: number;
  minute: number;
  second: number;
  meridiem: string | undefined;
  senderLabel: string | undefined;
  rest: string;
};

function tryMatch(line: string): TimestampMatch | null {
  for (const pattern of [IOS_LINE, ANDROID_LINE]) {
    const m = pattern.exec(line);
    if (!m) continue;
    const [, aStr, bStr, yearStr, hourStr, minuteStr, secondStr, meridiem, senderLabel, rest] = m;
    return {
      a: Number(aStr),
      b: Number(bStr),
      year: normalizeYear(yearStr!),
      hour: Number(hourStr),
      minute: Number(minuteStr),
      second: secondStr ? Number(secondStr) : 0,
      meridiem: meridiem?.replace(/\./g, "").toUpperCase(),
      senderLabel: senderLabel?.trim(),
      rest: rest ?? "",
    };
  }
  return null;
}

function normalizeYear(raw: string): number {
  if (raw.length === 4) return Number(raw);
  return 2000 + Number(raw);
}

function resolveTimestamp(
  m: TimestampMatch,
  preferDayFirst: boolean,
): { iso: string; ambiguous: boolean } {
  let month: number;
  let day: number;
  let ambiguous = false;
  if (m.a > 12 && m.b <= 12) {
    day = m.a;
    month = m.b;
  } else if (m.b > 12 && m.a <= 12) {
    month = m.a;
    day = m.b;
  } else if (m.a <= 12 && m.b <= 12) {
    if (preferDayFirst) {
      day = m.a;
      month = m.b;
    } else {
      month = m.a;
      day = m.b;
    }
    ambiguous = true;
  } else {
    month = Math.min(m.a, 12) || 1;
    day = Math.min(m.b, 31) || 1;
    ambiguous = true;
  }

  let hour24 = m.hour;
  if (m.meridiem === "PM" && m.hour !== 12) hour24 = m.hour + 12;
  if (m.meridiem === "AM" && m.hour === 12) hour24 = 0;

  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${m.year}-${pad(month)}-${pad(day)}T${pad(hour24)}:${pad(m.minute)}:${pad(m.second)}`;
  return { iso, ambiguous };
}

const SYSTEM_NOTIFICATION_HINTS = [
  /end-to-end encrypted/i,
  /^you (added|removed|created|changed|left)/i,
  /\bwas added\b/i,
  /\bwas removed\b/i,
  /changed (the subject|this group's icon|the group description)/i,
  /changed their phone number/i,
  /security code changed/i,
  /missed voice call/i,
  /missed video call/i,
];

function looksLikeSystemNotification(senderLabel: string | undefined, body: string): boolean {
  if (senderLabel) return false;
  return SYSTEM_NOTIFICATION_HINTS.some((p) => p.test(body));
}

export type ParseWhatsAppExportOptions = {
  // Defaults to false (month-first/MM-DD). Set true for an export known
  // to come from a day-first locale. Either way, dateAmbiguous is set on
  // affected entries so the guess is never treated as fact downstream.
  preferDayFirst?: boolean;
};

export function parseWhatsAppExport(
  content: string,
  options: ParseWhatsAppExportOptions = {},
): ParseWhatsAppExportResult {
  const preferDayFirst = options.preferDayFirst ?? false;
  const normalized = content.replace(/^\uFEFF/, "").replace(/[\u200e\u200f]/g, "");
  const rawLines = normalized.split(/\r\n|\r|\n/);

  const entries: ParsedWhatsAppEntry[] = [];
  const warnings: string[] = [];
  let current: ParsedWhatsAppEntry | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const lineNumber = i + 1;
    const rawLine = rawLines[i]!;
    if (rawLine.trim().length === 0) {
      if (current) current.body += "\n";
      continue;
    }

    const match = tryMatch(rawLine);
    if (match) {
      if (current) entries.push(current);
      const { iso, ambiguous } = resolveTimestamp(match, preferDayFirst);
      const isSystem = looksLikeSystemNotification(match.senderLabel, match.rest);
      current = {
        lineNumber,
        kind: isSystem ? "system" : "message",
        senderLabel: isSystem ? null : (match.senderLabel ?? null),
        occurredAt: iso,
        dateAmbiguous: ambiguous,
        body: match.rest,
        isMediaPlaceholder: isMediaPlaceholder(match.rest),
      };
      continue;
    }

    // No timestamp match: either a continuation line of a multiline
    // message, or — only when nothing has been seen yet — an
    // unrecognized line, surfaced rather than silently skipped.
    if (current) {
      current.body += (current.body.length > 0 ? "\n" : "") + rawLine;
    } else {
      entries.push({
        lineNumber,
        kind: "unparseable",
        senderLabel: null,
        occurredAt: null,
        dateAmbiguous: false,
        body: rawLine,
        isMediaPlaceholder: false,
      });
      warnings.push(
        `Line ${lineNumber}: couldn't match a known export format and isn't a continuation of a prior message.`,
      );
    }
  }
  if (current) entries.push(current);

  // Multiline bodies: re-check the media-placeholder flag once the full
  // body (including continuation lines) is assembled.
  for (const entry of entries) {
    if (entry.kind === "message") entry.isMediaPlaceholder = isMediaPlaceholder(entry.body);
  }

  const participantLabels: string[] = [];
  for (const entry of entries) {
    if (entry.senderLabel && !participantLabels.includes(entry.senderLabel)) {
      participantLabels.push(entry.senderLabel);
    }
  }

  const timestamps = entries
    .map((e) => e.occurredAt)
    .filter((t): t is string => t !== null)
    .sort();
  const ambiguousDateCount = entries.filter((e) => e.dateAmbiguous).length;

  if (ambiguousDateCount > 0) {
    const convention = preferDayFirst ? "DD/MM (day-first)" : "MM/DD (month-first)";
    warnings.unshift(
      `${ambiguousDateCount} message(s) have an ambiguous date where day and month can't be told apart (e.g. "03/04/25") — read as ${convention}.`,
    );
  }

  return {
    entries,
    messageCount: entries.filter((e) => e.kind === "message").length,
    systemCount: entries.filter((e) => e.kind === "system").length,
    unparseableCount: entries.filter((e) => e.kind === "unparseable").length,
    ambiguousDateCount,
    participantLabels,
    dateRange: {
      start: timestamps[0] ?? null,
      end: timestamps.at(-1) ?? null,
    },
    warnings,
  };
}
