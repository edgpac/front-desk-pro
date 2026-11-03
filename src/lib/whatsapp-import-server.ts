import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  parseWhatsAppExport,
  type ParseWhatsAppExportOptions,
  type WhatsAppParticipantRole,
} from "@/lib/whatsapp-export-parser";
import { resolveParticipantRoles } from "@/lib/whatsapp-owner-identity";
import {
  PROFILE_LIST_FIELDS,
  PROFILE_STRING_FIELDS,
  type CommunicationProfile,
} from "@/lib/communication-profile";
import { validateCommunicationProfileShape } from "@/lib/communication-profile-server";

// Server-side storage for whatsapp_imports / whatsapp_import_messages
// (see supabase/migrations/0033_whatsapp_imports.sql). This is JIR
// Chat's historical-conversation training evidence — it never reads or
// writes price_sheet_items / tenant_capabilities / leads / lead_messages,
// and nothing here ever treats an imported message's content as an
// instruction: every message is data to be stored and later cited as
// evidence, never executed or interpreted as a command (see
// profile-generation-server.ts for where that distinction is actually
// enforced, in the AI-facing prompt and its evidence validator).
//
// Every DB-touching function is a plain function wrapped in
// createServerOnlyFn, matching communication-profile-server.ts's
// established pattern (a bare createServerFn can't be unit-tested in
// this harness — see price-sheet-server.test.ts's own comment).

// Same local, non-exported getTenantId copy every other *-server.ts file
// in this codebase has its own version of — no shared helper exists for
// this, by established convention (see communication-profile-server.ts's
// own comment on the same choice).
async function getTenantId(
  supabase: Pick<SupabaseClient, "from">,
  userId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("tenants")
    .select("id")
    .eq("user_id", userId)
    .single();
  if (error || !data)
    throw new Error(`Could not load your business: ${error?.message ?? "no tenant found"}`);
  return data["id"] as string;
}

async function getOwnerAliases(
  supabase: Pick<SupabaseClient, "from">,
  tenantId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("tenants")
    .select("whatsapp_owner_aliases")
    .eq("id", tenantId)
    .single();
  if (error) throw new Error(`Could not load WhatsApp owner aliases: ${error.message}`);
  return ((data as { whatsapp_owner_aliases: string[] | null })?.whatsapp_owner_aliases ??
    []) as string[];
}

// Dynamic import, not a static top-level one — see
// 0ede85e "fix: keep nodemailer out of dev client bundle" for the same
// category of bug this avoids: a static `import ... from "node:crypto"`
// here would be correctly stripped from the client bundle by the
// production build's compiler, but `vite dev` serves modules more
// literally and doesn't do that same split, so merely importing this
// module (used only inside the createServerOnlyFn handlers below) would
// crash any dev client page that so much as imports this file. Changes
// nothing about when or how the hash is actually computed server-side.
export async function computeImportContentHash(content: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export type WhatsAppImportPreview = {
  contentHash: string;
  alreadyImported: boolean;
  messageCount: number;
  systemCount: number;
  unparseableCount: number;
  ambiguousDateCount: number;
  dateRange: { start: string | null; end: string | null };
  warnings: string[];
  participantLabels: string[];
  resolvedRoles: Record<string, WhatsAppParticipantRole>;
  ownerIdentityMatched: boolean;
};

// Read-only: computes everything needed to decide whether to import,
// without writing anything. The only database access is a SELECT
// (dedupe check) and a SELECT (owner aliases) — asserted directly in
// this file's tests by checking the fake table's rows are unchanged
// after a call.
export const previewWhatsAppImport = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    tenantId: string,
    content: string,
    options: ParseWhatsAppExportOptions = {},
  ): Promise<WhatsAppImportPreview> => {
    const contentHash = await computeImportContentHash(content);
    const [{ data: existing, error: existingError }, ownerAliases] = await Promise.all([
      supabase
        .from("whatsapp_imports")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("content_hash", contentHash)
        .maybeSingle(),
      getOwnerAliases(supabase, tenantId),
    ]);
    if (existingError)
      throw new Error(`Could not check for an existing import: ${existingError.message}`);

    const parsed = parseWhatsAppExport(content, options);
    const { roles, matchedAliasCount } = resolveParticipantRoles(
      parsed.participantLabels,
      ownerAliases,
    );

    return {
      contentHash,
      alreadyImported: existing !== null,
      messageCount: parsed.messageCount,
      systemCount: parsed.systemCount,
      unparseableCount: parsed.unparseableCount,
      ambiguousDateCount: parsed.ambiguousDateCount,
      dateRange: parsed.dateRange,
      warnings: parsed.warnings,
      participantLabels: parsed.participantLabels,
      resolvedRoles: roles,
      ownerIdentityMatched: matchedAliasCount > 0,
    };
  },
);

