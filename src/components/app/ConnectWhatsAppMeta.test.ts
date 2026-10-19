import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Structural regression guard for the WhatsApp-connect consent gate — same
// source-text-matching approach whatsapp-conversation-server.test.ts
// already uses for its "every send goes through the guard" check, chosen
// here specifically because this codebase has no component-level test
// infrastructure (@testing-library/react, jsdom/happy-dom) at all yet —
// see the dedicated consent review this guards against regressing. This
// doesn't render anything or simulate a click; it proves the SOURCE still
// has the shape the review required, which is enough to catch the
// realistic failure mode (someone accidentally wiring the outer button
// straight to handleConnect, or dropping the consent-version argument).
const sourcePath = fileURLToPath(new URL("./ConnectWhatsAppMeta.tsx", import.meta.url));
const source = readFileSync(sourcePath, "utf-8");

describe("ConnectWhatsAppMeta — consent gate structural guard", () => {
  it("calls handleConnect() in exactly one place — the dialog's Continue button, never the outer Connect button directly", () => {
    // "handleConnect();" (a real call, trailing semicolon) vs.
    // "function handleConnect() {" (the definition, trailing brace) —
    // this pattern matches only the former.
    const matches = source.match(/handleConnect\(\);/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("the Continue button is still disabled until the acknowledgment checkbox is checked", () => {
    expect(source).toContain("disabled={!guideAcknowledged}");
  });

  it("the checkbox resets when the dialog is closed, so a prior acknowledgment never carries over to a later attempt", () => {
    expect(source).toMatch(/if \(!open\) setGuideAcknowledged\(false\)/);
  });

  it("the consent notice version is actually sent to completeMetaWhatsAppSignup, not just displayed", () => {
    expect(source).toContain("consentNoticeVersion: WHATSAPP_CONSENT_NOTICE_VERSION");
  });

  it("imports the shared consent notice version rather than a locally re-declared one", () => {
    expect(source).toMatch(/import\s*{[^}]*WHATSAPP_CONSENT_NOTICE_VERSION[^}]*}\s*from\s*"@\/components\/app\/WhatsAppSetupGuide"/);
  });
});

describe("WhatsAppSetupGuideContent — data-processing disclosure structural guard", () => {
  const guideSourcePath = fileURLToPath(new URL("./WhatsAppSetupGuide.tsx", import.meta.url));
  const guideSource = readFileSync(guideSourcePath, "utf-8");

  it("exports a WHATSAPP_CONSENT_NOTICE_VERSION constant", () => {
    expect(guideSource).toMatch(/export const WHATSAPP_CONSENT_NOTICE_VERSION\s*=\s*"[^"]+"/);
  });

  it("names Meta and Anthropic explicitly in the disclosure text, not just generically", () => {
    expect(guideSource).toContain("Meta's WhatsApp Business Platform");
    expect(guideSource).toContain("Anthropic's Claude API");
  });

  it("links to the real Privacy Policy route, not plain text claiming one exists", () => {
    expect(guideSource).toMatch(/<Link\s+to="\/privacy"/);
  });
});
