import { describe, expect, it } from "vitest";
import { redactText } from "./whatsapp-redaction";

describe("redactText", () => {
  it("redacts a phone number", () => {
    const { redacted, matches } = redactText("Call me at 555-0110 tomorrow.");
    expect(redacted).toBe("Call me at [REDACTED PHONE] tomorrow.");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.kind).toBe("phone");
  });

  it("redacts an email address", () => {
    const { redacted } = redactText("Reach me at jane@example.com please.");
    expect(redacted).toBe("Reach me at [REDACTED EMAIL] please.");
  });

  it("redacts an English-style street address", () => {
    const { redacted } = redactText("I live at 123 Main Street, apt 4.");
    expect(redacted).toContain("[REDACTED ADDRESS]");
    expect(redacted).not.toContain("123 Main Street");
  });

  it("redacts a Spanish-style street address (street-type word first)", () => {
    const { redacted } = redactText("Mi dirección es Calle Janette Wilson 45.");
    expect(redacted).toContain("[REDACTED ADDRESS]");
    expect(redacted).not.toContain("Janette Wilson 45");
  });

  it("does NOT mangle a price range that looks like a phone number ($120-250)", () => {
    const { redacted } = redactText("The job costs $120-250 depending on parts.");
    expect(redacted).toBe("The job costs $120-250 depending on parts.");
  });

  it("does not double-redact a phone-shaped digit sequence inside an email address", () => {
    const { redacted, matches } = redactText("Email me at 5550110jane@example.com now.");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.kind).toBe("email");
    expect(redacted).toBe("Email me at [REDACTED EMAIL] now.");
  });

  it("leaves ordinary text with no PII completely unchanged", () => {
    const text = "Sure, I can come by tomorrow afternoon to take a look.";
    const { redacted, matches } = redactText(text);
    expect(redacted).toBe(text);
    expect(matches).toHaveLength(0);
  });

  it("redacts multiple distinct PII items in the same message", () => {
    const { redacted, matches } = redactText("Call 555-0110 or email jane@example.com.");
    expect(matches).toHaveLength(2);
    expect(redacted).toBe("Call [REDACTED PHONE] or email [REDACTED EMAIL].");
  });

  it("handles empty input", () => {
    const { redacted, matches } = redactText("");
    expect(redacted).toBe("");
    expect(matches).toHaveLength(0);
  });
});
