import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// performSendLeadReply/performSendLeadReplyWithTemplate are extracted into
// plain functions specifically so they're testable at all — see their own
// comment in lead-reply-server.ts: a bare createServerFn throws ("No Start
// context found in AsyncLocalStorage") when called directly in this test
// environment, the same empirically-confirmed limitation
// price-sheet-server.test.ts's header comment documents for saveMyPriceSheet.
//
// Regression context: lead-reply-server.ts used to read tenants.whatsapp_number
// (a legacy Twilio-routing field) and send through Twilio whenever it was
// set, even for a tenant whose real, active connection was Meta. Twilio
// support has been removed entirely — these tests prove the function now
// resolves only the tenant's Meta connection, with no other branch to fall
// into, and that a stale/populated whatsapp_number value (simulated here by
// a fake tenants row that still has the column) can no longer reach or
// influence routing at all.

vi.mock("@/lib/meta-whatsapp-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta-whatsapp-server")>();
  return {
    resolveActiveMetaConnectionForTenant: vi.fn(),
    sendWhatsAppMessageMeta: vi.fn(),
    sendWhatsAppTemplateMessage: vi.fn(),
    markConnectionFailed: vi.fn(),
    // Real error class (not mocked) — performSendLeadReply/
    // performSendLeadReplyWithTemplate do `err instanceof MetaOutsideWindowError`,
    // which only works against the real constructor.
    MetaOutsideWindowError: actual.MetaOutsideWindowError,
  };
});
vi.mock("@/lib/whatsapp-templates-server", () => ({
  getApprovedWhatsAppTemplate: vi.fn(),
  fillTemplateBody: vi.fn((body: string, params: string[]) =>
    params.reduce((acc, p, i) => acc.replace(`{{${i + 1}}}`, p), body),
  ),
}));
vi.mock("@/lib/public-lead-server", () => ({
  getAdminClient: vi.fn(() => ({})),
}));
vi.mock("@/lib/whatsapp-loop-guard-server", () => ({
  resumeLoopGuardState: vi.fn(),
  normalizePhone: vi.fn((p: string) => p),
}));
vi.mock("@/lib/whatsapp-opt-out-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp-opt-out-server")>();
  // Real error class, same reasoning as MetaOutsideWindowError above.
  return { WhatsAppOptedOutError: actual.WhatsAppOptedOutError };
});

import { performSendLeadReply, performSendLeadReplyWithTemplate } from "./lead-reply-server";
import {
  resolveActiveMetaConnectionForTenant,
  sendWhatsAppMessageMeta,
  sendWhatsAppTemplateMessage,
  markConnectionFailed,
  MetaOutsideWindowError,
} from "@/lib/meta-whatsapp-server";
import { getApprovedWhatsAppTemplate } from "@/lib/whatsapp-templates-server";
import { resumeLoopGuardState } from "@/lib/whatsapp-loop-guard-server";
import { WhatsAppOptedOutError } from "@/lib/whatsapp-opt-out-server";

const resolveActiveMetaConnectionForTenantMock = resolveActiveMetaConnectionForTenant as unknown as ReturnType<
  typeof vi.fn
>;
const sendWhatsAppMessageMetaMock = sendWhatsAppMessageMeta as unknown as ReturnType<typeof vi.fn>;
const sendWhatsAppTemplateMessageMock = sendWhatsAppTemplateMessage as unknown as ReturnType<typeof vi.fn>;
const markConnectionFailedMock = markConnectionFailed as unknown as ReturnType<typeof vi.fn>;
const getApprovedWhatsAppTemplateMock = getApprovedWhatsAppTemplate as unknown as ReturnType<typeof vi.fn>;
const resumeLoopGuardStateMock = resumeLoopGuardState as unknown as ReturnType<typeof vi.fn>;

const META_CONNECTION = { connectionId: "conn-1", phoneNumberId: "pnid-1", accessToken: "token-1" };

type FakeLead = { id: string; phone: string | null; channel: string };

