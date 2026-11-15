import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  reviseMyCommunicationProfileDraft,
  type StoredCommunicationProfileVersion,
} from "@/lib/communication-profile-server";
import { PROFILE_LIST_FIELDS, PROFILE_STRING_FIELDS } from "@/lib/communication-profile";
import { applyOwnerFieldEdit, fieldEditText, type EditableProfileKey } from "@/lib/profile-edit";

const EDITABLE_FIELDS: Array<{ key: EditableProfileKey; label: string; isList: boolean }> = [
  ...PROFILE_STRING_FIELDS.map(([key, label]) => ({ key, label, isList: false })),
  ...PROFILE_LIST_FIELDS.map(([key, label]) => ({ key, label, isList: true })),
  { key: "generalNotes", label: "General notes", isList: false },
];

// Lets the owner correct a pending draft before approving it. Only fields
// the owner actually changed become owner-stated; untouched fields keep
// their AI evidence. Saving creates a new pending version (the old draft
// is marked superseded) — it never activates anything.
export function ProfileDraftEditor({
  draft,
  onSaved,
  onCancel,
}: {
  draft: StoredCommunicationProfileVersion;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [initial] = useState(() =>
    Object.fromEntries(EDITABLE_FIELDS.map(({ key }) => [key, fieldEditText(draft.profile, key)])),
  );
  const [texts, setTexts] = useState<Record<string, string>>(initial);
  const [saving, setSaving] = useState(false);

  const changedKeys = EDITABLE_FIELDS.map(({ key }) => key).filter(
    (key) => texts[key] !== initial[key],
  );

  async function handleSave() {
    const profile = changedKeys.reduce(
      (acc, key) => applyOwnerFieldEdit(acc, key, texts[key] ?? ""),
      draft.profile,
    );
    setSaving(true);
    try {
      const saved = await reviseMyCommunicationProfileDraft({
        data: { baseVersion: draft.version, profile },
      });
      toast.success(`Saved your edits as version ${saved.version}. Review it, then approve.`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save your edits.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Edit any field below. List fields take one item per line; clear a field to remove it. Fields
        you change are marked owner-stated.
      </p>
      {EDITABLE_FIELDS.map(({ key, label, isList }) => (
        <label key={key} className="block space-y-1">
          <span className="text-xs font-semibold text-foreground">
            {label}
            {isList && (
              <span className="ml-1 font-normal text-muted-foreground">(one per line)</span>
            )}
          </span>
          <Textarea
            value={texts[key] ?? ""}
            onChange={(e) => setTexts((prev) => ({ ...prev, [key]: e.target.value }))}
            rows={isList ? 4 : 2}
            disabled={saving}
          />
        </label>
      ))}
      <div className="flex gap-2">
        <Button type="button" onClick={handleSave} disabled={saving || changedKeys.length === 0}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save edits as new version
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
