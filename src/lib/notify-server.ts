import nodemailer from "nodemailer";
import { money, type LineItem } from "@/lib/mock-data";

type NotifyTenant = { name: string; email: string; currency: string };
type NotifyLead = {
  customer: string;
  phone: string;
  address: string;
  channel: string;
  problem: string;
  diagnosis: string;
  confidence: string | null;
  isEmergency?: boolean;
};

// Ported from Cabos Handyman's api/send-booking-email.js — a real, already-
// working pattern: notify the business the moment a customer gets a real
// estimate, not gated behind an actual confirmed booking. Same escaping
// approach (Cabos's api/_security.js sanitizeHtml) since this interpolates
// user-supplied text (customer name, problem description) into HTML.
function escapeHtml(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function buildEmailHtml(params: { tenant: NotifyTenant; lead: NotifyLead; lineItems: LineItem[]; total: number }) {
  const { tenant, lead, lineItems, total } = params;
  const severityColor =
    lead.confidence === "Low" ? "#dc2626" : lead.confidence === "Medium" ? "#ea580c" : "#16a34a";

  const rows = lineItems
    .map(
      (item) => `
        <tr>
          <td style="padding: 5px;">${escapeHtml(item.description)} (${item.qty} ${escapeHtml(item.unit)})</td>
          <td style="padding: 5px; text-align: right;">${money(item.qty * item.rate, tenant.currency)}</td>
        </tr>`,
    )
    .join("");

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: ${lead.isEmergency ? "#dc2626" : "#B4531F"};">${lead.isEmergency ? "🚨 EMERGENCY lead" : "🔧 New lead"} — ${escapeHtml(tenant.name)}</h2>

      <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
        <h3 style="margin-top: 0;">Customer</h3>
        <p><strong>Name:</strong> ${escapeHtml(lead.customer) || "N/A"}</p>
        <p><strong>Phone:</strong> ${escapeHtml(lead.phone) || "N/A"}</p>
        <p><strong>Address:</strong> ${escapeHtml(lead.address) || "N/A"}</p>
        <p><strong>Via:</strong> ${escapeHtml(lead.channel)}</p>
      </div>

      <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0;">
        <h3 style="margin-top: 0;">Problem</h3>
        <p>${escapeHtml(lead.problem) || "N/A"}</p>
        <p><strong>AI diagnosis:</strong> ${escapeHtml(lead.diagnosis) || "N/A"}</p>
        <p><strong>Confidence:</strong> <span style="color: ${severityColor}; font-weight: bold;">${escapeHtml(lead.confidence)}</span></p>
      </div>

      <div style="background: #dbeafe; padding: 15px; border-radius: 8px; margin: 20px 0;">
        <h3 style="margin-top: 0;">Estimate</h3>
        <table style="width: 100%; border-collapse: collapse;">
          ${rows}
          <tr style="border-top: 2px solid #B4531F;">
            <td style="padding: 10px 5px;"><strong>Total</strong></td>
            <td style="padding: 10px 5px; text-align: right; font-size: 18px; color: #B4531F;"><strong>${money(total, tenant.currency)}</strong></td>
          </tr>
        </table>
      </div>

      <div style="margin-top: 20px; padding: 15px; background: #f9fafb; border-radius: 8px; text-align: center;">
        <p style="margin: 0; color: #6b7280; font-size: 12px;">Sent from your FrontDesk lead inbox — reply from the dashboard.</p>
      </div>
    </div>
  `;
}

function getTransporter(): { transporter: ReturnType<typeof nodemailer.createTransport>; fromEmail: string } | null {
  const fromEmail = process.env["NOTIFICATION_FROM_EMAIL"];
  const appPassword = process.env["EMAIL_APP_PASSWORD"];
  if (!fromEmail || !appPassword) {
    console.error("NOTIFICATION_FROM_EMAIL or EMAIL_APP_PASSWORD not configured — skipping notification email.");
    return null;
  }
  return {
    fromEmail,
    transporter: nodemailer.createTransport({ service: "gmail", auth: { user: fromEmail, pass: appPassword } }),
  };
}

// Fire-and-forget on purpose: a failed notification email should never break
// lead creation itself. Callers should await this but not let it throw past
// them — logged and swallowed on failure, same as Cabos's real pattern.
export async function sendLeadNotificationEmail(params: {
  tenant: NotifyTenant;
  lead: NotifyLead;
  lineItems: LineItem[];
  total: number;
}): Promise<void> {
  const mailer = getTransporter();
  if (!mailer) return;
  if (!params.tenant.email) {
    console.error("Tenant has no email on file — skipping lead notification email.");
    return;
  }

  try {
    await mailer.transporter.sendMail({
      from: mailer.fromEmail,
      to: params.tenant.email,
      subject: `${params.lead.isEmergency ? "🚨 EMERGENCY" : "🔧 New lead"} — ${params.lead.customer || "New request"} [${params.lead.confidence || "estimate"}]`,
      html: buildEmailHtml(params),
    });
  } catch (err) {
    console.error("Lead notification email failed:", err);
  }
}

// A much lighter notification for a customer continuing an existing
// conversation — the business already has this lead in their inbox, this
// just tells them someone replied, so they know to go answer it.
export async function sendFollowUpNotificationEmail(params: {
  tenant: NotifyTenant;
  customerName: string;
  body: string;
}): Promise<void> {
  const mailer = getTransporter();
  if (!mailer) return;
  if (!params.tenant.email) return;

  try {
    await mailer.transporter.sendMail({
      from: mailer.fromEmail,
      to: params.tenant.email,
      subject: `💬 ${params.customerName || "A customer"} replied`,
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #B4531F;">💬 New reply</h2>
        <p><strong>${escapeHtml(params.customerName) || "A customer"}</strong> wrote:</p>
        <blockquote style="background: #f3f4f6; padding: 15px; border-radius: 8px; margin: 0;">${escapeHtml(params.body)}</blockquote>
        <p style="margin-top: 20px; color: #6b7280; font-size: 12px;">Reply from your FrontDesk lead inbox.</p>
      </div>`,
    });
  } catch (err) {
    console.error("Follow-up notification email failed:", err);
  }
}
