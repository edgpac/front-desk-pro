// Pure presentation logic for the JIR Chat dashboard page — no React, no
// network calls, so it's directly unit-testable with plain vitest (this
// codebase has no component-rendering test infrastructure at all yet —
// no React Testing Library, no jsdom/happy-dom environment, zero
// existing .test.tsx files — so introducing one is a separate
// infrastructure decision this change doesn't make unilaterally;
// extracting the logic that actually decides what the page shows into
// here, and testing THAT, is the proportionate alternative).

import type { WhatsAppImportPreview } from "./whatsapp-import-server";
import type { ProfileVersionStatus } from "./communication-profile-server";

export type ImportPreviewAssessment = {
  canConfirm: boolean;
  blockingReason: string | null;
  warnings: string[];
};

// Decides whether the "Confirm import" action should be allowed, and
// what to tell the owner, from a preview result alone — never guesses
// past an ambiguous or unresolved identity; surfaces it instead.
export function assessImportPreview(preview: WhatsAppImportPreview): ImportPreviewAssessment {
  const warnings = [...preview.warnings];

  if (preview.alreadyImported) {
    return {
      canConfirm: false,
      blockingReason: "This exact conversation has already been imported for this business.",
      warnings,
    };
  }
  if (preview.messageCount === 0) {
    return {
      canConfirm: false,
      blockingReason:
        "No usable messages were found in this file. It may be empty, or only contain system notifications or media.",
      warnings,
    };
  }
  if (!preview.ownerIdentityMatched) {
    warnings.unshift(
      'None of your configured WhatsApp identities matched a sender in this export — every message will be stored as "unknown" and cannot be used as evidence for a communication profile. Check your WhatsApp Identity settings below, or confirm anyway if you just want these messages on file.',
    );
  } else if (Object.values(preview.resolvedRoles).some((r) => r === "unknown")) {
    warnings.push(
      'One or more participants in this conversation could not be identified as you or the customer (likely a group chat) and will be stored as "unknown" — their messages will not be used as evidence.',
    );
  }

  return { canConfirm: true, blockingReason: null, warnings };
}

export function roleLabel(role: "owner" | "customer" | "unknown"): string {
  if (role === "owner") return "You";
  if (role === "customer") return "Customer";
  return "Unknown";
}

const STATUS_LABELS: Record<ProfileVersionStatus, string> = {
  pending: "Awaiting your review",
  approved: "Active",
  archived: "Replaced by a newer version",
  rejected: "Rejected",
};

export function profileVersionStatusLabel(status: ProfileVersionStatus): string {
  return STATUS_LABELS[status];
}

// The exact, honest deletion-warning text shown before an owner confirms
// deleting an import — must never claim backups/logs are purged, and
// must state plainly that affected profile versions are NOT rewritten.
export function describeDeletionImpact(affectedProfileVersions: number[]): string {
  const base =
    "Deleting this import permanently removes its stored messages from this business's account. This cannot be undone, and it does not remove anything from database backups or application logs.";
  if (affectedProfileVersions.length === 0) {
    return `${base} No existing communication profile was generated using this import's messages.`;
  }
  const plural = affectedProfileVersions.length > 1;
  const list = affectedProfileVersions.join(", ");
  return `${base} Communication profile version${plural ? "s" : ""} ${list} ${plural ? "were" : "was"} generated partly from this import's messages. Deleting the import will NOT change or remove ${plural ? "those versions" : "that version"} — ${plural ? "they" : "it"} may still contain wording drawn from the messages you're about to delete.`;
}

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
