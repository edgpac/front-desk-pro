import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  restoreMyCommunicationProfileVersion,
  type StoredCommunicationProfileVersion,
} from "@/lib/communication-profile-server";
import { profileVersionStatusLabel } from "@/lib/jir-chat-ui";

// Statuses whose version the owner approved at some point and that are
// not active now — the only ones the server lets the owner switch back to.
const RESTORABLE = new Set(["archived", "turned_off"]);

export function ProfileVersionHistory({
  versions,
  onRestored,
}: {
  versions: StoredCommunicationProfileVersion[];
  onRestored: () => void;
}) {
  const [restoring, setRestoring] = useState<number | null>(null);

  async function handleRestore(version: number) {
    setRestoring(version);
    try {
      const restored = await restoreMyCommunicationProfileVersion({ data: { version } });
      toast.success(
        `Switched back to version ${version} (now active as version ${restored.version}).`,
      );
      onRestored();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not switch to that version.");
    } finally {
      setRestoring(null);
    }
  }

  if (versions.length === 0) return null;

  return (
    <div>
      <p className="label-caps mb-2 text-muted-foreground">Version history</p>
      <ul className="space-y-1 text-sm">
        {versions
          .slice()
          .reverse()
          .map((v) => (
            <li
              key={v.version}
              className="flex items-center justify-between gap-3 border-b border-border py-1"
            >
              <span>
                Version {v.version}
                {v.restoredFromVersion !== null && (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    (restored from version {v.restoredFromVersion})
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {profileVersionStatusLabel(v.status)}
                </span>
                {RESTORABLE.has(v.status) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleRestore(v.version)}
                    disabled={restoring !== null}
                  >
                    {restoring === v.version && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Switch to this version
                  </Button>
                )}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}