// Records the exact select()/eq()/eq() args used for the tenants and leads
// lookups, so tenant-scoping and the "no whatsapp_number column requested"
// guarantee are provable assertions, not just inspection of the source.
function fakeLeadReplyClient(
  opts: {
    tenantRow?: Record<string, unknown> | null;
    tenantError?: { message: string } | null;
    lead?: FakeLead | null;
    leadError?: { message: string } | null;
    insertError?: { message: string } | null;
  } = {},
) {
  const tenantSelects: string[] = [];
  const tenantEqCalls: { column: string; value: unknown }[] = [];
  const leadEqCalls: { column: string; value: unknown }[] = [];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];

  const client = {
    from: (table: string) => {
      if (table === "tenants") {
        return {
          select: (cols: string) => {
            tenantSelects.push(cols);
            return {
              eq: (column: string, value: unknown) => {
                tenantEqCalls.push({ column, value });
                return {
                  single: async () => ({
                    data: opts.tenantRow !== undefined ? opts.tenantRow : { id: "tenant-1" },
                    error: opts.tenantError ?? null,
                  }),
                };
              },
            };
          },
        };
      }
      if (table === "leads") {
        return {
          select: (_cols: string) => ({
            eq: (column: string, value: unknown) => {
              leadEqCalls.push({ column, value });
              return {
                eq: (column2: string, value2: unknown) => {
                  leadEqCalls.push({ column: column2, value: value2 });
                  return {
                    single: async () => ({
                      data:
                        opts.lead !== undefined
                          ? opts.lead
                          : { id: "lead-1", phone: "+15551234567", channel: "WhatsApp" },
                      error: opts.leadError ?? null,
                    }),
                  };
                },
              };
            },
          }),
        };
      }
      if (table === "lead_messages") {
        return {
          insert: async (row: Record<string, unknown>) => {
            inserts.push({ table, row });
            return { error: opts.insertError ?? null };
          },
        };
      }
      throw new Error(`fakeLeadReplyClient: unexpected table "${table}"`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    tenantSelects,
    tenantEqCalls,
    leadEqCalls,
    inserts,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("performSendLeadReply — Meta is the only outbound channel", () => {
  it("sends through Meta when a Meta connection is active, even though the tenants row still has a populated legacy whatsapp_number", async () => {
    resolveActiveMetaConnectionForTenantMock.mockResolvedValue(META_CONNECTION);
    // Simulates exactly the production state this audit found for Cabos
    // Handyman: a tenants row that still carries the old Twilio field,
    // non-null, alongside a real Meta connection.
    const { client, inserts } = fakeLeadReplyClient({
      tenantRow: { id: "tenant-1", whatsapp_number: "+521621698328" },
    });

    const result = await performSendLeadReply(client, "user-1", { leadId: "lead-1", body: "On my way!" });

    expect(result).toEqual({ status: "sent" });
    expect(sendWhatsAppMessageMetaMock).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppMessageMetaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: "pnid-1",
        accessToken: "token-1",
        to: "+15551234567",
        body: "On my way!",
        tenantId: "tenant-1",
      }),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.row).toMatchObject({ lead_id: "lead-1", role: "assistant", body: "On my way!" });
  });

  it("never selects tenants.whatsapp_number at all — a stale value structurally cannot reach or influence routing", async () => {
    resolveActiveMetaConnectionForTenantMock.mockResolvedValue(META_CONNECTION);
    const { client, tenantSelects } = fakeLeadReplyClient();

    await performSendLeadReply(client, "user-1", { leadId: "lead-1", body: "Hi" });

    expect(tenantSelects).toHaveLength(1);
    expect(tenantSelects[0]).not.toMatch(/whatsapp_number/);
  });

  it("does not fall back to any other channel when no Meta connection is active — it errors instead of silently trying something else", async () => {
    resolveActiveMetaConnectionForTenantMock.mockResolvedValue(null);
    const { client, inserts } = fakeLeadReplyClient();

    const result = await performSendLeadReply(client, "user-1", { leadId: "lead-1", body: "Hi" });

    expect(result).toEqual({
      status: "error",
      message: "No WhatsApp connection is set up for this business yet.",
    });
    expect(sendWhatsAppMessageMetaMock).not.toHaveBeenCalled();
    // No fallback send of any kind means nothing was ever saved as if it
    // reached the customer.
    expect(inserts).toHaveLength(0);
  });

  it("resumes the loop guard only after Meta confirms the send succeeded", async () => {
    resolveActiveMetaConnectionForTenantMock.mockResolvedValue(META_CONNECTION);
    const { client } = fakeLeadReplyClient();

    await performSendLeadReply(client, "user-1", { leadId: "lead-1", body: "Hi" });

    expect(resumeLoopGuardStateMock).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      "+15551234567",
      "operator_reply",
    );
  });

  it("propagates an opted-out customer as its own result variant", async () => {
    resolveActiveMetaConnectionForTenantMock.mockResolvedValue(META_CONNECTION);
    sendWhatsAppMessageMetaMock.mockRejectedValue(new WhatsAppOptedOutError("opted out"));
    const { client } = fakeLeadReplyClient();

    const result = await performSendLeadReply(client, "user-1", { leadId: "lead-1", body: "Hi" });

    expect(result).toEqual({ status: "opted_out" });
    expect(markConnectionFailedMock).not.toHaveBeenCalled();
  });

  it("propagates an outside-the-24h-window error as its own result variant, and does not mark the connection failed", async () => {
    resolveActiveMetaConnectionForTenantMock.mockResolvedValue(META_CONNECTION);
    sendWhatsAppMessageMetaMock.mockRejectedValue(new MetaOutsideWindowError("outside window"));
    const { client } = fakeLeadReplyClient();

    const result = await performSendLeadReply(client, "user-1", { leadId: "lead-1", body: "Hi" });

    expect(result).toEqual({ status: "outside_window" });
    expect(markConnectionFailedMock).not.toHaveBeenCalled();
  });

  it("marks the connection failed and reports an error for any other send failure", async () => {
    resolveActiveMetaConnectionForTenantMock.mockResolvedValue(META_CONNECTION);
    sendWhatsAppMessageMetaMock.mockRejectedValue(new Error("Meta: invalid access token"));
    const { client } = fakeLeadReplyClient();

    const result = await performSendLeadReply(client, "user-1", { leadId: "lead-1", body: "Hi" });

    expect(result).toEqual({ status: "error", message: "Meta: invalid access token" });
    expect(markConnectionFailedMock).toHaveBeenCalledWith("conn-1", "Meta: invalid access token");
  });

  it("looks up the lead scoped to the caller's own tenant (tenant isolation) before the lead id", async () => {
    resolveActiveMetaConnectionForTenantMock.mockResolvedValue(META_CONNECTION);
    const { client, leadEqCalls } = fakeLeadReplyClient({ tenantRow: { id: "tenant-42" } });

    await performSendLeadReply(client, "user-1", { leadId: "lead-1", body: "Hi" });

    expect(leadEqCalls[0]).toEqual({ column: "tenant_id", value: "tenant-42" });
    expect(leadEqCalls[1]).toEqual({ column: "id", value: "lead-1" });
  });

  it("a non-WhatsApp lead (e.g. Widget) is saved to the thread without touching Meta at all", async () => {
    const { client, inserts } = fakeLeadReplyClient({
      lead: { id: "lead-1", phone: null, channel: "Widget" },
    });

    const result = await performSendLeadReply(client, "user-1", { leadId: "lead-1", body: "Thanks!" });

    expect(result).toEqual({ status: "sent" });
    expect(resolveActiveMetaConnectionForTenantMock).not.toHaveBeenCalled();
    expect(sendWhatsAppMessageMetaMock).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
  });

  it("rejects an empty message before touching the database at all", async () => {
    const { client, tenantSelects } = fakeLeadReplyClient();

    const result = await performSendLeadReply(client, "user-1", { leadId: "lead-1", body: "   " });

    expect(result).toEqual({ status: "error", message: "Message can't be empty." });
    expect(tenantSelects).toHaveLength(0);
  });
});

