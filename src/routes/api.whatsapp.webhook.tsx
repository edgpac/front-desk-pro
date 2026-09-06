import { createFileRoute } from "@tanstack/react-router";
import { getQuoteEstimate, type Answer, type PriceSheetItem } from "@/lib/estimate-server";
import { createLead, createClarifyingLead, finalizeLeadWithQuote, getAdminClient } from "@/lib/public-lead-server";
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
        // piece neither template had any concept of. A tenant with no
        // whatsapp_number set (still null) can never match here — Postgres
        // never satisfies `column = value` against a NULL column — so an
        // unconfigured tenant simply falls through to "unrecognized number"
        // below instead of ever being mistaken for the intended recipient.
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
          .select("id, customer_name, photo_url, problem, confidence")
          .eq("tenant_id", tenant.id)
          .eq("phone", fromPhone)
          .gte("created_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        // confidence is only ever set once a real quote exists (createLead
        // and finalizeLeadWithQuote both require it; createClarifyingLead
        // deliberately omits it) — so NULL here means this lead is still
        // mid-clarification, not yet quoted. Continue the AI conversation
        // instead of treating this as a human follow-up reply.
        if (openLead && openLead.confidence === null) {
          await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "customer", body });

          const { data: priorMessages } = await admin
            .from("lead_messages")
            .select("role, body")
            .eq("lead_id", openLead.id)
            .order("created_at", { ascending: true });

          // Deterministic pairing, not fuzzy matching: walk the ordered
          // transcript once — an assistant question immediately followed by
          // a customer reply is one answered pair. An unanswered trailing
          // question (or any other shape) is simply not included.
          const answers: Answer[] = [];
          const messages = priorMessages ?? [];
          for (let i = 0; i < messages.length - 1; i++) {
            const question = messages[i];
            const reply = messages[i + 1];
            if (question && reply && question.role === "assistant" && reply.role === "customer") {
              answers.push({ question: question.body, answer: reply.body });
              i++;
            }
          }

          const { data: clarifyPriceSheetRows } = await admin
            .from("price_sheet_items")
            .select("task, keywords, price_min, price_max, hours")
            .eq("tenant_id", tenant.id);
          const clarifyPriceSheet: PriceSheetItem[] = (clarifyPriceSheetRows ?? []).map((row) => ({
            task: row.task,
            keywords: row.keywords,
            priceMin: row.price_min,
            priceMax: row.price_max,
            hours: row.hours,
          }));

          // The original photo stays canonical regardless of whether this
          // reply has its own attachment — re-fetched fresh each round from
          // Twilio's stable media URL (not a cached short-lived redirect).
          let clarifyImageBase64: string;
          let clarifyImageMediaType: string;
          try {
            const media = await fetchTwilioMediaAsBase64(openLead.photo_url);
            clarifyImageBase64 = media.base64;
            clarifyImageMediaType = media.mediaType;
          } catch (err) {
            console.error("Could not re-download the original WhatsApp photo from Twilio:", err);
            await sendWhatsAppMessage({
              to: fromPhone,
              body: "Sorry, I lost track of the original photo — could you resend it along with your answer?",
            });
            return emptyTwiml();
          }

          const clarifyResult = await getQuoteEstimate({
            data: {
              businessName: tenant.name,
              laborRate: tenant.labor_rate,
              serviceCallFee: tenant.service_call_fee,
              priceSheet: clarifyPriceSheet,
              description: openLead.problem,
              imageBase64: clarifyImageBase64,
              imageMediaType: clarifyImageMediaType,
              answers,
            },
          });

          if (clarifyResult.needsClarification) {
            const question = clarifyResult.questions[0];
            const optionsText = question?.options?.length ? `\n(${question.options.join(" / ")})` : "";
            const questionText = `${question?.question ?? "Can you tell me a bit more?"}${optionsText}`;
            await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "assistant", body: questionText });
            await sendWhatsAppMessage({ to: fromPhone, body: questionText });
            return emptyTwiml();
          }

          const clarifyLineItems = clarifyResult.lineItems.map((item) => ({
            description: item.description,
            qty: 1,
            unit: "job",
            rate: item.amount,
          }));
          const clarifyTotal = clarifyLineItems.reduce((sum, item) => sum + item.rate, 0);

          await finalizeLeadWithQuote({
            data: {
              leadId: openLead.id,
              tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
              customerName: openLead.customer_name || profileName || "WhatsApp customer",
              phone: fromPhone,
              channel: "WhatsApp",
              problem: openLead.problem,
              diagnosis: clarifyResult.diagnosis,
              confidence: clarifyResult.confidence,
              isEmergency: clarifyResult.isEmergency,
              lineItems: clarifyLineItems,
            },
          });

          await sendWhatsAppMessage({
            to: fromPhone,
            body: `Based on the photo: ${clarifyResult.diagnosis} That comes to ${money(clarifyTotal, tenant.currency)} total. Want me to get this booked in?`,
          });

          return emptyTwiml();
        }

        if (openLead) {
          // Already quoted (confidence is set): continuing an existing
          // conversation as a human follow-up reply — record it and let the
          // business reply from their already-built dashboard message
          // thread, rather than re-running AI diagnosis. Unchanged from
          // before this fix.
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
          const questionText = `${question?.question ?? "Can you tell me a bit more?"}${optionsText}`;

          // Create the lead now, at the first clarification round, instead
          // of just replying and discarding the original photo/description —
          // that discard was the root cause of the clarification conversation
          // losing context on later rounds.
          const openingProblem = body || "(photo only, no description provided)";
          const { id: leadId } = await createClarifyingLead({
            data: {
              tenantSlug: tenant.slug,
              customerName: profileName || "WhatsApp customer",
              phone: fromPhone,
              channel: "WhatsApp",
              photoUrl: mediaUrl,
              problem: openingProblem,
            },
          });
          await admin.from("lead_messages").insert({ lead_id: leadId, role: "customer", body: openingProblem });
          await admin.from("lead_messages").insert({ lead_id: leadId, role: "assistant", body: questionText });

          await sendWhatsAppMessage({ to: fromPhone, body: questionText });
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