export class WhatsAppImportAlreadyExistsError extends Error {
  constructor() {
    super("This exact conversation export has already been imported for this business.");
    this.name = "WhatsAppImportAlreadyExistsError";
  }
}

export type ConfirmWhatsAppImportResult = {
  importId: string;
  messageCount: number;
  storedMessageCount: number;
};

// Persists an import and its messages. Only `message`-kind, non-media-
// placeholder entries are ever stored (system notifications and media
// placeholders carry no communication-style signal — see the migration's
// own comment), and only the RESOLVED ROLE is stored, never the raw
// sender label — a direct privacy-minimization choice, not an
// afterthought. Re-parses from the raw content rather than trusting a
// client-supplied preview result, so confirmation can never be tricked
// into storing something that doesn't match what was actually parsed.
export const confirmWhatsAppImport = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    tenantId: string,
    content: string,
    originalFilename: string | null,
    options: ParseWhatsAppExportOptions = {},
  ): Promise<ConfirmWhatsAppImportResult> => {
    const contentHash = await computeImportContentHash(content);

    const { data: existing, error: existingError } = await supabase
      .from("whatsapp_imports")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("content_hash", contentHash)
      .maybeSingle();
    if (existingError)
      throw new Error(`Could not check for an existing import: ${existingError.message}`);
    if (existing) throw new WhatsAppImportAlreadyExistsError();

    const ownerAliases = await getOwnerAliases(supabase, tenantId);
    const parsed = parseWhatsAppExport(content, options);
    const { roles } = resolveParticipantRoles(parsed.participantLabels, ownerAliases);

    const storableEntries = parsed.entries.filter(
      (e) => e.kind === "message" && !e.isMediaPlaceholder,
    );

    const { data: inserted, error: insertError } = await supabase
      .from("whatsapp_imports")
      .insert({
        tenant_id: tenantId,
        content_hash: contentHash,
        original_filename: originalFilename,
        message_count: parsed.messageCount,
        system_count: parsed.systemCount,
        unparseable_count: parsed.unparseableCount,
        ambiguous_date_count: parsed.ambiguousDateCount,
        date_range_start: parsed.dateRange.start,
        date_range_end: parsed.dateRange.end,
      })
      .select("id")
      .single();
    if (insertError || !inserted) {
      // A unique-violation here means a concurrent call imported the
      // identical export between our pre-check above and this insert —
      // the same class of race Phase 2's hardening pass addressed for
      // profile decisions/versions. Translated into the same typed
      // "already imported" outcome the pre-check throws, so a caller
      // can never mistake the rejection for a successful import.
      if ((insertError as { code?: string } | null)?.code === "23505") {
        throw new WhatsAppImportAlreadyExistsError();
      }
      throw new Error(`Could not save the import: ${insertError?.message ?? "unknown error"}`);
    }
    const importId = (inserted as { id: string }).id;

    if (storableEntries.length > 0) {
      const rows = storableEntries.map((e) => ({
        import_id: importId,
        line_number: e.lineNumber,
        role: roles[e.senderLabel ?? ""] ?? "unknown",
        occurred_at: e.occurredAt,
        date_ambiguous: e.dateAmbiguous,
        body: e.body,
      }));
      const { error: messagesError } = await supabase.from("whatsapp_import_messages").insert(rows);
      if (messagesError) {
        throw new Error(`Could not save the imported messages: ${messagesError.message}`);
      }
    }

    return {
      importId,
      messageCount: parsed.messageCount,
      storedMessageCount: storableEntries.length,
    };
  },
);

export type WhatsAppImportSummary = {
  id: string;
  originalFilename: string | null;
  messageCount: number;
  dateRange: { start: string | null; end: string | null };
  createdAt: string;
};

export const listWhatsAppImports = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    tenantId: string,
  ): Promise<WhatsAppImportSummary[]> => {
    const { data, error } = await supabase
      .from("whatsapp_imports")
      .select("id, original_filename, message_count, date_range_start, date_range_end, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Could not load imports: ${error.message}`);
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: row["id"] as string,
      originalFilename: (row["original_filename"] as string | null) ?? null,
      messageCount: row["message_count"] as number,
      dateRange: {
        start: (row["date_range_start"] as string | null) ?? null,
        end: (row["date_range_end"] as string | null) ?? null,
      },
      createdAt: row["created_at"] as string,
    }));
  },
);

