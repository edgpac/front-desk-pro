import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CommunicationProfileAlreadyDecidedError,
  CommunicationProfileDecisionConflictError,
  CommunicationProfileNotFoundError,
  CommunicationProfileVersionConflictError,
  InvalidCommunicationProfileError,
  createCommunicationProfileVersion,
  getActiveCommunicationProfile,
  getCommunicationProfileVersion,
  getPendingCommunicationProfileDraft,
  getTenantId,
  listCommunicationProfileVersions,
  recordCommunicationProfileDecision,
  validateCommunicationProfileShape,
} from "./communication-profile-server";
import type { CommunicationProfile, ProfileFieldValue } from "./communication-profile";

// Generic in-memory fake for a Supabase table, built specifically to
// support the exact chains this file's functions issue:
//   select(cols).eq(...).eq(...).order(...)            -> awaited directly
//   select(cols).eq(...).eq(...).order(...).limit(n)    -> awaited directly
//   select(cols).eq(...).eq(...).single()/.maybeSingle()
//   insert(row).select(cols).single()
//   insert(row)                                         -> awaited directly
// Mirrors capabilities-server.test.ts's fakeAdmin in spirit (a minimal
// object implementing exactly the chains under test, recording calls),
// scaled up to a shared in-memory array since several of this file's
// functions issue multiple sequential queries against the SAME table
// and later tests need to observe the effect of an earlier insert.
type Row = Record<string, unknown>;

