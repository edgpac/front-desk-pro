import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  PROFILE_LIST_FIELDS,
  PROFILE_STRING_FIELDS,
  type CommunicationProfile,
  type ProfileConfidence,
  type ProfileFieldSource,
} from "@/lib/communication-profile";

// Server-side storage for communication_profile_versions /
// communication_profile_decisions (see supabase/migrations/
// 0031_communication_profiles.sql). This is JIR Chat's communication-
// profile persistence layer — it never reads or writes
// price_sheet_items / tenant_capabilities / tenants' policy columns.
// Those remain the sole source of truth for what a business offers,
// charges, or excludes; nothing here can touch them.
//
// Every exported DB-touching function below is a PLAIN function wrapped
// in createServerOnlyFn, not a bare createServerFn — the same pattern
// public-lead-server.ts uses for performCreateClarifyingLead, and for
// the same reason: a bare createServerFn throws "No Start context found
// in AsyncLocalStorage" when called directly outside TanStack Start's
// own server-function runtime, which this test environment does not
// provide (confirmed in price-sheet-server.test.ts's own comment on
// saveMyPriceSheet). createServerOnlyFn-wrapped functions do not have
// this problem and are directly unit-testable with a fake Supabase
// client, which is how every test in communication-profile-server.test.ts
// works. Each createServerFn export at the bottom of this file is a thin
// wrapper that resolves tenantId from the AUTHENTICATED session and
// delegates to the matching plain function — it is never given a
// tenantId by the caller.

const VALID_SOURCES: readonly ProfileFieldSource[] = [
  "owner_stated",
  "ai_observed",
  "ai_suggested",
];
const VALID_CONFIDENCE: readonly ProfileConfidence[] = [
  "high",
  "medium",
  "low",
  "insufficient-evidence",
];
const KNOWN_FIELD_KEYS = new Set<string>([
  ...PROFILE_STRING_FIELDS.map(([k]) => k),
  ...PROFILE_LIST_FIELDS.map(([k]) => k),
]);
const LIST_FIELD_KEYS = new Set<string>(PROFILE_LIST_FIELDS.map(([k]) => k));

export type CommunicationProfileValidationResult =
  { ok: true; value: CommunicationProfile } | { ok: false; errors: string[] };

// Structural validation of an ALREADY-ASSEMBLED CommunicationProfile
// object, run before anything is persisted and whenever one is read back
// out of the database. Distinct from a future AI-response parser (which
// would validate a model's raw JSON against real message ids — out of
// scope for this phase, which never calls an AI provider): this only
// checks that the object has the shape communication-profile.ts's own
// type describes, so a null, malformed, or unexpectedly-shaped
// profile_json value is rejected with a clear reason rather than
// crashing formatCommunicationProfile/diffCommunicationProfiles
// downstream or being silently persisted as garbage. Mirrors this
// codebase's own validatePriceSheetItem in spirit — the one place that
// actually decides what's allowed to be saved — but returns a list of
// reasons rather than a single message, since a profile has many
// independently-checkable fields.
export function validateCommunicationProfileShape(
  raw: unknown,
): CommunicationProfileValidationResult {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["profile must be a non-null object"] };
  }
  const input = raw as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (key === "generalNotes") continue;
    if (!KNOWN_FIELD_KEYS.has(key)) {
      errors.push(`unknown field "${key}"`);
    }
  }

  if (
    "generalNotes" in input &&
    input["generalNotes"] !== undefined &&
    typeof input["generalNotes"] !== "string"
  ) {
    errors.push('"generalNotes" must be a string when provided');
  }

  for (const [key] of [...PROFILE_STRING_FIELDS, ...PROFILE_LIST_FIELDS]) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== "object" || field === null || Array.isArray(field)) {
      errors.push(`"${key}" must be an object with value/source/confidence/evidence`);
      continue;
    }
    const f = field as Record<string, unknown>;

    const isListField = LIST_FIELD_KEYS.has(key);
    const validValue = isListField
      ? Array.isArray(f["value"]) && f["value"].every((v) => typeof v === "string")
      : typeof f["value"] === "string";
    if (!validValue) {
      errors.push(`"${key}.value" must be ${isListField ? "a list of strings" : "a string"}`);
    }

    if (
      typeof f["source"] !== "string" ||
      !VALID_SOURCES.includes(f["source"] as ProfileFieldSource)
    ) {
      errors.push(`"${key}.source" must be one of ${VALID_SOURCES.join(", ")}`);
    }
    if (
      typeof f["confidence"] !== "string" ||
      !VALID_CONFIDENCE.includes(f["confidence"] as ProfileConfidence)
    ) {
      errors.push(`"${key}.confidence" must be one of ${VALID_CONFIDENCE.join(", ")}`);
    }
    if (
      !Array.isArray(f["evidence"]) ||
      !f["evidence"].every(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as Record<string, unknown>)["messageId"] === "string",
      )
    ) {
      errors.push(`"${key}.evidence" must be a list of { messageId: string }`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as CommunicationProfile };
}