export class WhatsAppImportNotFoundError extends Error {
  constructor() {
    super("No such import for this business.");
    this.name = "WhatsAppImportNotFoundError";
  }
}

// Thrown instead of guessing when a stored profile_json can't be safely
// checked for citations of the messages about to be deleted — e.g. a
// row with an unexpected shape (missing fields, wrong types, malformed
// evidence). The caller (deleteWhatsAppImport) lets this propagate
// straight through and never reaches the delete itself: an unverifiable
// disclosure check must stop the deletion, not silently report "nothing
// affected" for a row it genuinely couldn't evaluate.
export class UnverifiableProfileVersionError extends Error {
  constructor(version: number, reasons: string[]) {
    super(
      `Communication profile version #${version} has an unexpected shape and could not be safely checked for references to the messages being deleted (${reasons.join("; ")}). Deletion was stopped rather than risk reporting an incomplete disclosure.`,
    );
    this.name = "UnverifiableProfileVersionError";
  }
}

// Only ever called with a profile ALREADY confirmed well-formed by
// validateCommunicationProfileShape (see its call site below) — the
// same structural guarantee every write into communication_profile_versions
// already goes through via createCommunicationProfileVersion. That gate
// is what makes this function safe to keep simple; it is not re-doing
// its own defensive shape-checking here.
function evidenceCitesAnyMessage(
  profile: CommunicationProfile,
  messageIds: ReadonlySet<string>,
): boolean {
  for (const [key] of [...PROFILE_STRING_FIELDS, ...PROFILE_LIST_FIELDS]) {
    const field = profile[key as keyof CommunicationProfile] as
      { evidence: { messageId: string }[] } | undefined;
    if (field?.evidence.some((e) => messageIds.has(e.messageId))) return true;
  }
  if (profile.generalNotes && typeof profile.generalNotes !== "string") {
    if (profile.generalNotes.evidence.some((e) => messageIds.has(e.messageId))) return true;
  }
  return false;
}

export type DeleteWhatsAppImportResult = {
  ok: true;
  // Version numbers of this tenant's communication_profile_versions
  // rows whose evidence cites a message this deletion just removed —
  // informational ONLY. Deleting an import does NOT alter any of these
  // versions: they are immutable history (Phase 1's own design) and a
  // version that already copied verbatim/near-verbatim text into
  // preferredResponseExamples keeps that text exactly as generated.
  // This array exists so a caller (a future dashboard UI) can tell the
  // owner which approved/historical profiles were built from this
  // import, rather than silently implying every trace of the deleted
  // content is gone. See deleteWhatsAppImport's own comment for the
  // full policy and its limits.
  affectedProfileVersions: number[];
};

// Shared by both the read-only preview below and the real delete, so
// they can never disagree: computes which of this tenant's existing
// profile versions cite one of THIS import's messages as evidence.
// Confirms the import is tenant-owned first (in application code, not
// relying on RLS alone), then validates every version's profile_json
// against the same shape check its own write path already enforces
// before trusting it for the citation check — a row that fails this
// (malformed/unexpected data, from wherever) throws rather than being
// silently counted as "not affected".
async function computeAffectedProfileVersions(
  supabase: Pick<SupabaseClient, "from">,
  tenantId: string,
  importId: string,
): Promise<number[]> {
  const { data: importRow, error: importError } = await supabase
    .from("whatsapp_imports")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("id", importId)
    .maybeSingle();
  if (importError) throw new Error(`Could not load the import: ${importError.message}`);
  if (!importRow) throw new WhatsAppImportNotFoundError();

  const { data: messageRows, error: messagesError } = await supabase
    .from("whatsapp_import_messages")
    .select("id")
    .eq("import_id", importId);
  if (messagesError)
    throw new Error(`Could not inspect the import's messages: ${messagesError.message}`);
  const messageIds = new Set(((messageRows ?? []) as Array<{ id: string }>).map((r) => r.id));

  if (messageIds.size === 0) return [];

  const { data: versionRows, error: versionsError } = await supabase
    .from("communication_profile_versions")
    .select("version, profile_json")
    .eq("tenant_id", tenantId);
  if (versionsError)
    throw new Error(`Could not check existing profile versions: ${versionsError.message}`);

  const affectedProfileVersions: number[] = [];
  for (const row of (versionRows ?? []) as Array<{ version: number; profile_json: unknown }>) {
    const shapeResult = validateCommunicationProfileShape(row.profile_json);
    if (!shapeResult.ok) {
      throw new UnverifiableProfileVersionError(row.version, shapeResult.errors);
    }
    if (evidenceCitesAnyMessage(shapeResult.value, messageIds)) {
      affectedProfileVersions.push(row.version);
    }
  }
  return affectedProfileVersions;
}

