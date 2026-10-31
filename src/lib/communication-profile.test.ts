import { describe, expect, it } from "vitest";
import { formatCommunicationProfile } from "./communication-profile";
import type { CommunicationProfile, ProfileFieldValue } from "./communication-profile";

function strField(
  value: string,
  overrides: Partial<ProfileFieldValue<string>> = {},
): ProfileFieldValue<string> {
  return { value, source: "ai_observed", confidence: "high", evidence: [], ...overrides };
}

describe("formatCommunicationProfile", () => {
  it("reports no fields set for a fully empty profile", () => {
    expect(formatCommunicationProfile({})).toBe("(this profile has no fields set)");
  });

  it("formats a string field with its source and confidence", () => {
    const profile: CommunicationProfile = {
      toneAndStyle: strField("friendly and casual", { source: "owner_stated" }),
    };
    const output = formatCommunicationProfile(profile);
    expect(output).toContain("Tone and style: friendly and casual");
    expect(output).toContain("owner-stated, confidence: high");
  });

  it("includes evidence message ids when present", () => {
    const profile: CommunicationProfile = {
      greetingStyle: strField("Uses the customer's first name", {
        source: "ai_observed",
        evidence: [{ messageId: "11111111-1111-1111-1111-111111111111" }],
      }),
    };
    const output = formatCommunicationProfile(profile);
    expect(output).toContain("evidence: msg #11111111-1111-1111-1111-111111111111");
  });

  it("omits the evidence suffix when there is none", () => {
    const profile: CommunicationProfile = {
      toneAndStyle: strField("formal", { source: "owner_stated" }),
    };
    expect(formatCommunicationProfile(profile)).not.toContain("evidence:");
  });

  it("formats a list field with one bullet per item", () => {
    const profile: CommunicationProfile = {
      prohibitedClaims: {
        value: ["never guarantee a same-day appointment", "never quote a price sight-unseen"],
        source: "ai_suggested",
        confidence: "medium",
        evidence: [],
      },
    };
    const output = formatCommunicationProfile(profile);
    expect(output).toContain("Prohibited claims:");
    expect(output).toContain("  - never guarantee a same-day appointment");
    expect(output).toContain("  - never quote a price sight-unseen");
    expect(output).toContain("AI suggestion — review before relying on this");
  });

  it("includes general notes when present, and omits the line when absent", () => {
    const withNotes = formatCommunicationProfile({
      generalNotes: "Responds quickly in the mornings.",
    });
    expect(withNotes).toContain("General notes: Responds quickly in the mornings.");

    const withoutNotes = formatCommunicationProfile({ toneAndStyle: strField("casual") });
    expect(withoutNotes).not.toContain("General notes:");
  });

  it("only renders fields that are actually set, in the fixed field order", () => {
    const profile: CommunicationProfile = {
      businessPoliciesAndBoundaries: strField("Standard policy text"),
      toneAndStyle: strField("casual"),
    };
    const output = formatCommunicationProfile(profile);
    const toneIndex = output.indexOf("Tone and style");
    const policiesIndex = output.indexOf("Business policies and boundaries");
    expect(toneIndex).toBeGreaterThanOrEqual(0);
    expect(policiesIndex).toBeGreaterThan(toneIndex);
    expect(output).not.toContain("Greeting style");
  });
});