describe("performSendLeadReplyWithTemplate — Meta template replies", () => {
  const TEMPLATE = {
    name: "reengage_v1",
    language: "en",
    bodyText: "Hi {{1}}, just checking in about your quote.",
  };

  it("sends an approved Meta template and saves the filled-in body to the thread", async () => {
    resolveActiveMetaConnectionForTenantMock.mockResolvedValue(META_CONNECTION);
    getApprovedWhatsAppTemplateMock.mockResolvedValue(TEMPLATE);
    const { client, inserts } = fakeLeadReplyClient();

    const result = await performSendLeadReplyWithTemplate(client, "user-1", {
      leadId: "lead-1",
      templateId: "tmpl-1",
      bodyParams: ["Sam"],
    });

    expect(result).toEqual({ status: "sent" });
    expect(sendWhatsAppTemplateMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: "pnid-1",
        accessToken: "token-1",
        to: "+15551234567",
        templateName: "reengage_v1",
        language: "en",
        bodyParams: ["Sam"],
        tenantId: "tenant-1",
      }),
    );
    expect(inserts[0]!.row).toMatchObject({ body: "Hi Sam, just checking in about your quote." });
    expect(resumeLoopGuardStateMock).toHaveBeenCalledWith(expect.anything(), "tenant-1", "+15551234567", "operator_reply");
  });

  it("errors, without sending, when no Meta connection is active", async () => {
    resolveActiveMetaConnectionForTenantMock.mockResolvedValue(null);
    getApprovedWhatsAppTemplateMock.mockResolvedValue(TEMPLATE);
    const { client } = fakeLeadReplyClient();

    const result = await performSendLeadReplyWithTemplate(client, "user-1", {
      leadId: "lead-1",
      templateId: "tmpl-1",
      bodyParams: [],
    });

    expect(result).toEqual({ status: "error", message: "No WhatsApp connection is set up for this business." });
    expect(sendWhatsAppTemplateMessageMock).not.toHaveBeenCalled();
  });

  it("errors when the template doesn't exist or isn't approved yet", async () => {
    getApprovedWhatsAppTemplateMock.mockResolvedValue(null);
    const { client } = fakeLeadReplyClient();

    const result = await performSendLeadReplyWithTemplate(client, "user-1", {
      leadId: "lead-1",
      templateId: "tmpl-missing",
      bodyParams: [],
    });

    expect(result).toEqual({ status: "error", message: "That template wasn't found, or isn't approved yet." });
    expect(resolveActiveMetaConnectionForTenantMock).not.toHaveBeenCalled();
  });

  it("propagates an opted-out customer as its own result variant", async () => {
    resolveActiveMetaConnectionForTenantMock.mockResolvedValue(META_CONNECTION);
    getApprovedWhatsAppTemplateMock.mockResolvedValue(TEMPLATE);
    sendWhatsAppTemplateMessageMock.mockRejectedValue(new WhatsAppOptedOutError("opted out"));
    const { client } = fakeLeadReplyClient();

    const result = await performSendLeadReplyWithTemplate(client, "user-1", {
      leadId: "lead-1",
      templateId: "tmpl-1",
      bodyParams: [],
    });

    expect(result).toEqual({ status: "opted_out" });
  });
});