export type ProfileVersionStatus = "pending" | "approved" | "archived" | "rejected";

export type StoredCommunicationProfileVersion = {
  version: number;
  profile: CommunicationProfile;
  sourceLeadIds: string[];
  restoredFromVersion: number | null;
  createdAt: string;
  status: ProfileVersionStatus;
  decidedAt: string | null;
  decidedNote: string | null;
};

type VersionRow = {
  version: number;
  profile_json: unknown;
  source_lead_ids: string[];
  restored_from_version: number | null;
  created_at: string;
};

type DecisionRow = {
  version: number;
  decision: "approved" | "rejected";
  note: string | null;
  decided_at: string;
};

export class InvalidCommunicationProfileError extends Error {
  constructor(errors: string[]) {
    super(`Invalid communication profile: ${errors.join("; ")}`);
    this.name = "InvalidCommunicationProfileError";
  }
}

export class CommunicationProfileNotFoundError extends Error {
  constructor(version: number) {
    super(`No communication profile version #${version} found for this business.`);
    this.name = "CommunicationProfileNotFoundError";
  }
}

export class CommunicationProfileAlreadyDecidedError extends Error {
  constructor(version: number, decision: string) {
    super(
      `Communication profile version #${version} was already ${decision} and cannot be decided again.`,
    );
    this.name = "CommunicationProfileAlreadyDecidedError";
  }
}

// Thrown when the pre-insert existence check in recordCommunicationProfileDecision
// (below) found no decision, but the INSERT itself was then rejected by
// 0032's unique(tenant_id, version) constraint — meaning a concurrent
// call recorded a decision for this exact version in the window between
// this call's check and its own insert. Extends
// CommunicationProfileAlreadyDecidedError so a caller that only wants to
// know "was this already decided" can catch one type regardless of which
// path caught it; unlike that error, this one never claims to know WHAT
// the concurrent decision was — only our own insert's rejection was
// observed, not the row that won.
export class CommunicationProfileDecisionConflictError extends CommunicationProfileAlreadyDecidedError {
  constructor(version: number) {
    super(version, "decided by a concurrent request");
    this.name = "CommunicationProfileDecisionConflictError";
  }
}

// Thrown by createCommunicationProfileVersion when every bounded retry
// attempt (see MAX_VERSION_CREATE_ATTEMPTS below) collided with another
// concurrent version-creation call for the same tenant. Distinct from
// InvalidCommunicationProfileError/CommunicationProfileNotFoundError —
// neither means "the version number itself couldn't be assigned."
export class CommunicationProfileVersionConflictError extends Error {
  constructor(version: number) {
    super(
      `Could not create communication profile version #${version}: repeated conflicts with a concurrent request. Try again.`,
    );
    this.name = "CommunicationProfileVersionConflictError";
  }
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

// Supabase/PostgREST surfaces a Postgres error's SQLSTATE on `.code`. Used
// to distinguish "a concurrent write raced us" (safe to translate into a
// typed app error, or retry) from any other database failure (connection
// reset, permission error, etc.), which must never be retried or silently
// reinterpreted as a conflict.
function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === POSTGRES_UNIQUE_VIOLATION;
}

