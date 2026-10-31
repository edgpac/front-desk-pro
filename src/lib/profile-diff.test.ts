import { describe, expect, it } from "vitest";
import { diffCommunicationProfiles, formatProfileDiff } from "./profile-diff";
import type { ProfileFieldValue } from "./communication-profile";

function strField(value: string): ProfileFieldValue<string> {
  return {
    value,
    source: "ai_observed",
    confidence: "high",
    evidence: [{ messageId: "11111111-1111-1111-1111-111111111111" }],
  };
}

describe("diffCommunicationProfiles", () => {
  it("reports no changes when active is null and draft is empty", () => {
    const diff = diffCommunicationProfiles(null, {});
    expect(diff.hasChanges).toBe(false);
  });

  it("marks a field present only in the draft as added", () => {
    const diff = diffCommunicationProfiles(null, { toneAndStyle: strField("friendly") });
    const f = diff.fields.find((f) => f.key === "toneAndStyle")!;
    expect(f.kind).toBe("added");
    expect(f.newValue).toBe("friendly");
    expect(diff.hasChanges).toBe(true);
  });

  it("marks a field present only in the active profile (absent from the draft) as removed", () => {
    const diff = diffCommunicationProfiles({ toneAndStyle: strField("friendly") }, {});
    const f = diff.fields.find((f) => f.key === "toneAndStyle")!;
    expect(f.kind).toBe("removed");
    expect(f.oldValue).toBe("friendly");
  });

  it("marks a field whose value differs as changed", () => {
    const diff = diffCommunicationProfiles(
      { toneAndStyle: strField("formal") },
      { toneAndStyle: strField("casual") },
    );
    const f = diff.fields.find((f) => f.key === "toneAndStyle")!;
    expect(f.kind).toBe("changed");
    expect(f.oldValue).toBe("formal");
    expect(f.newValue).toBe("casual");
  });

  it("marks a field with the identical value as unchanged even if source/confidence differ", () => {
    const diff = diffCommunicationProfiles(
      {
        toneAndStyle: {
          value: "friendly",
          source: "owner_stated",
          confidence: "high",
          evidence: [],
        },
      },
      {
        toneAndStyle: {
          value: "friendly",
          source: "ai_observed",
          confidence: "medium",
          evidence: [{ messageId: "11111111-1111-1111-1111-111111111111" }],
        },
      },
    );
    const f = diff.fields.find((f) => f.key === "toneAndStyle")!;
    expect(f.kind).toBe("unchanged");
    expect(diff.hasChanges).toBe(false);
  });

  it("diffs list fields by their array contents", () => {
    const diff = diffCommunicationProfiles(
      {
        prohibitedClaims: {
          value: ["never guarantee same-day"],
          source: "ai_suggested",
          confidence: "medium",
          evidence: [],
        },
      },
      {
        prohibitedClaims: {
          value: ["never guarantee same-day", "never quote sight-unseen"],
          source: "ai_suggested",
          confidence: "medium",
          evidence: [],
        },
      },
    );
    const f = diff.fields.find((f) => f.key === "prohibitedClaims")!;
    expect(f.kind).toBe("changed");
  });

  it("detects a generalNotes change independently of field changes", () => {
    const diff = diffCommunicationProfiles(
      { generalNotes: "old note" },
      { generalNotes: "new note" },
    );
    expect(diff.generalNotesChanged).toBe(true);
    expect(diff.hasChanges).toBe(true);
  });
});

describe("formatProfileDiff", () => {
  it("says there are no differences when nothing changed", () => {
    const diff = diffCommunicationProfiles(null, {});
    expect(formatProfileDiff(diff)).toContain("No differences");
  });

  it("omits unchanged fields from the rendered output", () => {
    const diff = diffCommunicationProfiles(
      { toneAndStyle: strField("friendly") },
      { toneAndStyle: strField("friendly") },
    );
    expect(formatProfileDiff(diff)).not.toContain("Tone and style");
  });

  it("renders an added field with a + marker", () => {
    const diff = diffCommunicationProfiles(null, { toneAndStyle: strField("friendly") });
    expect(formatProfileDiff(diff)).toContain("+ Tone and style");
  });
});
