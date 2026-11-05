import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import {
  AccountDeletionInProgressError,
  performDeleteCustomerData,
  performDeleteMyAccount,
} from "./account-deletion-server";

// Generic in-memory fake Postgres, shaped only to the operations this
// file's functions actually issue (select/insert/update/delete, eq/neq,
// maybeSingle/single, delete({count:"exact"})) — same "local fake, not a
// shared mock framework" convention as whatsapp-import-server.test.ts's
// own fakeTable. One `tables` object is shared between the fake
// "supabase" (RLS-scoped) and "admin" client views below, the same way a
// real RLS-scoped client and a real admin client both ultimately read and
// write the same underlying Postgres rows.
type Row = Record<string, unknown>;
type Filter = { col: string; op: "eq" | "neq"; val: unknown };

function makeFakeClient(tables: Record<string, Row[]>) {
  function from(table: string) {
    const rowsFor = () => (tables[table] ??= []);
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    const filters: Filter[] = [];
    let wantCount = false;
    let returnAfterWrite = false;
    let insertSeq = 0;

    function rowMatches(row: Row) {
      return filters.every((f) => (f.op === "eq" ? row[f.col] === f.val : row[f.col] !== f.val));
    }
    function currentMatches() {
      return rowsFor().filter(rowMatches);
    }

    async function resolve(): Promise<{ data: unknown; error: unknown; count: number | null }> {
      if (mode === "select") {
        const result = currentMatches();
        return { data: result, error: null, count: wantCount ? result.length : null };
      }
      if (mode === "insert") {
        const toInsert = (Array.isArray(payload) ? payload : [payload as Row]).map((r) => ({
          id: `gen-${table}-${insertSeq++}`,
          ...r,
        }));
        rowsFor().push(...toInsert);
        return { data: returnAfterWrite ? toInsert : null, error: null, count: null };
      }
      if (mode === "update") {
        const target = currentMatches();
        for (const row of target) Object.assign(row, payload);
        return { data: returnAfterWrite ? target : null, error: null, count: null };
      }
      // delete
      const toDelete = currentMatches();
      tables[table] = rowsFor().filter((r) => !rowMatches(r));
      return { data: null, error: null, count: wantCount ? toDelete.length : null };
    }

    const builder = {
      select() {
        if (mode === "select") return builder;
        returnAfterWrite = true;
        return builder;
      },
      insert(rowOrRows: Row | Row[]) {
        mode = "insert";
        payload = rowOrRows;
        return builder;
      },
      update(partial: Row) {
        mode = "update";
        payload = partial;
        return builder;
      },
      delete(opts?: { count?: string }) {
        mode = "delete";
        if (opts?.count) wantCount = true;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push({ col, op: "eq", val });
        return builder;
      },
      neq(col: string, val: unknown) {
        filters.push({ col, op: "neq", val });
        return builder;
      },
      async maybeSingle() {
        const result = currentMatches();
        return result.length === 0 ? { data: null, error: null } : { data: result[0], error: null };
      },
      async single() {
        const result = mode === "insert" || mode === "update" ? await resolve() : null;
        if (result) {
          const rows = (result.data as Row[] | null) ?? [];
          return rows.length === 1
            ? { data: rows[0], error: null }
            : { data: null, error: { message: "not found" } };
        }
        const matched = currentMatches();
        return matched.length === 1
          ? { data: matched[0], error: null }
          : { data: null, error: { message: "not found" } };
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return resolve().then(onFulfilled, onRejected);
      },
    };
    return builder;
  }
  // Cast once here, matching whatsapp-import-server.test.ts's own
  // fakeClient — this fake is structurally shaped to exactly the subset
  // of PostgrestQueryBuilder these functions call, not the real
  // (much larger) generated type.
  return { from } as unknown as Pick<SupabaseClient, "from">;
}

function fakeAdminWithAuth(
  tables: Record<string, Row[]>,
  deleteUser: (userId: string) => Promise<{ error: { message: string } | null }> = vi.fn(
    async () => ({
      error: null,
    }),
  ),
) {
  const client = makeFakeClient(tables);
  return Object.assign(client, { auth: { admin: { deleteUser } } }) as unknown as SupabaseClient;
}