// Same owner-scoped tenant lookup every other *-server.ts file in this
// codebase already has its own copy of (tenant-server.ts, price-sheet-
// server.ts, capabilities-server.ts, leads-server.ts) — no shared helper
// exists for this anywhere in the codebase today, so a new one isn't
// introduced here either; this follows the established local-copy
// convention rather than inventing a different one for this file alone.
// Exported (unlike its siblings' copies) specifically so the "invalid
// auth context" case Phase 2 was asked to test — an authenticated user
// with no corresponding tenant row — has something to call directly;
// requireSupabaseAuth itself (missing/expired/forged token) is already
// the existing, unmodified auth boundary and isn't retested here.
export async function getTenantId(
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

function deriveStatus(
  version: VersionRow,
  decisions: Map<number, DecisionRow>,
  activeVersion: number | null,
): ProfileVersionStatus {
  const decision = decisions.get(version.version);
  if (!decision) return "pending";
  if (decision.decision === "rejected") return "rejected";
  return version.version === activeVersion ? "approved" : "archived";
}

function toStored(
  version: VersionRow,
  decisions: Map<number, DecisionRow>,
  activeVersion: number | null,
): StoredCommunicationProfileVersion {
  const decision = decisions.get(version.version) ?? null;
  return {
    version: version.version,
    profile: version.profile_json as CommunicationProfile,
    sourceLeadIds: version.source_lead_ids,
    restoredFromVersion: version.restored_from_version,
    createdAt: version.created_at,
    status: deriveStatus(version, decisions, activeVersion),
    decidedAt: decision?.decided_at ?? null,
    decidedNote: decision?.note ?? null,
  };
}

async function fetchAllVersions(
  supabase: Pick<SupabaseClient, "from">,
  tenantId: string,
): Promise<VersionRow[]> {
  const { data, error } = await supabase
    .from("communication_profile_versions")
    .select("version, profile_json, source_lead_ids, restored_from_version, created_at")
    .eq("tenant_id", tenantId)
    .order("version", { ascending: true });
  if (error) throw new Error(`Could not load communication profile versions: ${error.message}`);
  return (data ?? []) as VersionRow[];
}

async function fetchAllDecisions(
  supabase: Pick<SupabaseClient, "from">,
  tenantId: string,
): Promise<Map<number, DecisionRow>> {
  const { data, error } = await supabase
    .from("communication_profile_decisions")
    .select("version, decision, note, decided_at")
    .eq("tenant_id", tenantId)
    .order("decided_at", { ascending: true });
  if (error) throw new Error(`Could not load communication profile decisions: ${error.message}`);
  // Ascending order + Map overwrite means the LAST write for a given
  // version wins if duplicates ever existed (they shouldn't — see
  // recordCommunicationProfileDecision's own guard below — but this
  // degrades to "most recent" rather than throwing on stale/bad data).
  const map = new Map<number, DecisionRow>();
  for (const row of (data ?? []) as DecisionRow[]) map.set(row.version, row);
  return map;
}

function findActiveVersion(decisions: Map<number, DecisionRow>): number | null {
  // "The active profile" is DERIVED — the approved decision with the
  // latest decided_at — never a stored status flag. Mirrors the Phase 1
  // migration's own design comment and the reference implementation's
  // getActiveProfile.
  let active: DecisionRow | null = null;
  for (const decision of decisions.values()) {
    if (decision.decision !== "approved") continue;
    if (!active || decision.decided_at > active.decided_at) active = decision;
  }
  return active?.version ?? null;
}

// ---------------------------------------------------------------------------
// Plain, testable functions — every one takes tenantId as an explicit
// parameter supplied by its caller (the createServerFn wrappers below,
// which resolve it from the authenticated session) and never derives or
// trusts a tenantId from anywhere else. Every query is scoped with
// .eq("tenant_id", tenantId).
// ---------------------------------------------------------------------------

export const listCommunicationProfileVersions = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    tenantId: string,
  ): Promise<StoredCommunicationProfileVersion[]> => {
    const [versions, decisions] = await Promise.all([
      fetchAllVersions(supabase, tenantId),
      fetchAllDecisions(supabase, tenantId),
    ]);
    const activeVersion = findActiveVersion(decisions);
    return versions.map((v) => toStored(v, decisions, activeVersion));
  },
);

export const getCommunicationProfileVersion = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    tenantId: string,
    version: number,
  ): Promise<StoredCommunicationProfileVersion | null> => {
    const [versions, decisions] = await Promise.all([
      fetchAllVersions(supabase, tenantId),
      fetchAllDecisions(supabase, tenantId),
    ]);
    const row = versions.find((v) => v.version === version);
    if (!row) return null;
    const activeVersion = findActiveVersion(decisions);
    return toStored(row, decisions, activeVersion);
  },
);

