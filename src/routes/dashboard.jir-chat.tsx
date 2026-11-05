import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Loader2, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";

import { PageHeader, Panel } from "@/components/app/DashboardShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/lib/use-auth";

import { getMyWhatsAppOwnerAliases, updateMyWhatsAppOwnerAliases } from "@/lib/tenant-server";
import {
  previewMyWhatsAppImport,
  confirmMyWhatsAppImport,
  listMyWhatsAppImports,
  previewMyWhatsAppImportDeletion,
  deleteMyWhatsAppImport,
  type WhatsAppImportPreview,
  type WhatsAppImportSummary,
} from "@/lib/whatsapp-import-server";
import type { WhatsAppParticipantRole } from "@/lib/whatsapp-export-parser";
import { generateMyCommunicationProfile } from "@/lib/profile-generation-server";
import {
  listMyCommunicationProfileVersions,
  getMyActiveCommunicationProfile,
  getMyPendingCommunicationProfileDraft,
  recordMyCommunicationProfileDecision,
  type StoredCommunicationProfileVersion,
} from "@/lib/communication-profile-server";
import {
  PROFILE_STRING_FIELDS,
  PROFILE_LIST_FIELDS,
  PROFILE_FIELD_SOURCE_LABEL,
  generalNotesText,
  type CommunicationProfile,
  type ProfileFieldValue,
} from "@/lib/communication-profile";
import {
  assessImportPreview,
  describeDeletionImpact,
  profileVersionStatusLabel,
  roleLabel,
  pluralize,
} from "@/lib/jir-chat-ui";

export const Route = createFileRoute("/dashboard/jir-chat")({
  component: JirChatPage,
});

// Note: this feature's server-side infrastructure (import parsing,
// identity resolution, PII redaction, evidence-gated generation, the
// existing approval pipeline, the AI cost guard) is already implemented
// and tested — this page is the dashboard workflow in front of it. It
// requires migrations 0031-0033, which are NOT applied to production —
// see this change's own report for the required isolated-environment
// testing before this can be deployed.

