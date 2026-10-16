import { describe, expect, it } from "vitest";
import { csvField } from "./leads-server";

// Regression test for the 2026-10 security audit (Part 1, area 5): every
// field exportMyLeadsCsv writes into a cell is customer-supplied (a public
// lead form or a WhatsApp message), never validated against a safe-character
// set. A value starting with =, +, -, or @ is a classic CSV/formula-injection
// vector (CWE-1236) — Excel/Google Sheets would evaluate it as a formula the
// moment the business owner opens the exported file. csvField must neutralize
// that leading character before applying its existing comma/quote/newline
// escaping.
describe("csvField", () => {
  it("passes plain text through unchanged", () => {
    expect(csvField("John Smith")).toBe("John Smith");
  });

  it("quotes a value containing a comma", () => {
    expect(csvField("123 Main St, Apt 4")).toBe('"123 Main St, Apt 4"');
  });

  it("neutralizes a leading = (formula injection)", () => {
    expect(csvField("=cmd|'/C calc'!A1")).toBe("'=cmd|'/C calc'!A1");
  });

  it("neutralizes a leading + and still quotes if it also needs quoting", () => {
    expect(csvField("+1,234")).toBe('"\'+1,234"');
  });

  it("neutralizes a leading - ", () => {
    expect(csvField("-2+3")).toBe("'-2+3");
  });

  it("neutralizes a leading @", () => {
    expect(csvField("@SUM(A1:A9)")).toBe("'@SUM(A1:A9)");
  });

  it("does not touch a value where = appears mid-string, not leading", () => {
    expect(csvField("5=5 is true")).toBe("5=5 is true");
  });
});