export const getActiveCommunicationProfile = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    tenantId: string,
  ): Promise<StoredCommunicationProfileVersion | null> => {
    const [versions, decisions] = await Promise.all([
      fetchAllVersions(supabase, tenantId),
      fetchAllDecisions(supabase, tenantId),
    ]);
    const activeVersion = findActiveVersion(decisions);
    if (activeVersion === null) return null;
    const row = versions.find((v) => v.version === activeVersion);
    if (!row) return null;
    return toStored(row, decisions, activeVersion);
  },
);

export const getPendingCommunicationProfileDraft = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    tenantId: string,
  ): Promise<StoredCommunicationProfileVersion | null> => {
    const [versions, decisions] = await Promise.all([
      fetchAllVersions(supabase, tenantId),
      fetchAllDecisions(supabase, tenantId),
    ]);
    const undecided = versions
      .filter((v) => !decisions.has(v.version))
      .sort((a, b) => b.version - a.version);
    if (undecided.length === 0) return null;
    const activeVersion = findActiveVersion(decisions);
    return toStored(undecided[0]!, decisions, activeVersion);
  },
);

export type CreateCommunicationProfileVersionInput = {
  profile: unknown;
  sourceLeadIds?: string[];
  restoredFromVersion?: number | null;
};

// Two concurrent calls for the same tenant can both read the same
// "latest version" below and both compute the same nextVersion. The
// existing unique(tenant_id, version) constraint on this table (0031,
// already applied) stops a duplicate row from ever persisting, but
// without this loop the loser would see a raw unique-violation error
// instead of a predictable outcome. A bounded retry is the smallest safe
// fix: re-reading "latest version" fresh on each attempt is correct
// regardless of how many other calls raced in between, and 3 attempts
// resolves realistic contention (a handful of concurrent calls for one
// tenant) without risking an unbounded loop. Only a unique-violation
// triggers a retry — any other database error (connection reset,
// permission error, etc.) throws immediately, exactly as before.
const MAX_VERSION_CREATE_ATTEMPTS = 3;

// Validates BEFORE touching the database — an invalid profile is never
// written, not even partially. Computes the next version number from
// this tenant's own existing rows (never client-supplied), matching the
// reference implementation's own nextVersionNumber.
export const createCommunicationProfileVersion = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    tenantId: string,
    input: CreateCommunicationProfileVersionInput,
  ): Promise<StoredCommunicationProfileVersion> => {
    const validation = validateCommunicationProfileShape(input.profile);
    if (!validation.ok) throw new InvalidCommunicationProfileError(validation.errors);

    let lastAttemptedVersion = 0;
    for (let attempt = 1; attempt <= MAX_VERSION_CREATE_ATTEMPTS; attempt++) {
      const { data: latest, error: latestError } = await supabase
        .from("communication_profile_versions")
        .select("version")
        .eq("tenant_id", tenantId)
        .order("version", { ascending: false })
        .limit(1);
      if (latestError)
        throw new Error(`Could not determine the next profile version: ${latestError.message}`);
      const nextVersion = ((latest as { version: number }[] | null)?.[0]?.version ?? 0) + 1;
      lastAttemptedVersion = nextVersion;

      const { data: inserted, error: insertError } = await supabase
        .from("communication_profile_versions")
        .insert({
          tenant_id: tenantId,
          version: nextVersion,
          profile_json: validation.value,
          source_lead_ids: input.sourceLeadIds ?? [],
          restored_from_version: input.restoredFromVersion ?? null,
        })
        .select("version, profile_json, source_lead_ids, restored_from_version, created_at")
        .single();

      if (!insertError && inserted) {
        return toStored(inserted as VersionRow, new Map(), null);
      }
      if (insertError && !isUniqueViolation(insertError)) {
        throw new Error(`Could not save communication profile version: ${insertError.message}`);
      }
      // Unique violation: another call took this version number first.
      // Loop and recompute nextVersion from fresh data on the next attempt.
    }

    throw new CommunicationProfileVersionConflictError(lastAttemptedVersion);
  },
);

