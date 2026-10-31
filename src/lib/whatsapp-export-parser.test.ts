import { describe, expect, it } from "vitest";
import { parseWhatsAppExport } from "./whatsapp-export-parser";

describe("parseWhatsAppExport", () => {
  it("parses the iOS bracketed format with a sender and seconds", () => {
    const result = parseWhatsAppExport("[3/4/25, 2:31:09 PM] Jane Customer: Hi, is anyone there?");
    expect(result.messageCount).toBe(1);
    expect(result.entries[0]).toMatchObject({
      kind: "message",
      senderLabel: "Jane Customer",
      body: "Hi, is anyone there?",
    });
  });

  it("parses the Android dash format without seconds", () => {
    const result = parseWhatsAppExport("3/4/25, 2:31 PM - Jane Customer: Hi, is anyone there?");
    expect(result.messageCount).toBe(1);
    expect(result.entries[0]?.senderLabel).toBe("Jane Customer");
  });

  it("folds a continuation line (no timestamp) into the previous message's body", () => {
    const result = parseWhatsAppExport(
      "[3/4/25, 2:31:09 PM] Jane Customer: First line\nstill the same message",
    );
    expect(result.messageCount).toBe(1);
    expect(result.entries[0]?.body).toBe("First line\nstill the same message");
  });

  it("detects a system notification and gives it no sender label", () => {
    const result = parseWhatsAppExport(
      "[3/4/25, 2:31:09 PM] Messages and calls are end-to-end encrypted.",
    );
    expect(result.systemCount).toBe(1);
    expect(result.messageCount).toBe(0);
    expect(result.entries[0]?.senderLabel).toBeNull();
  });

  it("detects a media placeholder", () => {
    const result = parseWhatsAppExport("[3/4/25, 2:31:09 PM] Jane Customer: <Media omitted>");
    expect(result.entries[0]?.isMediaPlaceholder).toBe(true);
  });

  it("flags an unrecognized leading line as unparseable rather than dropping it", () => {
    const result = parseWhatsAppExport("this is not a WhatsApp export at all");
    expect(result.unparseableCount).toBe(1);
    expect(result.warnings.some((w) => w.includes("Line 1"))).toBe(true);
  });

  it("marks an ambiguous day/month date and records a warning", () => {
    const result = parseWhatsAppExport("[3/4/25, 2:31:09 PM] Jane Customer: hello");
    expect(result.ambiguousDateCount).toBe(1);
    expect(result.entries[0]?.dateAmbiguous).toBe(true);
    expect(result.warnings.some((w) => w.includes("ambiguous"))).toBe(true);
  });

  it("resolves an unambiguous day-first date correctly regardless of preferDayFirst", () => {
    // day=25 can only be a day, never a month.
    const result = parseWhatsAppExport("[25/4/25, 2:31:09 PM] Jane Customer: hello");
    expect(result.entries[0]?.dateAmbiguous).toBe(false);
    expect(result.entries[0]?.occurredAt).toBe("2025-04-25T14:31:09");
  });

  it("respects preferDayFirst for a genuinely ambiguous date", () => {
    const dayFirst = parseWhatsAppExport("[3/4/25, 2:31:09 PM] Jane Customer: hello", {
      preferDayFirst: true,
    });
    const monthFirst = parseWhatsAppExport("[3/4/25, 2:31:09 PM] Jane Customer: hello", {
      preferDayFirst: false,
    });
    expect(dayFirst.entries[0]?.occurredAt).toBe("2025-04-03T14:31:09");
    expect(monthFirst.entries[0]?.occurredAt).toBe("2025-03-04T14:31:09");
  });

  it("collects unique participant labels in first-seen order", () => {
    const result = parseWhatsAppExport(
      [
        "[1/1/25, 9:00:00 AM] Jane Customer: hi",
        "[1/1/25, 9:01:00 AM] The Business: hello",
        "[1/1/25, 9:02:00 AM] Jane Customer: thanks",
      ].join("\n"),
    );
    expect(result.participantLabels).toEqual(["Jane Customer", "The Business"]);
  });

  it("computes the date range across all parsed timestamps", () => {
    // 15 can only be a day (>12), so these are unambiguous month-first reads.
    const result = parseWhatsAppExport(
      ["[1/1/25, 9:00:00 AM] A: hi", "[15/1/25, 9:00:00 AM] A: bye"].join("\n"),
    );
    expect(result.dateRange.start).toBe("2025-01-01T09:00:00");
    expect(result.dateRange.end).toBe("2025-01-15T09:00:00");
  });

  it("strips a leading BOM and invisible LTR/RTL marks without corrupting sender labels", () => {
    const result = parseWhatsAppExport("﻿[3/4/25, 2:31:09 PM] ‎Jane Customer: hi");
    expect(result.entries[0]?.senderLabel).toBe("Jane Customer");
  });

  it("returns an empty, well-formed result for empty input", () => {
    const result = parseWhatsAppExport("");
    expect(result.messageCount).toBe(0);
    expect(result.entries).toHaveLength(0);
    expect(result.dateRange).toEqual({ start: null, end: null });
  });

  it("handles a 24-hour-time export with no AM/PM marker", () => {
    const result = parseWhatsAppExport("[3/4/25, 14:31:09] Jane Customer: hi");
    expect(result.entries[0]?.occurredAt).toBe("2025-03-04T14:31:09");
  });
});