// Returned untyped (not cast to Stripe) so tests can still call
// .mockRejectedValueOnce etc. on list/cancel directly — cast to Stripe
// only at each call site below, via asStripe().
function fakeStripe(opts: { liveSubscriptions?: Array<{ id: string; status: string }> } = {}) {
  const cancel = vi.fn(async () => ({}));
  const list = vi.fn(async () => ({
    data: opts.liveSubscriptions ?? [{ id: "sub_1", status: "active" }],
  }));
  return { subscriptions: { list, cancel } };
}
function asStripe(fake: ReturnType<typeof fakeStripe>): Stripe {
  return fake as unknown as Stripe;
}

function baseTenantRow(id: string, extra: Row = {}): Row {
  return { id, user_id: `user-${id}`, slug: `tenant-${id}`, ...extra };
}

describe("performDeleteCustomerData", () => {
  it("deletes leads and WhatsApp imports but preserves business configuration", async () => {
    const tables: Record<string, Row[]> = {
      whatsapp_imports: [{ id: "imp-1", tenant_id: "tenant-A" }],
      leads: [
        { id: "lead-1", tenant_id: "tenant-A" },
        { id: "lead-2", tenant_id: "tenant-A" },
      ],
      whatsapp_import_messages: [{ id: "msg-1", import_id: "imp-1" }],
      communication_profile_versions: [{ version: 1, tenant_id: "tenant-A", profile_json: {} }],
      price_sheet_items: [{ id: "price-1", tenant_id: "tenant-A" }],
      whatsapp_connections: [{ id: "conn-1", tenant_id: "tenant-A", status: "connected" }],
      whatsapp_opt_outs: [{ tenant_id: "tenant-A", phone: "+15551234567" }],
      tenants: [baseTenantRow("tenant-A")],
      audit_log: [],
    };
    const supabase = makeFakeClient(tables);
    const admin = fakeAdminWithAuth(tables);

    const result = await performDeleteCustomerData(supabase, admin, "tenant-A", "user-tenant-A");

    expect(result).toEqual({
      ok: true,
      deletedLeads: 2,
      deletedWhatsAppImports: 1,
      affectedProfileVersions: [],
    });
    expect(tables["leads"]).toHaveLength(0);
    expect(tables["whatsapp_imports"]).toHaveLength(0);
    // Preserved — business configuration and compliance records, not
    // customer conversation data.
    expect(tables["price_sheet_items"]).toHaveLength(1);
    expect(tables["whatsapp_connections"]).toHaveLength(1);
    expect(tables["whatsapp_opt_outs"]).toHaveLength(1);
    expect(tables["communication_profile_versions"]).toHaveLength(1);
    expect(tables["tenants"]).toHaveLength(1);
    // Audit trail recorded.
    expect(tables["audit_log"]).toHaveLength(1);
    expect(tables["audit_log"]![0]!["action"]).toBe("customer_data.deleted");
  });

  it("reports which communication-profile versions cite deleted import evidence, without deleting the profile", async () => {
    const tables: Record<string, Row[]> = {
      whatsapp_imports: [{ id: "imp-1", tenant_id: "tenant-A" }],
      leads: [],
      whatsapp_import_messages: [{ id: "msg-cited", import_id: "imp-1" }],
      communication_profile_versions: [
        {
          version: 3,
          tenant_id: "tenant-A",
          profile_json: {
            toneAndStyle: {
              value: "Friendly and casual",
              source: "ai_observed",
              confidence: "high",
              evidence: [{ messageId: "msg-cited" }],
            },
          },
        },
      ],
      audit_log: [],
    };
    const supabase = makeFakeClient(tables);
    const admin = fakeAdminWithAuth(tables);

    const result = await performDeleteCustomerData(supabase, admin, "tenant-A", "user-tenant-A");

    expect(result.affectedProfileVersions).toEqual([3]);
    expect(tables["communication_profile_versions"]).toHaveLength(1);
  });

  it("tenant isolation — never touches another tenant's leads or imports", async () => {
    const tables: Record<string, Row[]> = {
      whatsapp_imports: [
        { id: "imp-A", tenant_id: "tenant-A" },
        { id: "imp-B", tenant_id: "tenant-B" },
      ],
      leads: [
        { id: "lead-A", tenant_id: "tenant-A" },
        { id: "lead-B", tenant_id: "tenant-B" },
      ],
      whatsapp_import_messages: [],
      communication_profile_versions: [],
      audit_log: [],
    };
    const supabase = makeFakeClient(tables);
    const admin = fakeAdminWithAuth(tables);

    await performDeleteCustomerData(supabase, admin, "tenant-A", "user-tenant-A");

    expect(tables["leads"]).toEqual([{ id: "lead-B", tenant_id: "tenant-B" }]);
    expect(tables["whatsapp_imports"]).toEqual([{ id: "imp-B", tenant_id: "tenant-B" }]);
  });
});

