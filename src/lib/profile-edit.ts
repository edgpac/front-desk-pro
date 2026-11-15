import {
  PROFILE_LIST_FIELDS,
  generalNotesText,
  type CommunicationProfile,
} from "@/lib/communication-profile";

// Pure helpers for the owner editing a pending profile draft before
// approving it (dashboard.jir-chat.tsx's ProfileDraftEditor). An edited
// field becomes owner_stated: the owner wrote it, so there is no AI
// evidence to cite and it is trusted the same way any owner-stated field
// already is.

export type EditableProfileKey = keyof CommunicationProfile;

const LIST_KEYS = new Set<string>(PROFILE_LIST_FIELDS.map(([key]) => key));

// The text shown in a field's editor: list items one per line.
export function fieldEditText(profile: CommunicationProfile, key: EditableProfileKey): string {
  if (key === "generalNotes") return generalNotesText(profile.generalNotes);
  const field = profile[key];
  if (!field || typeof field === "string") return "";
  return Array.isArray(field.value) ? field.value.join("\n") : field.value;
}

// Returns a new profile with one field replaced by the owner's text.
// Empty text removes the field. List fields take one item per line.
export function applyOwnerFieldEdit(
  profile: CommunicationProfile,
  key: EditableProfileKey,
  text: string,
): CommunicationProfile {
  const { [key]: _removed, ...rest } = profile;
  const trimmed = text.trim();
  if (!trimmed) return rest;
  if (key === "generalNotes") return { ...rest, generalNotes: trimmed };
  const value = LIST_KEYS.has(key)
    ? trimmed
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : trimmed;
  return {
    ...rest,
    [key]: { value, source: "owner_stated", confidence: "high", evidence: [] },
  } as CommunicationProfile;
}