function fakeTable(
  rows: Row[],
  opts: {
    error?: { message: string };
    // Simulates a Postgres unique-violation (or any other error) landing
    // specifically on an INSERT rather than on every operation — needed
    // to test the concurrency-conflict paths without disturbing the
    // SELECTs those same functions issue first. insertErrorCount bounds
    // how many insert attempts fail before inserts start succeeding
    // (omitted = every insert attempt on this table fails), modeling a
    // concurrent call that eventually stops colliding.
    insertError?: { message: string; code?: string };
    insertErrorCount?: number;
    // What a real unique-violation actually means: a row occupying that
    // key already exists. Pushed into `rows` as a side effect of a
    // failed insert, standing in for "the concurrent call that actually
    // won" — so a subsequent SELECT (the retry's re-read) sees it, the
    // same way a real re-read would see the real winning row.
    insertErrorConflictingRow?: Row;
  } = {},
) {
  const calls: Array<{ op: "select" | "insert"; filters: Record<string, unknown> }> = [];
  let insertAttempts = 0;

  function builder() {
    const filters: Record<string, unknown> = {};
    let op: "select" | "insert" = "select";
    let insertedRow: Row | null = null;
    let insertFailed = false;
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let selected = false;

    function applyRead(): Row[] {
      let result = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
      if (orderCol) {
        const col = orderCol;
        result = [...result].sort((a, b) => {
          const av = a[col] as number | string;
          const bv = b[col] as number | string;
          if (av < bv) return orderAsc ? -1 : 1;
          if (av > bv) return orderAsc ? 1 : -1;
          return 0;
        });
      }
      if (limitN !== null) result = result.slice(0, limitN);
      return result;
    }

    const api = {
      select() {
        selected = true;
        return api;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return api;
      },
      order(col: string, settings?: { ascending?: boolean }) {
        orderCol = col;
        orderAsc = settings?.ascending ?? true;
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      insert(row: Row) {
        op = "insert";
        insertedRow = row;
        insertAttempts += 1;
        const shouldFail =
          opts.insertError !== undefined &&
          (opts.insertErrorCount === undefined || insertAttempts <= opts.insertErrorCount);
        if (shouldFail) {
          insertFailed = true;
          if (opts.insertErrorConflictingRow) rows.push(opts.insertErrorConflictingRow);
        } else {
          rows.push(row);
        }
        calls.push({ op: "insert", filters: { ...row } });
        return api;
      },
      single() {
        if (opts.error) return Promise.resolve({ data: null, error: opts.error });
        if (op === "insert") {
          if (insertFailed) return Promise.resolve({ data: null, error: opts.insertError });
          return Promise.resolve({ data: insertedRow, error: null });
        }
        calls.push({ op: "select", filters: { ...filters } });
        const result = applyRead();
        if (result.length !== 1)
          return Promise.resolve({ data: null, error: { message: "not found" } });
        return Promise.resolve({ data: result[0], error: null });
      },
      maybeSingle() {
        if (opts.error) return Promise.resolve({ data: null, error: opts.error });
        calls.push({ op: "select", filters: { ...filters } });
        const result = applyRead();
        return Promise.resolve({ data: result[0] ?? null, error: null });
      },
      then(resolve: (v: { data: unknown; error: unknown }) => void) {
        if (opts.error) return resolve({ data: null, error: opts.error });
        if (op === "insert") {
          if (insertFailed) return resolve({ data: null, error: opts.insertError });
          return resolve({ data: selected ? insertedRow : null, error: null });
        }
        calls.push({ op: "select", filters: { ...filters } });
        resolve({ data: applyRead(), error: null });
      },
    };
    return api;
  }

  return { from: () => builder(), calls, rows };
}

function fakeClient(
  tables: Record<string, ReturnType<typeof fakeTable>>,
): Pick<SupabaseClient, "from"> {
  return {
    from: (table: string) => {
      const t = tables[table];
      if (!t) throw new Error(`unexpected table "${table}"`);
      return t.from() as never;
    },
  } as unknown as Pick<SupabaseClient, "from">;
}

function strField(value: string): ProfileFieldValue<string> {
  return {
    value,
    source: "ai_observed",
    confidence: "high",
    evidence: [{ messageId: "11111111-1111-1111-1111-111111111111" }],
  };
}

const VALID_PROFILE: CommunicationProfile = { toneAndStyle: strField("friendly and concise") };

describe("getTenantId", () => {
  it("returns the tenant id for the given authenticated user", async () => {
    const tenants = fakeTable([{ id: "tenant-A", user_id: "user-A" }]);
    await expect(getTenantId(fakeClient({ tenants }), "user-A")).resolves.toBe("tenant-A");
  });

  it("throws rather than returning undefined when the user has no tenant row (invalid auth context)", async () => {
    const tenants = fakeTable([]);
    await expect(getTenantId(fakeClient({ tenants }), "ghost-user")).rejects.toThrow(
      /Could not load your business/,
    );
  });

  it("throws when the underlying query errors", async () => {
    const tenants = fakeTable([], { error: { message: "connection reset" } });
    await expect(getTenantId(fakeClient({ tenants }), "user-A")).rejects.toThrow(
      /connection reset/,
    );
  });
});

describe("validateCommunicationProfileShape", () => {
  it("accepts a well-formed profile", () => {
    const result = validateCommunicationProfileShape(VALID_PROFILE);
    expect(result.ok).toBe(true);
  });

  it("accepts an empty object (no fields set yet)", () => {
    expect(validateCommunicationProfileShape({}).ok).toBe(true);
  });

  it("rejects null", () => {
    const result = validateCommunicationProfileShape(null);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(validateCommunicationProfileShape("not an object").ok).toBe(false);
    expect(validateCommunicationProfileShape(42).ok).toBe(false);
    expect(validateCommunicationProfileShape(undefined).ok).toBe(false);
  });

  it("rejects an unknown top-level field", () => {
    const result = validateCommunicationProfileShape({ someMadeUpField: strField("x") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("someMadeUpField"))).toBe(true);
  });

  it("rejects a string field whose value is an array instead of a string", () => {
    const result = validateCommunicationProfileShape({
      toneAndStyle: { ...strField("x"), value: ["oops"] },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a list field whose value is a string instead of an array", () => {
    const result = validateCommunicationProfileShape({ prohibitedClaims: { ...strField("x") } });
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid confidence value", () => {
    const result = validateCommunicationProfileShape({
      toneAndStyle: { ...strField("x"), confidence: "very sure" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid source value", () => {
    const result = validateCommunicationProfileShape({
      toneAndStyle: { ...strField("x"), source: "made_up" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects evidence entries missing messageId", () => {
    const result = validateCommunicationProfileShape({
      toneAndStyle: { ...strField("x"), evidence: [{}] },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts generalNotes as a string and rejects it as a non-string", () => {
    expect(validateCommunicationProfileShape({ generalNotes: "be warm" }).ok).toBe(true);
    expect(validateCommunicationProfileShape({ generalNotes: 123 }).ok).toBe(false);
  });

  it("accepts generalNotes in the evidence-backed object shape too", () => {
    const result = validateCommunicationProfileShape({
      generalNotes: {
        value: "be warm",
        source: "ai_observed",
        confidence: "high",
        evidence: [{ messageId: "11111111-1111-1111-1111-111111111111" }],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed evidence-backed generalNotes object (invalid confidence)", () => {
    const result = validateCommunicationProfileShape({
      generalNotes: {
        value: "be warm",
        source: "ai_observed",
        confidence: "very sure",
        evidence: [],
      },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed evidence-backed generalNotes object (evidence missing messageId)", () => {
    const result = validateCommunicationProfileShape({
      generalNotes: { value: "be warm", source: "ai_observed", confidence: "high", evidence: [{}] },
    });
    expect(result.ok).toBe(false);
  });
});

describe("createCommunicationProfileVersion", () => {
  it("rejects an invalid profile before touching the database", async () => {
    const versions = fakeTable([]);
    const client = fakeClient({ communication_profile_versions: versions });
    await expect(
      createCommunicationProfileVersion(client, "tenant-A", { profile: null }),
    ).rejects.toThrow(InvalidCommunicationProfileError);
    expect(versions.rows).toHaveLength(0);
  });

  it("creates version 1 for a tenant with no existing versions", async () => {
    const versions = fakeTable([]);
    const client = fakeClient({ communication_profile_versions: versions });
    const created = await createCommunicationProfileVersion(client, "tenant-A", {
      profile: VALID_PROFILE,
      sourceImportIds: ["lead-1"],
    });
    expect(created.version).toBe(1);
    expect(created.sourceImportIds).toEqual(["lead-1"]);
    expect(created.status).toBe("pending");
  });

  it("assigns the next version number per tenant, never reusing or colliding with an existing one", async () => {
    const versions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
      {
        tenant_id: "tenant-A",
        version: 2,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t2",
      },
    ]);
    const client = fakeClient({ communication_profile_versions: versions });
    const created = await createCommunicationProfileVersion(client, "tenant-A", {
      profile: VALID_PROFILE,
    });
    expect(created.version).toBe(3);
  });

  it("scopes the next-version lookup to the given tenant, ignoring other tenants' versions", async () => {
    const versions = fakeTable([
      {
        tenant_id: "tenant-B",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
      {
        tenant_id: "tenant-B",
        version: 2,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t2",
      },
    ]);
    const client = fakeClient({ communication_profile_versions: versions });
    const created = await createCommunicationProfileVersion(client, "tenant-A", {
      profile: VALID_PROFILE,
    });
    expect(created.version).toBe(1);
  });

  it("retries once and succeeds when a single concurrent insert collides on the version number", async () => {
    // Models true concurrency as closely as a sequential fake can: both
    // calls' SELECTs would have seen an empty table and both computed
    // nextVersion = 1, but the OTHER call's insert actually lands first.
    // Our own first insert attempt fails with a unique violation, and
    // that concurrent winner's row (version 1) becomes visible in the
    // backing table as a side effect — exactly what a real re-read would
    // see. The retry re-reads "latest version", now sees version 1, and
    // succeeds with version 2. This proves the retry loop's logic
    // against a simulated error code — it does not exercise real
    // Postgres concurrency (see the final report).
    const versions = fakeTable([], {
      insertError: { message: "duplicate key value violates unique constraint", code: "23505" },
      insertErrorCount: 1,
      insertErrorConflictingRow: {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "concurrent-winner",
      },
    });
    const client = fakeClient({ communication_profile_versions: versions });
    const created = await createCommunicationProfileVersion(client, "tenant-A", {
      profile: VALID_PROFILE,
    });
    expect(created.version).toBe(2);
    expect(versions.rows).toHaveLength(2);
  });

  it("throws CommunicationProfileVersionConflictError after exhausting all retry attempts", async () => {
    const versions = fakeTable([], {
      insertError: { message: "duplicate key value violates unique constraint", code: "23505" },
      // insertErrorCount omitted: every attempt fails.
    });
    const client = fakeClient({ communication_profile_versions: versions });
    await expect(
      createCommunicationProfileVersion(client, "tenant-A", { profile: VALID_PROFILE }),
    ).rejects.toThrow(CommunicationProfileVersionConflictError);
    expect(versions.rows).toHaveLength(0);
  });

  it("does not retry a non-conflict database error on insert — it throws immediately", async () => {
    const versions = fakeTable([], {
      insertError: { message: "connection reset", code: "08006" },
    });
    const client = fakeClient({ communication_profile_versions: versions });
    await expect(
      createCommunicationProfileVersion(client, "tenant-A", { profile: VALID_PROFILE }),
    ).rejects.toThrow(/connection reset/);
    // Exactly one insert attempt — a non-conflict error must not be retried.
    expect(versions.calls.filter((c) => c.op === "insert")).toHaveLength(1);
  });
});

describe("listCommunicationProfileVersions / getCommunicationProfileVersion / status derivation", () => {
  function seeded() {
    const versions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: { toneAndStyle: strField("v1") },
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
      {
        tenant_id: "tenant-A",
        version: 2,
        profile_json: { toneAndStyle: strField("v2") },
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t2",
      },
      {
        tenant_id: "tenant-A",
        version: 3,
        profile_json: { toneAndStyle: strField("v3") },
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t3",
      },
      {
        tenant_id: "tenant-B",
        version: 1,
        profile_json: { toneAndStyle: strField("other tenant") },
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
    ]);
    const decisions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        decision: "rejected",
        note: "too stiff",
        decided_at: "d1",
      },
      { tenant_id: "tenant-A", version: 2, decision: "approved", note: null, decided_at: "d2" },
    ]);
    return fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });
  }

  it("derives rejected / approved / pending status per version and never returns another tenant's versions", async () => {
    const result = await listCommunicationProfileVersions(seeded(), "tenant-A");
    expect(result.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(result.find((v) => v.version === 1)?.status).toBe("rejected");
    expect(result.find((v) => v.version === 2)?.status).toBe("approved");
    expect(result.find((v) => v.version === 3)?.status).toBe("pending");
  });

  it("getCommunicationProfileVersion returns null for a version number that does not exist for this tenant", async () => {
    await expect(getCommunicationProfileVersion(seeded(), "tenant-A", 99)).resolves.toBeNull();
  });

  it("getCommunicationProfileVersion cannot be used to read another tenant's version by number", async () => {
    // tenant-B has a version 1, but asking as tenant-A must not return it.
    const result = await getCommunicationProfileVersion(seeded(), "tenant-A", 1);
    expect(result?.profile).toEqual({ toneAndStyle: strField("v1") });
  });
});

describe("active profile and pending draft derivation", () => {
  it("archives a previously-approved version once a later one is approved — active is always the LATEST approval, never a flag", async () => {
    const versions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: { toneAndStyle: strField("v1") },
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
      {
        tenant_id: "tenant-A",
        version: 2,
        profile_json: { toneAndStyle: strField("v2") },
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t2",
      },
    ]);
    const decisions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        decision: "approved",
        note: null,
        decided_at: "2026-01-01",
      },
      {
        tenant_id: "tenant-A",
        version: 2,
        decision: "approved",
        note: null,
        decided_at: "2026-02-01",
      },
    ]);
    const client = fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });

    const active = await getActiveCommunicationProfile(client, "tenant-A");
    expect(active?.version).toBe(2);

    const list = await listCommunicationProfileVersions(client, "tenant-A");
    expect(list.find((v) => v.version === 1)?.status).toBe("archived");
    expect(list.find((v) => v.version === 2)?.status).toBe("approved");
  });

  it("getActiveCommunicationProfile returns null when nothing has ever been approved", async () => {
    const versions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
    ]);
    const decisions = fakeTable([
      { tenant_id: "tenant-A", version: 1, decision: "rejected", note: null, decided_at: "d1" },
    ]);
    const client = fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });
    await expect(getActiveCommunicationProfile(client, "tenant-A")).resolves.toBeNull();
  });

  it("getPendingCommunicationProfileDraft returns the highest-numbered undecided version", async () => {
    const versions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
      {
        tenant_id: "tenant-A",
        version: 2,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t2",
      },
      {
        tenant_id: "tenant-A",
        version: 3,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t3",
      },
    ]);
    const decisions = fakeTable([
      { tenant_id: "tenant-A", version: 1, decision: "approved", note: null, decided_at: "d1" },
    ]);
    const client = fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });
    const draft = await getPendingCommunicationProfileDraft(client, "tenant-A");
    expect(draft?.version).toBe(3);
  });

  it("getPendingCommunicationProfileDraft returns null when every version has a decision", async () => {
    const versions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
    ]);
    const decisions = fakeTable([
      { tenant_id: "tenant-A", version: 1, decision: "approved", note: null, decided_at: "d1" },
    ]);
    const client = fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });
    await expect(getPendingCommunicationProfileDraft(client, "tenant-A")).resolves.toBeNull();
  });
});

