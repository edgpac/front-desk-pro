import { PROFILE_LIST_FIELDS, PROFILE_STRING_FIELDS } from "./communication-profile";
import type { CommunicationProfile } from "./communication-profile";

export type ProfileFieldDiff = {
  key: string;
  label: string;
  kind: "added" | "changed" | "removed" | "unchanged";
  oldValue: unknown;
  newValue: unknown;
};

export type ProfileDiff = {
  fields: ProfileFieldDiff[];
  generalNotesChanged: boolean;
  hasChanges: boolean;
};

const ALL_FIELDS = [...PROFILE_STRING_FIELDS, ...PROFILE_LIST_FIELDS];

// Pure and deterministic — no AI call, so comparing a draft against the
// active profile never depends on the model "remembering" what was active
// before; it's always computed fresh from the two actual stored profiles.
// Diffs on .value only (not source/confidence/evidence): what a human
// reviewing this cares about is whether the GUIDANCE changed, not whether
// its provenance metadata did. Ported from Cabos Chat's reference
// implementation (src/core/profile-diff.ts there) — unchanged behavior.
export function diffCommunicationProfiles(
  active: CommunicationProfile | null,
  draft: CommunicationProfile,
): ProfileDiff {
  const fields: ProfileFieldDiff[] = [];

  for (const [key, label] of ALL_FIELDS) {
    const oldField = active?.[key as keyof CommunicationProfile];
    const newField = draft[key as keyof CommunicationProfile];
    const oldValue = oldField ? (oldField as { value: unknown }).value : undefined;
    const newValue = newField ? (newField as { value: unknown }).value : undefined;

    if (oldValue === undefined && newValue === undefined) continue;
    if (oldValue === undefined) {
      fields.push({ key, label, kind: "added", oldValue: undefined, newValue });
    } else if (newValue === undefined) {
      fields.push({ key, label, kind: "removed", oldValue, newValue: undefined });
    } else if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      fields.push({ key, label, kind: "changed", oldValue, newValue });
    } else {
      fields.push({ key, label, kind: "unchanged", oldValue, newValue });
    }
  }

  const generalNotesChanged = (active?.generalNotes ?? "") !== (draft.generalNotes ?? "");
  const hasChanges = fields.some((f) => f.kind !== "unchanged") || generalNotesChanged;

  return { fields, generalNotesChanged, hasChanges };
}

export function formatProfileDiff(diff: ProfileDiff): string {
  const lines: string[] = [];
  for (const f of diff.fields) {
    if (f.kind === "unchanged") continue;
    if (f.kind === "added") lines.push(`+ ${f.label}: ${JSON.stringify(f.newValue)}`);
    else if (f.kind === "removed")
      lines.push(`- ${f.label}: ${JSON.stringify(f.oldValue)} (removed)`);
    else
      lines.push(
        `~ ${f.label}:\n    was: ${JSON.stringify(f.oldValue)}\n    now: ${JSON.stringify(f.newValue)}`,
      );
  }
  if (diff.generalNotesChanged) lines.push("~ General notes changed.");
  return lines.length > 0 ? lines.join("\n") : "No differences from the currently active profile.";
}
