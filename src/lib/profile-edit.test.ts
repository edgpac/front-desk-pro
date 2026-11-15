import { describe, expect, it } from "vitest";
import { applyOwnerFieldEdit, fieldEditText } from "./profile-edit";
import type { CommunicationProfile } from "./communication-profile";

const BASE: CommunicationProfile = {
  businessDescription: {
    value: "Mayel AC Tech fixes things.",
    source: "ai_observed",
    confidence: "high",
    evidence: [{ messageId: "m1" }],
  },
  preferredLanguages: {
    value: ["English", "Spanish"],
    source: "ai_observed",
    confidence: "high",
    evidence: [{ messageId: "m2" }],
  },
  generalNotes: { value: "Old note", source: "ai_observed", confidence: "low", evidence: [] },
};

describe("applyOwnerFieldEdit", () => {
  it("replaces a string field with owner-stated text and no AI evidence", () => {
    const next = applyOwnerFieldEdit(
      BASE,
      "businessDescription",
      "  Cabos Handyman fixes things.  ",
    );
    expect(next.businessDescription).toEqual({
      value: "Cabos Handyman fixes things.",
      source: "owner_stated",
      confidence: "high",
      evidence: [],
    });
  });

  it("splits a list field one item per line, dropping blank lines", () => {
    const next = applyOwnerFieldEdit(BASE, "preferredLanguages", "Spanish\n\n English \n");
    expect(next.preferredLanguages?.value).toEqual(["Spanish", "English"]);
    expect(next.preferredLanguages?.source).toBe("owner_stated");
  });

  it("removes a field when the edited text is empty", () => {
    const next = applyOwnerFieldEdit(BASE, "businessDescription", "   ");
    expect("businessDescription" in next).toBe(false);
  });

  it("stores edited general notes as a plain owner-authored string", () => {
    expect(applyOwnerFieldEdit(BASE, "generalNotes", "New note").generalNotes).toBe("New note");
  });

  it("never mutates the original profile", () => {
    const snapshot = JSON.parse(JSON.stringify(BASE));
    applyOwnerFieldEdit(BASE, "businessDescription", "Changed");
    applyOwnerFieldEdit(BASE, "preferredLanguages", "");
    expect(BASE).toEqual(snapshot);
  });
});

describe("fieldEditText", () => {
  it("renders list fields one item per line and string fields as-is", () => {
    expect(fieldEditText(BASE, "preferredLanguages")).toBe("English\nSpanish");
    expect(fieldEditText(BASE, "businessDescription")).toBe("Mayel AC Tech fixes things.");
    expect(fieldEditText(BASE, "generalNotes")).toBe("Old note");
    expect(fieldEditText({}, "toneAndStyle")).toBe("");
  });
});