export type RecordCommunicationProfileDecisionInput = {
  version: number;
  decision: "approved" | "rejected";
  note?: string | null;
};

// The core duplicate/conflicting-decision guard: reads for an existing
// decision on this exact (tenantId, version) BEFORE inserting a new one,
// and throws rather than silently allowing a second, possibly
// contradictory decision for the same version. This is an APPLICATION-
// LEVEL guard, not a database constraint — see the Phase 1 independent
// review's own finding that communication_profile_decisions has no
// unique(tenant_id, version) constraint. A race between two concurrent
// calls could still both pass this check before either inserts; closing
// that fully would need the schema change the Phase 1 review proposed,
// which is NOT applied here (see this phase's final report).
export const recordCommunicationProfileDecision = createServerOnlyFn(
  async (
    supabase: Pick<SupabaseClient, "from">,
    tenantId: string,
    input: RecordCommunicationProfileDecisionInput,
  ): Promise<StoredCommunicationProfileVersion> => {
    const { data: versionRow, error: versionError } = await supabase
      .from("communication_profile_versions")
      .select("version, profile_json, source_lead_ids, restored_from_version, created_at")
      .eq("tenant_id", tenantId)
      .eq("version", input.version)
      .maybeSingle();
    if (versionError)
      throw new Error(`Could not load communication profile version: ${versionError.message}`);
    if (!versionRow) throw new CommunicationProfileNotFoundError(input.version);

    const { data: existingDecision, error: existingError } = await supabase
      .from("communication_profile_decisions")
      .select("decision")
      .eq("tenant_id", tenantId)
      .eq("version", input.version)
      .maybeSingle();
    if (existingError)
      throw new Error(`Could not check for an existing decision: ${existingError.message}`);
    if (existingDecision) {
      throw new CommunicationProfileAlreadyDecidedError(
        input.version,
        (existingDecision as { decision: string }).decision,
      );
    }

    const { error: insertError } = await supabase.from("communication_profile_decisions").insert({
      tenant_id: tenantId,
      version: input.version,
      decision: input.decision,
      note: input.note ?? null,
    });
    if (insertError) {
      // A concurrent call recorded a decision for this exact version
      // between our existence check above and this insert — 0032's
      // unique(tenant_id, version) constraint caught it. Translate into
      // the same typed error family the pre-check above throws, so a
      // caller never mistakes this rejection for a successful decision.
      if (isUniqueViolation(insertError)) {
        throw new CommunicationProfileDecisionConflictError(input.version);
      }
      throw new Error(`Could not record the decision: ${insertError.message}`);
    }

    const [versions, decisions] = await Promise.all([
      fetchAllVersions(supabase, tenantId),
      fetchAllDecisions(supabase, tenantId),
    ]);
    const row = versions.find((v) => v.version === input.version)!;
    const activeVersion = findActiveVersion(decisions);
    return toStored(row, decisions, activeVersion);
  },
);

// ---------------------------------------------------------------------------
// createServerFn wrappers — the only client-facing RPC surface. Every one
// resolves tenantId from the authenticated session via requireSupabaseAuth
// + getTenantId, exactly like every other dashboard feature in this
// codebase, and uses the caller's own RLS-scoped supabase client (never
// the admin/service-role client) — profile operations are always
// performed as the owner, never on their behalf without their session.
// ---------------------------------------------------------------------------

export const listMyCommunicationProfileVersions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    return listCommunicationProfileVersions(context.supabase, tenantId);
  });

export const getMyActiveCommunicationProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    return getActiveCommunicationProfile(context.supabase, tenantId);
  });

export const getMyPendingCommunicationProfileDraft = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    return getPendingCommunicationProfileDraft(context.supabase, tenantId);
  });

export const createMyCommunicationProfileVersion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: CreateCommunicationProfileVersionInput) => input)
  .handler(async ({ context, data }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    return createCommunicationProfileVersion(context.supabase, tenantId, data);
  });

export const recordMyCommunicationProfileDecision = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: RecordCommunicationProfileDecisionInput) => input)
  .handler(async ({ context, data }) => {
    const tenantId = await getTenantId(context.supabase, context.userId);
    return recordCommunicationProfileDecision(context.supabase, tenantId, data);
  });