describe("performDeleteMyAccount", () => {
  it("cancels Stripe, disconnects WhatsApp, cleans up orphans, and deletes the auth user", async () => {
    const tables: Record<string, Row[]> = {
      subscription_state: [{ user_id: "user-A", stripe_customer_id: "cus_A" }],
      whatsapp_connections: [], // nothing to disconnect
      stripe_webhook_claims: [{ user_id: "user-A", claim_token: "tok-1" }],
      account_deletion_requests: [],
      audit_log: [],
    };
    const supabase = makeFakeClient(tables);
    const deleteUser = vi.fn(async () => ({ error: null }));
    const admin = fakeAdminWithAuth(tables, deleteUser);
    const stripe = fakeStripe();

    const result = await performDeleteMyAccount(
      supabase,
      admin,
      asStripe(stripe),
      "tenant-A",
      "user-A",
    );

    expect(result.ok).toBe(true);
    expect(result.stripeCancelled).toBe(true);
    expect(result.whatsappDisconnected).toBeNull(); // nothing to disconnect
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_1");
    expect(deleteUser).toHaveBeenCalledWith("user-A");
    // Orphan cleanup: the FK-less stripe_webhook_claims row is gone.
    expect(tables["stripe_webhook_claims"]).toHaveLength(0);
  });

  it("never had a Stripe customer — treats cancellation as trivially satisfied, still deletes the account", async () => {
    const tables: Record<string, Row[]> = {
      subscription_state: [],
      whatsapp_connections: [],
      stripe_webhook_claims: [],
      account_deletion_requests: [],
      audit_log: [],
    };
    const supabase = makeFakeClient(tables);
    const deleteUser = vi.fn(async () => ({ error: null }));
    const admin = fakeAdminWithAuth(tables, deleteUser);
    const stripe = fakeStripe();

    const result = await performDeleteMyAccount(
      supabase,
      admin,
      asStripe(stripe),
      "tenant-A",
      "user-A",
    );

    expect(result.ok).toBe(true);
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith("user-A");
  });

  it("Stripe cancellation failure — aborts BEFORE deleting the auth user, marks the request failed", async () => {
    const tables: Record<string, Row[]> = {
      subscription_state: [{ user_id: "user-A", stripe_customer_id: "cus_A" }],
      whatsapp_connections: [],
      stripe_webhook_claims: [],
      account_deletion_requests: [],
      audit_log: [],
    };
    const supabase = makeFakeClient(tables);
    const deleteUser = vi.fn(async () => ({ error: null }));
    const admin = fakeAdminWithAuth(tables, deleteUser);
    const stripe = fakeStripe();
    stripe.subscriptions.list.mockRejectedValueOnce(new Error("Stripe is down"));

    await expect(
      performDeleteMyAccount(supabase, admin, asStripe(stripe), "tenant-A", "user-A"),
    ).rejects.toThrow(/NOT deleted/);

    expect(deleteUser).not.toHaveBeenCalled();
    expect(tables["account_deletion_requests"]![0]!["status"]).toBe("failed");
    expect(tables["audit_log"]!.some((r) => r["action"] === "account.deletion_failed")).toBe(true);
  });

  it("Meta disconnection failure — recorded honestly, does NOT block account deletion", async () => {
    const tables: Record<string, Row[]> = {
      subscription_state: [],
      whatsapp_connections: [
        {
          id: "conn-1",
          tenant_id: "tenant-A",
          status: "connected",
          waba_id: null,
          meta_system_user_token: null,
        },
      ],
      stripe_webhook_claims: [],
      account_deletion_requests: [],
      audit_log: [],
    };
    const deleteUser = vi.fn(async () => ({ error: null }));
    const rawAdmin = makeFakeClient(tables) as unknown as { from: (table: string) => unknown };
    // Make the connection lookup itself fail — a real Meta-disconnect
    // failure mode (performDisconnectMetaConnection's own "error" branch),
    // without needing a real network call to Meta's Graph API. A fixed
    // stub (not a wrapped/spread chain) for this one table, since the
    // real builder's chained methods (select/eq/neq) always return their
    // OWN closure's `builder`, not whatever object they were called on.
    const failingConnectionsBuilder = {
      select: () => failingConnectionsBuilder,
      eq: () => failingConnectionsBuilder,
      neq: () => failingConnectionsBuilder,
      maybeSingle: async () => ({ data: null, error: { message: "db unavailable" } }),
    };
    const admin = {
      from: (table: string) =>
        table === "whatsapp_connections" ? failingConnectionsBuilder : rawAdmin.from(table),
      auth: { admin: { deleteUser } },
    } as unknown as SupabaseClient;
    const supabase = makeFakeClient(tables);
    const stripe = fakeStripe();

    const result = await performDeleteMyAccount(
      supabase,
      admin,
      asStripe(stripe),
      "tenant-A",
      "user-A",
    );

    expect(result.ok).toBe(true);
    expect(result.whatsappDisconnected).toBe(false);
    expect(deleteUser).toHaveBeenCalledWith("user-A");
    expect(tables["account_deletion_requests"]![0]!["whatsapp_disconnect_error"]).toBe(
      "Could not look up your WhatsApp connection.",
    );
  });

  it("repeated/concurrent deletion requests — the second call is rejected while the first is still in flight", async () => {
    const tables: Record<string, Row[]> = {
      subscription_state: [],
      whatsapp_connections: [],
      stripe_webhook_claims: [],
      account_deletion_requests: [
        { id: "req-1", tenant_id: "tenant-A", user_id: "user-A", status: "pending" },
      ],
      audit_log: [],
    };
    const supabase = makeFakeClient(tables);
    const admin = fakeAdminWithAuth(tables);
    const stripe = fakeStripe();

    await expect(
      performDeleteMyAccount(supabase, admin, asStripe(stripe), "tenant-A", "user-A"),
    ).rejects.toThrow(AccountDeletionInProgressError);
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
  });

  it("partial failure then retry — resumes from the Stripe checkpoint instead of canceling twice", async () => {
    const tables: Record<string, Row[]> = {
      subscription_state: [{ user_id: "user-A", stripe_customer_id: "cus_A" }],
      whatsapp_connections: [],
      stripe_webhook_claims: [],
      // Simulates a PRIOR attempt that got through Stripe (checkpoint
      // recorded) and WhatsApp, then failed deleting the auth user.
      account_deletion_requests: [
        {
          id: "req-1",
          tenant_id: "tenant-A",
          user_id: "user-A",
          status: "failed",
          stripe_customer_id: "cus_A",
          stripe_subscription_id: "sub_1",
          stripe_cancelled_at: "2026-11-01T00:00:00.000Z",
          whatsapp_disconnect_attempted_at: "2026-11-01T00:00:00.000Z",
          whatsapp_disconnected_at: null,
          whatsapp_disconnect_error: null,
          failure_reason: "Auth user deletion failed: timeout",
        },
      ],
      audit_log: [],
    };
    const supabase = makeFakeClient(tables);
    const deleteUser = vi.fn(async () => ({ error: null }));
    const admin = fakeAdminWithAuth(tables, deleteUser);
    const stripe = fakeStripe();

    const result = await performDeleteMyAccount(
      supabase,
      admin,
      asStripe(stripe),
      "tenant-A",
      "user-A",
    );

    expect(result.ok).toBe(true);
    // The whole point of this test: Stripe is never asked to cancel an
    // already-canceled subscription a second time.
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith("user-A");
  });

  it("auth-user deletion failure — the one irreversible step is never silently claimed", async () => {
    const tables: Record<string, Row[]> = {
      subscription_state: [],
      whatsapp_connections: [],
      stripe_webhook_claims: [],
      account_deletion_requests: [],
      audit_log: [],
    };
    const supabase = makeFakeClient(tables);
    const deleteUser = vi.fn(async () => ({ error: { message: "GoTrue unavailable" } }));
    const admin = fakeAdminWithAuth(tables, deleteUser);
    const stripe = fakeStripe();

    await expect(
      performDeleteMyAccount(supabase, admin, asStripe(stripe), "tenant-A", "user-A"),
    ).rejects.toThrow(/your data has NOT been deleted/);

    expect(tables["account_deletion_requests"]![0]!["status"]).toBe("failed");
  });

  it("concurrency fix — a resume whose row was already reclaimed between its SELECT and UPDATE is rejected, not silently re-run", async () => {
    // Regression test for the race the code-review/security-review passes
    // both independently flagged: two concurrent callers reading the same
    // "failed" row must not both proceed to re-run Stripe/Meta/deleteUser.
    // Simulates "another caller already resumed this exact row" by
    // mutating the underlying row to 'pending' as a side effect of the
    // FIRST read — exactly the window between claimOrResumeDeletionRequest's
    // own SELECT and its conditional UPDATE — then asserts the conditional
    // `.eq("status", "failed")` on the UPDATE correctly matches zero rows
    // and the caller gets AccountDeletionInProgressError, never a second
    // attempt at the real deletion sequence.
    const tables: Record<string, Row[]> = {
      subscription_state: [{ user_id: "user-A", stripe_customer_id: "cus_A" }],
      whatsapp_connections: [],
      stripe_webhook_claims: [],
      account_deletion_requests: [
        {
          id: "req-1",
          tenant_id: "tenant-A",
          user_id: "user-A",
          status: "failed",
          stripe_customer_id: null,
          stripe_subscription_id: null,
          stripe_cancelled_at: null,
          whatsapp_disconnect_attempted_at: null,
          whatsapp_disconnected_at: null,
          whatsapp_disconnect_error: null,
          failure_reason: "a prior attempt failed",
        },
      ],
      audit_log: [],
    };
    const deleteUser = vi.fn(async () => ({ error: null }));
    const rawAdmin = makeFakeClient(tables) as unknown as { from: (table: string) => never };
    let selectCalls = 0;
    // A minimal, purpose-built builder for just the two call shapes
    // claimOrResumeDeletionRequest issues against this table (plain
    // chained methods can't be wrapped post-hoc — see the Meta-disconnect
    // test above for why).
    const racyRequestsBuilder = {
      select: () => racyRequestsBuilder,
      eq: () => racyRequestsBuilder,
      async maybeSingle() {
        selectCalls += 1;
        const row = tables["account_deletion_requests"]![0]!;
        const snapshot = { ...row };
        // The race: by the time THIS caller's own UPDATE runs below,
        // reality has already moved on — another caller resumed the row.
        row["status"] = "pending";
        return { data: snapshot, error: null };
      },
      update(partial: Row) {
        return {
          eq: (col: string, val: unknown) => ({
            eq: (col2: string, val2: unknown) => ({
              async select() {
                const row = tables["account_deletion_requests"]![0]!;
                const matches = row[col] === val && row[col2] === val2;
                if (!matches) return { data: [], error: null };
                Object.assign(row, partial);
                return { data: [row], error: null };
              },
            }),
          }),
        };
      },
    };
    const admin = {
      from: (table: string) =>
        table === "account_deletion_requests" ? racyRequestsBuilder : rawAdmin.from(table),
      auth: { admin: { deleteUser } },
    } as unknown as SupabaseClient;
    const supabase = makeFakeClient(tables);
    const stripe = fakeStripe();

    await expect(
      performDeleteMyAccount(supabase, admin, asStripe(stripe), "tenant-A", "user-A"),
    ).rejects.toThrow(AccountDeletionInProgressError);

    expect(selectCalls).toBe(1);
    // Never reached Stripe/Meta/deleteUser — the race was caught before
    // any of the real deletion sequence ran.
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("metaApiSucceeded fix — 'nothing to disconnect' is written as null, and a later resume never reports a false success", async () => {
    // Regression test chained across TWO real calls, so it actually
    // exercises the WRITE this correction fixed, not just a pre-seeded
    // read: a test that only seeds the resumed row directly would pass
    // even with the old bug, since the bug lived in what gets WRITTEN
    // during the Meta step, not in how an existing value is read back.
    //
    // Call 1: nothing to disconnect (metaApiSucceeded: null), but
    // deleteUser fails — so the row persists in 'failed' state with
    // whatever the Meta step actually wrote.
    const tables: Record<string, Row[]> = {
      subscription_state: [],
      whatsapp_connections: [], // nothing to disconnect -> metaApiSucceeded: null
      stripe_webhook_claims: [],
      account_deletion_requests: [],
      audit_log: [],
    };
    const supabase = makeFakeClient(tables);
    let deleteUserCalls = 0;
    const deleteUser = vi.fn(async () => {
      deleteUserCalls += 1;
      return deleteUserCalls === 1 ? { error: { message: "GoTrue unavailable" } } : { error: null };
    });
    const admin = fakeAdminWithAuth(tables, deleteUser);
    const stripe = fakeStripe();

    await expect(
      performDeleteMyAccount(supabase, admin, asStripe(stripe), "tenant-A", "user-A"),
    ).rejects.toThrow();

    const persisted = tables["account_deletion_requests"]![0]!;
    expect(persisted["status"]).toBe("failed");
    expect(persisted["whatsapp_disconnect_attempted_at"]).toBeTruthy();
    // The actual fix: must be null, never a timestamp, when nothing was
    // actually confirmed disconnected.
    expect(persisted["whatsapp_disconnected_at"]).toBeNull();

    // Call 2: resume. The one guarantee this correction exists for: never
    // report `true` (a successful disconnection) merely because this
    // earlier attempt reached the checkpoint.
    const result = await performDeleteMyAccount(
      supabase,
      admin,
      asStripe(stripe),
      "tenant-A",
      "user-A",
    );
    expect(result.ok).toBe(true);
    expect(result.whatsappDisconnected).not.toBe(true);
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledTimes(2);
  });

  it("stripe_webhook_claims cleanup failure aborts BEFORE deleteUser and leaves the request recoverable", async () => {
    const tables: Record<string, Row[]> = {
      subscription_state: [],
      whatsapp_connections: [],
      stripe_webhook_claims: [{ user_id: "user-A", claim_token: "tok-1" }],
      account_deletion_requests: [],
      audit_log: [],
    };
    const rawAdmin = makeFakeClient(tables) as unknown as { from: (table: string) => never };
    const deleteUser = vi.fn(async () => ({ error: null }));
    const failingClaimsBuilder = {
      eq: () => ({
        then: (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: "connection reset" } }).then(onFulfilled),
      }),
    };
    const admin = {
      from: (table: string) =>
        table === "stripe_webhook_claims"
          ? { delete: () => failingClaimsBuilder }
          : rawAdmin.from(table),
      auth: { admin: { deleteUser } },
    } as unknown as SupabaseClient;
    const supabase = makeFakeClient(tables);
    const stripe = fakeStripe();

    await expect(
      performDeleteMyAccount(supabase, admin, asStripe(stripe), "tenant-A", "user-A"),
    ).rejects.toThrow(/required cleanup step failed/);

    // The one irreversible step must never run when a required cleanup
    // step before it failed.
    expect(deleteUser).not.toHaveBeenCalled();
    expect(tables["account_deletion_requests"]![0]!["status"]).toBe("failed");
    // Checkpoints already reached (Stripe/Meta) are preserved so a retry
    // doesn't repeat either external operation — only Stripe not being
    // re-cancelled is directly assertable here (Meta had nothing to do).
    expect(tables["account_deletion_requests"]![0]!["stripe_cancelled_at"]).toBeTruthy();
    // The orphaned claim row is still there (the delete genuinely failed,
    // not silently skipped) — exactly why this must block, not continue.
    expect(tables["stripe_webhook_claims"]).toHaveLength(1);
  });
});