type LoadedState = {
  aliases: string[];
  imports: WhatsAppImportSummary[];
  versions: StoredCommunicationProfileVersion[];
  activeProfile: StoredCommunicationProfileVersion | null;
  pendingDraft: StoredCommunicationProfileVersion | null;
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function JirChatPage() {
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [state, setState] = useState<LoadedState | null>(null);

  async function loadAll() {
    const [aliases, imports, versions, activeProfile, pendingDraft] = await Promise.all([
      getMyWhatsAppOwnerAliases(),
      listMyWhatsAppImports(),
      listMyCommunicationProfileVersions(),
      getMyActiveCommunicationProfile(),
      getMyPendingCommunicationProfileDraft(),
    ]);
    setState({ aliases, imports, versions, activeProfile, pendingDraft });
  }

  // A manual escape hatch for anything this page doesn't already refresh
  // on its own (every section below re-fetches its own slice after an
  // action it took itself, e.g. onImported/onSaved/onDecided — this is
  // for everything else: a value changed in another tab, or recovering
  // after an error toast without a full page reload).
  async function handleRefresh() {
    setRefreshing(true);
    try {
      await loadAll();
    } catch (err) {
      toast.error(errorMessage(err, "Could not refresh this page."));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    let active = true;
    loadAll()
      .catch((err) => {
        toast.error(errorMessage(err, "Could not load this page."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  if (authLoading || loading) {
    return (
      <div className="space-y-6 p-6 lg:p-10">
        <PageHeader eyebrow="JIR Chat" title="Loading…" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-6 p-6 lg:p-10">
        <PageHeader
          eyebrow="JIR Chat"
          title="Communication Profile Training"
          description="Import your business's historical WhatsApp conversations so JIR Chat can learn how you communicate — your tone, greetings, and phrasing — and propose a style guide for you to review and approve."
        />
        <Panel>
          <p className="text-sm text-muted-foreground">
            Sign in to configure your WhatsApp identity, import a conversation, and generate a
            proposed communication profile for your business.
          </p>
        </Panel>
      </div>
    );
  }

  if (!state) return null;

  return (
    <div className="space-y-6 p-6 lg:p-10">
      <PageHeader
        eyebrow="JIR Chat"
        title="Communication Profile Training"
        description="Import historical WhatsApp conversations to teach JIR Chat how your business communicates. Nothing here ever changes your services, prices, exclusions, or policies — those stay exactly as configured in your Price Sheet and Business Settings."
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      <IdentitySection
        aliases={state.aliases}
        onSaved={(aliases) => setState((s) => s && { ...s, aliases })}
      />

      <ImportSection
        onImported={() => {
          listMyWhatsAppImports()
            .then((imports) => setState((s) => s && { ...s, imports }))
            .catch(() => {});
        }}
      />

      <ImportsListSection
        imports={state.imports}
        onDeleted={(importId, affectedProfileVersions) => {
          setState((s) => s && { ...s, imports: s.imports.filter((i) => i.id !== importId) });
          if (affectedProfileVersions.length > 0) {
            toast.info(
              `Import deleted. Communication profile version${
                affectedProfileVersions.length === 1 ? "" : "s"
              } ${affectedProfileVersions.join(", ")} ${
                affectedProfileVersions.length === 1 ? "was" : "were"
              } NOT changed — see the note above for what that means.`,
            );
          } else {
            toast.success("Import deleted.");
          }
        }}
      />

      <ProfileSection
        versions={state.versions}
        activeProfile={state.activeProfile}
        pendingDraft={state.pendingDraft}
        hasImports={state.imports.length > 0}
        onGenerated={() => loadAll().catch(() => {})}
        onDecided={() => loadAll().catch(() => {})}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Owner identity setup
// ---------------------------------------------------------------------------

function IdentitySection({
  aliases,
  onSaved,
}: {
  aliases: string[];
  onSaved: (aliases: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);

  async function save(next: string[]) {
    setPending(true);
    try {
      const result = await updateMyWhatsAppOwnerAliases({ data: { aliases: next } });
      onSaved(result.aliases);
    } catch (err) {
      toast.error(errorMessage(err, "Could not save your WhatsApp identity."));
    } finally {
      setPending(false);
    }
  }

  function handleAdd() {
    if (!draft.trim()) return;
    save([...aliases, draft.trim()]);
    setDraft("");
  }

  function handleRemove(alias: string) {
    save(aliases.filter((a) => a !== alias));
  }

  return (
    <Panel title="WhatsApp Identity">
      <p className="mb-3 text-xs text-muted-foreground">
        Add how YOUR name or number appears as the sender in your own WhatsApp exports (e.g. your
        display name, or a number you message from). This is how JIR Chat tells your own messages
        apart from a customer's — it never guesses. Without a correct match, imported messages are
        marked &quot;unknown&quot; and can&apos;t be used to learn your communication style.
      </p>

      {aliases.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-2">
          {aliases.map((alias) => (
            <li
              key={alias}
              className="flex items-center gap-1.5 rounded-full border border-border-strong bg-muted px-3 py-1 text-sm text-foreground"
            >
              {alias}
              <button
                onClick={() => handleRemove(alias)}
                aria-label={`Remove ${alias}`}
                disabled={pending}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="e.g. Jane Smith, or +1 555-0100"
          disabled={pending}
        />
        <Button
          type="button"
          variant="outline"
          onClick={handleAdd}
          disabled={pending || !draft.trim()}
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 2 & 3. Import a WhatsApp export + preview before confirmation
// ---------------------------------------------------------------------------

function ImportSection({ onImported }: { onImported: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [preview, setPreview] = useState<WhatsAppImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // WhatsApp's export date format follows the phone's own region setting,
  // not anything this app controls — defaults to month-first (US-style)
  // since that's the parser's own default, but an owner exporting from a
  // day-first-locale phone (the common case outside the US) needs a way
  // to say so before ambiguous dates like "03/04/25" get silently
  // misread. Only matters before confirming an import — locked in by the
  // time a preview exists, same as the file picker itself.
  const [preferDayFirst, setPreferDayFirst] = useState(false);

  function reset() {
    setContent(null);
    setFilename(null);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFileSelect(file: File) {
    // Read entirely client-side — the file's text is sent directly to
    // this app's own server function; nothing is uploaded to any other
    // service or stored anywhere until the owner explicitly confirms.
    const text = await file.text();
    setFilename(file.name);
    setContent(text);
    setPreviewing(true);
    setPreview(null);
    try {
      const result = await previewMyWhatsAppImport({ data: { content: text, preferDayFirst } });
      setPreview(result);
    } catch (err) {
      toast.error(errorMessage(err, "Could not read that file as a WhatsApp export."));
      reset();
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    if (!content) return;
    setConfirming(true);
    try {
      const result = await confirmMyWhatsAppImport({
        data: { content, originalFilename: filename, preferDayFirst },
      });
      toast.success(`Imported ${pluralize(result.storedMessageCount, "message")}.`);
      reset();
      onImported();
    } catch (err) {
      toast.error(errorMessage(err, "Could not confirm this import."));
    } finally {
      setConfirming(false);
    }
  }

  const assessment = preview ? assessImportPreview(preview) : null;

  return (
    <Panel title="Import a Conversation">
      <details className="mb-3 rounded-sm border border-border text-xs text-muted-foreground">
        <summary className="cursor-pointer px-3 py-2 font-medium text-foreground">
          How to export a WhatsApp conversation
        </summary>
        <ol className="list-decimal space-y-1 px-3 pb-3 pl-7">
          <li>Open WhatsApp.</li>
          <li>Open a conversation with a customer.</li>
          <li>Tap the contact&apos;s name at the top.</li>
          <li>
            Scroll down and select{" "}
            <strong className="font-medium text-foreground">Export Chat</strong>.
          </li>
          <li>
            Choose <strong className="font-medium text-foreground">Without Media</strong>.
          </li>
          <li>Save or send the .txt file to your computer.</li>
          <li>Return to JIR Chat and click Choose File below.</li>
          <li>Select the exported .txt file.</li>
        </ol>
      </details>
      <p className="mb-3 text-xs text-muted-foreground">
        Supports a plain-text WhatsApp &quot;Export Chat&quot; file (.txt). Media files and the ZIP
        wrapper aren&apos;t needed; only the text matters for learning how you write.
      </p>
      <p className="mb-3 text-xs text-muted-foreground">
        This file contains a real conversation with one of your customers — you&apos;re responsible
        for having the right to upload and process it. Uploading it here doesn&apos;t transfer that
        responsibility to Job It Ready. See our{" "}
        <a
          href="/privacy"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Privacy Policy
        </a>
        .
      </p>

      {!preview && (
        <div>
          <label className="mb-3 flex items-start gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={preferDayFirst}
              onChange={(e) => setPreferDayFirst(e.target.checked)}
            />
            <span>
              This export&apos;s dates are written day/month first (e.g. 3 Apr as{" "}
              <span className="num">03/04</span>) — common outside the US. Leave unchecked for
              month/day first (US-style).
            </span>
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,text/plain"
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-sm file:border file:border-border-strong file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-border"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileSelect(file);
            }}
            disabled={previewing}
          />
          {previewing && (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading file…
            </p>
          )}
        </div>
      )}

      {preview && assessment && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Messages" value={preview.messageCount} />
            <Stat label="System notices" value={preview.systemCount} />
            <Stat label="Unparseable lines" value={preview.unparseableCount} />
            <Stat label="Ambiguous dates" value={preview.ambiguousDateCount} />
          </div>

          {assessment.blockingReason && (
            <Alert variant="destructive">
              <AlertTitle>Can&apos;t import this file</AlertTitle>
              <AlertDescription>{assessment.blockingReason}</AlertDescription>
            </Alert>
          )}

          {assessment.warnings.map((w, i) => (
            <Alert key={i}>
              <AlertDescription>{w}</AlertDescription>
            </Alert>
          ))}

          {preview.participantLabels.length > 0 && (
            <div>
              <p className="label-caps mb-2 text-muted-foreground">Who&apos;s who in this export</p>
              <ul className="space-y-1 text-sm">
                {preview.participantLabels.map((label) => (
                  <li
                    key={label}
                    className="flex items-center justify-between gap-2 border-b border-border py-1"
                  >
                    <span className="text-foreground">{label}</span>
                    <RoleBadge role={preview.resolvedRoles[label] ?? "unknown"} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              onClick={handleConfirm}
              disabled={!assessment.canConfirm || confirming}
            >
              {confirming && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Confirm import
            </Button>
            <Button type="button" variant="outline" onClick={reset} disabled={confirming}>
              Discard
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-border-strong bg-muted/40 p-2">
      <p className="label-caps text-muted-foreground">{label}</p>
      <p className="font-display text-lg text-foreground">{value}</p>
    </div>
  );
}

function RoleBadge({ role }: { role: WhatsAppParticipantRole }) {
  const styles: Record<WhatsAppParticipantRole, string> = {
    owner: "bg-success/12 text-success border-success/35",
    customer: "bg-primary/12 text-primary border-primary/35",
    unknown: "bg-muted text-muted-foreground border-border-strong",
  };
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-2 py-[2px] text-[10px] font-bold uppercase tracking-[0.1em] ${styles[role]}`}
    >
      {roleLabel(role)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 6. Import management and deletion
// ---------------------------------------------------------------------------

function ImportsListSection({
  imports,
  onDeleted,
}: {
  imports: WhatsAppImportSummary[];
  onDeleted: (importId: string, affectedProfileVersions: number[]) => void;
}) {
  const [target, setTarget] = useState<WhatsAppImportSummary | null>(null);
  const [impact, setImpact] = useState<number[] | null>(null);
  const [checkingImpact, setCheckingImpact] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function openConfirm(imp: WhatsAppImportSummary) {
    setTarget(imp);
    setImpact(null);
    setCheckingImpact(true);
    try {
      const result = await previewMyWhatsAppImportDeletion({ data: { importId: imp.id } });
      setImpact(result.affectedProfileVersions);
    } catch (err) {
      toast.error(errorMessage(err, "Could not check this import before deleting it."));
      setTarget(null);
    } finally {
      setCheckingImpact(false);
    }
  }

  async function confirmDelete() {
    if (!target) return;
    setDeleting(true);
    try {
      const result = await deleteMyWhatsAppImport({ data: { importId: target.id } });
      onDeleted(target.id, result.affectedProfileVersions);
      setTarget(null);
      setImpact(null);
    } catch (err) {
      toast.error(errorMessage(err, "Could not delete this import."));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Panel title="Imported Conversations">
      {imports.length === 0 ? (
        <p className="text-sm text-muted-foreground">No conversations imported yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {imports.map((imp) => (
            <li key={imp.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div>
                <p className="text-foreground">{imp.originalFilename ?? "Pasted conversation"}</p>
                <p className="text-xs text-muted-foreground">
                  {pluralize(imp.messageCount, "message")} · imported{" "}
                  {new Date(imp.createdAt).toLocaleDateString()}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Delete import: ${imp.originalFilename ?? "Pasted conversation"}`}
                onClick={() => openConfirm(imp)}
                disabled={checkingImpact && target?.id === imp.id}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this import?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <span>
                {checkingImpact || impact === null ? (
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking what this affects…
                  </span>
                ) : (
                  describeDeletionImpact(impact)
                )}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
              disabled={checkingImpact || impact === null || deleting}
            >
              {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Delete import
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 4 & 5. Generate a proposed profile, review, and approve
// ---------------------------------------------------------------------------

function ProfileSection({
  versions,
  activeProfile,
  pendingDraft,
  hasImports,
  onGenerated,
  onDecided,
}: {
  versions: StoredCommunicationProfileVersion[];
  activeProfile: StoredCommunicationProfileVersion | null;
  pendingDraft: StoredCommunicationProfileVersion | null;
  hasImports: boolean;
  onGenerated: () => void;
  onDecided: () => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [deciding, setDeciding] = useState(false);

  async function handleGenerate() {
    setGenerating(true);
    try {
      const result = await generateMyCommunicationProfile();
      if (result.status === "generated") {
        toast.success(
          `Proposed communication profile created (version ${result.version.version}).`,
        );
        onGenerated();
      } else {
        toast.info(result.reason);
      }
    } catch {
      // Deliberately never surfaces err.message here, unlike this file's
      // other catch blocks — those throw deliberately-crafted, owner-
      // facing text (a bad file, a tenant check), but a generation
      // failure can come from inside the AI call itself (a raw API/
      // config error), which isn't actionable for a business owner and
      // shouldn't be shown verbatim.
      toast.error("Could not generate a communication profile right now. Please try again.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleDecision(decision: "approved" | "rejected") {
    if (!pendingDraft) return;
    setDeciding(true);
    try {
      await recordMyCommunicationProfileDecision({
        data: { version: pendingDraft.version, decision },
      });
      toast.success(
        decision === "approved" ? "Profile approved and now active." : "Profile rejected.",
      );
      onDecided();
    } catch (err) {
      toast.error(errorMessage(err, "Could not record that decision."));
    } finally {
      setDeciding(false);
    }
  }

  return (
    <Panel
      title="Communication Profile"
      aside={
        <Button
          type="button"
          size="sm"
          onClick={handleGenerate}
          disabled={generating || !hasImports || pendingDraft !== null}
        >
          {generating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          Generate proposed profile
        </Button>
      }
    >
      {!hasImports && (
        <p className="mb-3 text-sm text-muted-foreground">
          Import at least one conversation above before generating a proposed profile.
        </p>
      )}

      {pendingDraft && (
        <div className="mb-4 space-y-3 border border-primary/35 bg-primary/5 p-3">
          <p className="label-caps text-primary">
            Proposed — version {pendingDraft.version} — awaiting your review
          </p>
          <p className="text-xs text-muted-foreground">
            This is a proposal only. It never changes your services, prices, exclusions, or policies
            — those remain exactly as set in your Price Sheet and Business Settings. It only affects
            how JIR Chat talks, and only after you approve it below.
          </p>
          <ProfileFieldsDisplay profile={pendingDraft.profile} />
          <div className="flex gap-2">
            <Button type="button" onClick={() => handleDecision("approved")} disabled={deciding}>
              Approve &amp; activate
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleDecision("rejected")}
              disabled={deciding}
            >
              Reject
            </Button>
          </div>
        </div>
      )}

      {activeProfile && (
        <div className="mb-4">
          <p className="label-caps mb-2 text-success">Active — version {activeProfile.version}</p>
          <ProfileFieldsDisplay profile={activeProfile.profile} />
        </div>
      )}

      {!activeProfile && !pendingDraft && hasImports && (
        <p className="mb-3 text-sm text-muted-foreground">
          No communication profile yet. Generate a proposal above once you&apos;ve imported a
          conversation.
        </p>
      )}

      {versions.length > 0 && (
        <div>
          <p className="label-caps mb-2 text-muted-foreground">Version history</p>
          <ul className="space-y-1 text-sm">
            {versions
              .slice()
              .reverse()
              .map((v) => (
                <li
                  key={v.version}
                  className="flex items-center justify-between border-b border-border py-1"
                >
                  <span>Version {v.version}</span>
                  <span className="text-xs text-muted-foreground">
                    {profileVersionStatusLabel(v.status)}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function ProfileFieldsDisplay({ profile }: { profile: CommunicationProfile }) {
  const stringFields = PROFILE_STRING_FIELDS.map(([key, label]) => ({
    key,
    label,
    field: profile[key as keyof CommunicationProfile] as ProfileFieldValue<string> | undefined,
  })).filter((f) => f.field);
  const listFields = PROFILE_LIST_FIELDS.map(([key, label]) => ({
    key,
    label,
    field: profile[key as keyof CommunicationProfile] as ProfileFieldValue<string[]> | undefined,
  })).filter((f) => f.field);
  const notes = generalNotesText(profile.generalNotes);

  if (stringFields.length === 0 && listFields.length === 0 && !notes) {
    return <p className="text-sm text-muted-foreground">No fields were set in this version.</p>;
  }

  return (
    <dl className="space-y-2 text-sm">
      {stringFields.map(({ key, label, field }) => (
        <FieldRow key={key} label={label} value={field!.value} field={field!} />
      ))}
      {listFields.map(({ key, label, field }) => (
        <FieldRow key={key} label={label} value={field!.value.join("; ")} field={field!} />
      ))}
      {notes && (
        <div>
          <dt className="text-xs font-semibold text-foreground">General notes</dt>
          <dd className="text-muted-foreground">{notes}</dd>
        </div>
      )}
    </dl>
  );
}

function FieldRow({
  label,
  value,
  field,
}: {
  label: string;
  value: string;
  field: ProfileFieldValue<unknown>;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold text-foreground">{label}</dt>
      <dd className="text-muted-foreground">
        {value}
        <span className="ml-1.5 text-xs text-muted-foreground/70">
          ({PROFILE_FIELD_SOURCE_LABEL[field.source]}, confidence: {field.confidence}
          {field.evidence.length > 0
            ? `, ${pluralize(field.evidence.length, "message")} cited`
            : ""}
          )
        </span>
      </dd>
    </div>
  );
}