export type PreviewWhatsAppImportDeletionResult = {
  affectedProfileVersions: number[];
};

// Read-only: lets the owner see which profile versions would be
// disclosed as affected BEFORE they confirm a deletion, without
// deleting anything. Exists specifically so the dashboard can show this
// in a confirmation dialog rather than only after the fact.
export const previewWhatsAppImportDeletion = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    tenantId: string,
    importId: string,
  ): Promise<PreviewWhatsAppImportDeletionResult> => {
    const affectedProfileVersions = await computeAffectedProfileVersions(
      supabase,
      tenantId,
      importId,
    );
    return { affectedProfileVersions };
  },
);

// Deletes an import and (via the migration's on delete cascade) every
// message it owns. Tenant-scoped: the delete's own filter requires
// tenant_id = tenantId, so a request for an id that exists but belongs
// to a different tenant deletes nothing and is reported as not found,
// never as "deleted".
//
// DELETION POLICY (the smallest safe policy achievable without a new
// migration or UI — see the hardening-pass report for why a more
// comprehensive guarantee would need one):
//  1. Preserves append-only profile decision history: this function
//     never writes to communication_profile_versions or
//     communication_profile_decisions. Nothing here is rewritten.
//  2. Prevents future generation from using the deleted messages:
//     runProfileGeneration always re-queries whatsapp_import_messages
//     fresh; once a row is gone (via cascade), it simply isn't there to
//     be read as evidence again.
//  3. Does NOT erase derived text already baked into an existing,
//     approved profile version. Before deleting, this function checks
//     which of this tenant's EXISTING profile versions cite one of the
//     about-to-be-deleted messages as evidence, and returns those
//     version numbers — an explicit, structured disclosure rather than
//     a silent gap (the SAME computation previewWhatsAppImportDeletion
//     exposes read-only, above). The versions themselves are left
//     completely unmodified (point 1).
//  4. Does NOT claim to purge platform-level database backups or any
//     logging/observability pipeline that may have captured this
//     content elsewhere — that is outside this function's (and this
//     codebase's) visibility, and is not asserted here one way or the
//     other.
// A fully comprehensive guarantee (e.g. redacting affected text out of
// already-approved profile versions) would mean rewriting immutable
// history, which directly contradicts requirement 1 above and 0031's
// own design intent — closing that gap for real would need a deliberate
// design decision (and likely a new migration/workflow), not something
// to invent silently here.
export const deleteWhatsAppImport = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    tenantId: string,
    importId: string,
  ): Promise<DeleteWhatsAppImportResult> => {
    const affectedProfileVersions = await computeAffectedProfileVersions(
      supabase,
      tenantId,
      importId,
    );

    const { data, error } = await supabase
      .from("whatsapp_imports")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("id", importId)
      .select("id");
    if (error) throw new Error(`Could not delete the import: ${error.message}`);
    if (!data || (data as unknown[]).length === 0) throw new WhatsAppImportNotFoundError();

    return { ok: true as const, affectedProfileVersions };
  },
);

// ---------------------------------------------------------------------------
// createServerFn wrappers — resolve tenantId from the authenticated
// session, never from client input, exactly like communication-profile-
// server.ts's wrappers.
// ---------------------------------------------------------------------------

export const previewMyWhatsAppImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { content: string; preferDayFirst?: boolean }) => input)
  .handler(async ({ context, data }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    return previewWhatsAppImport(
      context.supabase,
      tenantId,
      data.content,
      data.preferDayFirst === undefined ? {} : { preferDayFirst: data.preferDayFirst },
    );
  });

export const confirmMyWhatsAppImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: { content: string; originalFilename?: string | null; preferDayFirst?: boolean }) =>
      input,
  )
  .handler(async ({ context, data }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    return confirmWhatsAppImport(
      context.supabase,
      tenantId,
      data.content,
      data.originalFilename ?? null,
      data.preferDayFirst === undefined ? {} : { preferDayFirst: data.preferDayFirst },
    );
  });

export const listMyWhatsAppImports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    return listWhatsAppImports(context.supabase, tenantId);
  });

export const previewMyWhatsAppImportDeletion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { importId: string }) => input)
  .handler(async ({ context, data }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    return previewWhatsAppImportDeletion(context.supabase, tenantId, data.importId);
  });

export const deleteMyWhatsAppImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { importId: string }) => input)
  .handler(async ({ context, data }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    return deleteWhatsAppImport(context.supabase, tenantId, data.importId);
  });