describe("recordCommunicationProfileDecision", () => {
  it("records an approval for an existing, undecided version", async () => {
    const versions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
    ]);
    const decisions = fakeTable([]);
    const client = fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });

    const result = await recordCommunicationProfileDecision(client, "tenant-A", {
      version: 1,
      decision: "approved",
    });
    expect(result.status).toBe("approved");
    expect(decisions.rows).toHaveLength(1);
    expect(decisions.rows[0]).toMatchObject({
      tenant_id: "tenant-A",
      version: 1,
      decision: "approved",
    });
  });

  it("throws CommunicationProfileNotFoundError for a version that does not exist for this tenant", async () => {
    const versions = fakeTable([]);
    const decisions = fakeTable([]);
    const client = fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });
    await expect(
      recordCommunicationProfileDecision(client, "tenant-A", { version: 1, decision: "approved" }),
    ).rejects.toThrow(CommunicationProfileNotFoundError);
  });

  it("refuses to decide a version that already has a decision — prevents conflicting/duplicate decisions", async () => {
    const versions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
    ]);
    const decisions = fakeTable([
      { tenant_id: "tenant-A", version: 1, decision: "approved", note: null, decided_at: "d1" },
    ]);
    const client = fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });

    await expect(
      recordCommunicationProfileDecision(client, "tenant-A", { version: 1, decision: "rejected" }),
    ).rejects.toThrow(CommunicationProfileAlreadyDecidedError);
    // The guard must reject BEFORE inserting a second, conflicting row.
    expect(decisions.rows).toHaveLength(1);
  });

  it("a version that does not exist for THIS tenant cannot be decided, even if it exists for another tenant", async () => {
    const versions = fakeTable([
      {
        tenant_id: "tenant-B",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
    ]);
    const decisions = fakeTable([]);
    const client = fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });
    await expect(
      recordCommunicationProfileDecision(client, "tenant-A", { version: 1, decision: "approved" }),
    ).rejects.toThrow(CommunicationProfileNotFoundError);
    expect(decisions.rows).toHaveLength(0);
  });

  it("throws CommunicationProfileDecisionConflictError when a concurrent decision wins the race at INSERT time", async () => {
    // Models: the pre-insert existence check (above) found nothing — no
    // decision existed yet — but a concurrent call recorded one in the
    // gap before this call's own insert landed, and 0032's
    // unique(tenant_id, version) constraint rejected it. This proves the
    // error-translation logic against a simulated error code; it does
    // not exercise real Postgres concurrency (see the final report).
    const versions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
    ]);
    const decisions = fakeTable([], {
      insertError: { message: "duplicate key value violates unique constraint", code: "23505" },
    });
    const client = fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });

    await expect(
      recordCommunicationProfileDecision(client, "tenant-A", { version: 1, decision: "approved" }),
    ).rejects.toThrow(CommunicationProfileDecisionConflictError);
    // A caller catching the broader CommunicationProfileAlreadyDecidedError
    // family must also catch this — it's a subclass, not a sibling.
    await expect(
      recordCommunicationProfileDecision(client, "tenant-A", { version: 1, decision: "approved" }),
    ).rejects.toThrow(CommunicationProfileAlreadyDecidedError);
    // The conflicting insert must never actually land as a persisted row.
    expect(decisions.rows).toHaveLength(0);
  });

  it("does not mistranslate a non-conflict database error into a decision-conflict error", async () => {
    const versions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
    ]);
    const decisions = fakeTable([], {
      insertError: { message: "connection reset", code: "08006" },
    });
    const client = fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });
    await expect(
      recordCommunicationProfileDecision(client, "tenant-A", { version: 1, decision: "approved" }),
    ).rejects.toThrow(/connection reset/);
  });
});

