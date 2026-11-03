import { describe, expect, it } from "vitest";
import {
  assessImportPreview,
  describeDeletionImpact,
  pluralize,
  profileVersionStatusLabel,
  roleLabel,
} from "./jir-chat-ui";
import type { WhatsAppImportPreview } from "./whatsapp-import-server";

function preview(overrides: Partial<WhatsAppImportPreview> = {}): WhatsAppImportPreview {
  return {
    contentHash: "hash",
    alreadyImported: false,
    messageCount: 3,
    systemCount: 0,
    unparseableCount: 0,
    ambiguousDateCount: 0,
    dateRange: { start: null, end: null },
    warnings: [],
    participantLabels: ["Jane Owner", "Bob Customer"],
    resolvedRoles: { "Jane Owner": "owner", "Bob Customer": "customer" },
    ownerIdentityMatched: true,
    ...overrides,
  };
}

describe("assessImportPreview", () => {
  it("allows confirming a clean, fully-resolved preview", () => {
    const result = assessImportPreview(preview());
    expect(result.canConfirm).toBe(true);
    expect(result.blockingReason).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("blocks confirming an already-imported export", () => {
    const result = assessImportPreview(preview({ alreadyImported: true }));
    expect(result.canConfirm).toBe(false);
    expect(result.blockingReason).toContain("already been imported");
  });

  it("blocks confirming an export with no usable messages", () => {
    const result = assessImportPreview(preview({ messageCount: 0 }));
    expect(result.canConfirm).toBe(false);
    expect(result.blockingReason).toContain("No usable messages");
  });

  it("still allows confirming when identity didn't match, but surfaces a prominent warning — never silently guesses", () => {
    const result = assessImportPreview(
      preview({
        ownerIdentityMatched: false,
        resolvedRoles: { "Jane Owner": "unknown", "Bob Customer": "unknown" },
      }),
    );
    expect(result.canConfirm).toBe(true);
    expect(result.warnings[0]).toContain("None of your configured WhatsApp identities matched");
  });

  it("warns about unresolved (unknown-role) participants even when identity otherwise matched", () => {
    const result = assessImportPreview(
      preview({
        resolvedRoles: { "Jane Owner": "owner", Bob: "unknown", Alice: "unknown" },
      }),
    );
    expect(result.canConfirm).toBe(true);
    expect(result.warnings.some((w) => w.includes("could not be identified"))).toBe(true);
  });

  it("preserves parser warnings alongside any identity warning", () => {
    const result = assessImportPreview(
      preview({ warnings: ["1 message(s) have an ambiguous date"] }),
    );
    expect(result.warnings).toContain("1 message(s) have an ambiguous date");
  });
});

describe("roleLabel", () => {
  it("maps each role to an owner-facing label", () => {
    expect(roleLabel("owner")).toBe("You");
    expect(roleLabel("customer")).toBe("Customer");
    expect(roleLabel("unknown")).toBe("Unknown");
  });
});

describe("profileVersionStatusLabel", () => {
  it("maps every status to a distinct, understandable label", () => {
    expect(profileVersionStatusLabel("pending")).toContain("review");
    expect(profileVersionStatusLabel("approved")).toBe("Active");
    expect(profileVersionStatusLabel("archived")).toContain("newer");
    expect(profileVersionStatusLabel("rejected")).toBe("Rejected");
  });
});

describe("describeDeletionImpact", () => {
  it("never claims backups or logs are purged, regardless of impact", () => {
    expect(describeDeletionImpact([])).toContain("does not remove anything from database backups");
    expect(describeDeletionImpact([1, 2])).toContain(
      "does not remove anything from database backups",
    );
  });

  it("states plainly when no profile was built from this import", () => {
    const text = describeDeletionImpact([]);
    expect(text).toContain("No existing communication profile was generated");
  });

  it("names the exact affected version(s) and states they are NOT rewritten", () => {
    const text = describeDeletionImpact([2]);
    expect(text).toContain("version 2");
    expect(text).toContain("was generated partly from this import's messages");
    expect(text).toContain("will NOT change or remove");
  });

  it("uses correct plural grammar for multiple affected versions", () => {
    const text = describeDeletionImpact([1, 3, 5]);
    expect(text).toContain("versions 1, 3, 5");
    expect(text).toContain("were generated");
    expect(text).toContain("they may still contain");
  });
});

describe("pluralize", () => {
  it("pluralizes correctly at the boundary", () => {
    expect(pluralize(1, "message")).toBe("1 message");
    expect(pluralize(0, "message")).toBe("0 messages");
    expect(pluralize(2, "message")).toBe("2 messages");
  });
});
