import { createFileRoute } from "@tanstack/react-router";
import { getQuoteEstimate, type PriceSheetItem } from "@/lib/estimate-server";
import { createLead, getAdminClient } from "@/lib/public-lead-server";
import { sendFollowUpNotificationEmail } from "@/lib/notify-server";
import { sendWhatsAppMessage, fetchTwilioMediaAsBase64, verifyTwilioSignature } from "@/lib/twilio-server";
import { money } from "@/lib/mock-data";

// Reinvented from two DevHubConnect n8n templates, not copied — neither
// template's "AI" was real (both were regex keyword matching dressed up as
// AI), neither had any concept of a tenant (single-business schemas: a
// `customers` table with no tenant_id), and both used the Supabase anon key
// for writes with no session behind them. This route uses the actual Claude
// pricing already built (getQuoteEstimate), the actual tenant-scoped RLS
// schema, and the service-role client already proven correct in
// public-lead-server.ts (an inbound WhatsApp message has no Supabase
// session, same as a customer submitting the public quote page).
//
// Raw HTTP handler, not createServerFn — Twilio's signature verification
// needs the exact raw form-encoded body, same reason the Stripe webhook
// (api.stripe.webhook.tsx) isn't a createServerFn either.
export const Route = createFileRoute("/api/whatsapp/webhook")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const emptyTwiml = () =>
          new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
            status: 200,
            headers: { "content-type": "text/xml" },
          });

        const rawBody = await request.text();
        const formParams = Object.fromEntries(new URLSearchParams(rawBody));

        const signature = request.headers.get("x-twilio-signature");
        let signatureValid = false;
        try {
          signatureValid = verifyTwilioSignature({ signature, url: request.url, formParams });
        } catch (err) {
          console.error("Twilio signature check failed to run (env not configured?):", err);
        }
        if (!signatureValid) {
          console.error("Rejected WhatsApp webhook: invalid or missing Twilio signature.");
          return new Response("Invalid signature", { status: 403 });
        }

        const fromRaw = formParams["From"] || "";
        const toRaw = formParams["To"] || "";
        const body = (formParams["Body"] || "").trim();
        const numMedia = Number(formParams["NumMedia"] || "0");
        const mediaUrl = formParams["MediaUrl0"];
        const profileName = formParams["ProfileName"];

        const fromPhone = fromRaw.replace("whatsapp:", "");
        const toPhone = toRaw.replace("whatsapp:", "");

        if (!fromPhone || !toPhone) {
          console.error("WhatsApp webhook missing From/To.");
          return emptyTwiml();
        }

        const admin = getAdminClient();

        // Which business's number did this land on? This is the multi-tenant
        // piece neither template had any concept of.
        const { data: tenant, error: tenantError } = await admin
          .from("tenants")
          .select("id, slug, name, email, currency, labor_rate, service_call_fee")
          .eq("whatsapp_number", toPhone)
          .single();
        if (tenantError || !tenant) {
          console.error(`WhatsApp message to unrecognized number ${toPhone}:`, tenantError?.message);
          return emptyTwiml();
        }

        // Reinvented "check existing customer" from the templates — but
        // scoped to this tenant, and against the real leads table instead of
        // a separate customers table. A message from the same phone number
        // to the same tenant within 48 hours continues that lead instead of
        // creating a duplicate.
        const { data: openLead } = await admin
          .from("leads")
          .select("id, customer_name")
          .eq("tenant_id", tenant.id)
          .eq("phone", fromPhone)
          .gte("created_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (openLead) {
          // Continuing an existing conversation: record it and let the
          // business reply from their already-built dashboard message
          // thread, rather than re-running AI diagnosis on every reply.
          await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "customer", body });
          void sendFollowUpNotificationEmail({
            tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
            customerName: openLead.customer_name || profileName || "A customer",
            body,
          });
          return emptyTwiml();
        }

        // New conversation. Real-world finding from Cabos Handyman's actual
        // WhatsApp use (see ROADMAP.md): customers greet first and don't
        // lead with a photo unless asked. Ask immediately rather than
        // attempting a diagnosis with nothing to diagnose.
        if (numMedia === 0 || !mediaUrl) {
          await sendWhatsAppMessage({
            to: fromPhone,
            body: `Thanks for reaching out to ${tenant.name}! To get you a fast, accurate price, please send a photo of the problem along with a quick description.`,
          });
          return emptyTwiml();
        }

        const { data: priceSheetRows } = await admin
          .from("price_sheet_items")
          .select("task, keywords, price_min, price_max, hours")
          .eq("tenant_id", tenant.id);

        const priceSheet: PriceSheetItem[] = (priceSheetRows ?? []).map((row) => ({
          task: row.task,
          keywords: row.keywords,
          priceMin: row.price_min,
          priceMax: row.price_max,
          hours: row.hours,
        }));

        let imageBase64: string;
        let imageMediaType: string;
        try {
          const media = await fetchTwilioMediaAsBase64(mediaUrl);
          imageBase64 = media.base64;
          imageMediaType = media.mediaType;
        } catch (err) {
          console.error("Could not download WhatsApp photo from Twilio:", err);
          await sendWhatsAppMessage({
            to: fromPhone,
            body: "I couldn't load that photo — could you try sending it again?",
          });
          return emptyTwiml();
        }

        const result = await getQuoteEstimate({
          data: {
            businessName: tenant.name,
            laborRate: tenant.labor_rate,
            serviceCallFee: tenant.service_call_fee,
            priceSheet,
            description: body || "(no description provided, photo only)",
            imageBase64,
            imageMediaType,
          },
        });

        if (result.needsClarification) {
          const question = result.questions[0];
          const optionsText = question?.options?.length ? `\n(${question.options.join(" / ")})` : "";
          await sendWhatsAppMessage({
            to: fromPhone,
            body: `${question?.question ?? "Can you tell me a bit more?"}${optionsText}`,
          });
          return emptyTwiml();
        }

        const lineItems = result.lineItems.map((item) => ({
          description: item.description,
          qty: 1,
          unit: "job",
          rate: item.amount,
        }));
        const total = lineItems.reduce((sum, item) => sum + item.rate, 0);

        await createLead({
          data: {
            tenantSlug: tenant.slug,
            customerName: profileName || "WhatsApp customer",
            phone: fromPhone,
            address: "",
            channel: "WhatsApp",
            photoUrl: mediaUrl,
            problem: body || "(photo only, no description provided)",
            diagnosis: result.diagnosis,
            confidence: result.confidence,
            isEmergency: result.isEmergency,
            lineItems,
          },
        });

        await sendWhatsAppMessage({
          to: fromPhone,
          body: `Based on the photo: ${result.diagnosis} That comes to ${money(total, tenant.currency)} total. Want me to get this booked in?`,
        });

        return emptyTwiml();
      },
    },
  },
});