describe("cross-tenant isolation of every query this file issues", () => {
  it("createCommunicationProfileVersion stamps the row with the given tenantId and nothing else", async () => {
    const versions = fakeTable([]);
    const client = fakeClient({ communication_profile_versions: versions });
    await createCommunicationProfileVersion(client, "tenant-A", { profile: VALID_PROFILE });
    expect(versions.rows[0]?.["tenant_id"]).toBe("tenant-A");
  });

  it("every read against communication_profile_versions filters by the given tenant_id", async () => {
    const versions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
      {
        tenant_id: "tenant-B",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
    ]);
    const decisions = fakeTable([]);
    const client = fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });
    const result = await listCommunicationProfileVersions(client, "tenant-A");
    expect(result).toHaveLength(1);
    expect(
      versions.calls.every((c) => c.filters["tenant_id"] === "tenant-A" || c.op === "insert"),
    ).toBe(true);
  });

  it("recordCommunicationProfileDecision stamps the decision with the given tenantId", async () => {
    const versions = fakeTable([
      {
        tenant_id: "tenant-A",
        version: 1,
        profile_json: VALID_PROFILE,
        source_import_ids: [],
        restored_from_version: null,
        created_at: "t1",
      },
    ]);
    const decisions = fakeTable([]);
    const client = fakeClient({
      communication_profile_versions: versions,
      communication_profile_decisions: decisions,
    });
    await recordCommunicationProfileDecision(client, "tenant-A", {
      version: 1,
      decision: "approved",
    });
    expect(decisions.rows[0]?.["tenant_id"]).toBe("tenant-A");
  });
});
