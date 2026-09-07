import { getQuoteEstimate, type Answer, type PriceSheetItem } from "@/lib/estimate-server";
import { createLead, createClarifyingLead, finalizeLeadWithQuote, getAdminClient } from "@/lib/public-lead-server";
import { sendFollowUpNotificationEmail } from "@/lib/notify-server";
import { money } from "@/lib/mock-data";

// Channel-agnostic core extracted from api.whatsapp.webhook.tsx (the
// original, Twilio-only route). Everything here — the 48-hour open-lead
// continuation, the deterministic Q&A pairing, calling getQuoteEstimate,
// calling createLead/createClarifyingLead/finalizeLeadWithQuote — has
// nothing to do with which BSP delivered the message. It never imports a
// specific transport (twilio-server.ts, or a future meta-whatsapp-server.ts)
// directly; it only ever talks through the adapter passed in, so it's
// structurally impossible for this file to reach for one channel's global
// credentials while processing a message that arrived on another.
export type ChannelAdapter = {
  sendMessage: (to: string, body: string) => Promise<void>;
  fetchMedia: (ref: string) => Promise<{ base64: string; mediaType: string }>;
};

export type InboundWhatsAppTenant = {
  id: string;
  slug: string;
  name: string;
  email: string;
  currency: string;
  laborRate: number;
  serviceCallFee: number;
};

export async function handleInboundWhatsAppMessage(params: {
  tenant: InboundWhatsAppTenant;
  fromPhone: string;
  body: string;
  mediaRef: string | undefined;
  profileName: string | undefined;
  channel: "WhatsApp";
  adapter: ChannelAdapter;
}): Promise<void> {
  const { tenant, fromPhone, body, mediaRef, profileName, channel, adapter } = params;
  const admin = getAdminClient();

  // Reinvented "check existing customer" from the original n8n templates —
  // but scoped to this tenant, and against the real leads table instead of
  // a separate customers table. A message from the same phone number to the
  // same tenant within 48 hours continues that lead instead of creating a
  // duplicate.
  const { data: openLead } = await admin
    .from("leads")
    .select("id, customer_name, photo_url, problem, confidence")
    .eq("tenant_id", tenant.id)
    .eq("phone", fromPhone)
    .gte("created_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // confidence is only ever set once a real quote exists (createLead and
  // finalizeLeadWithQuote both require it; createClarifyingLead deliberately
  // omits it) — so NULL here means this lead is still mid-clarification, not
  // yet quoted. Continue the AI conversation instead of treating this as a
  // human follow-up reply.
  if (openLead && openLead.confidence === null) {
    await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "customer", body });

    const { data: priorMessages } = await admin
      .from("lead_messages")
      .select("role, body")
      .eq("lead_id", openLead.id)
      .order("created_at", { ascending: true });

    // Deterministic pairing, not fuzzy matching: walk the ordered transcript
    // once — an assistant question immediately followed by a customer reply
    // is one answered pair. An unanswered trailing question (or any other
    // shape) is simply not included.
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

    // The original photo stays canonical regardless of whether this reply
    // has its own attachment — re-fetched fresh each round via the adapter
    // (a stable Twilio media URL today; a Meta media id in a future
    // channel) rather than a cached short-lived redirect.
    let clarifyImageBase64: string;
    let clarifyImageMediaType: string;
    try {
      const media = await adapter.fetchMedia(openLead.photo_url);
      clarifyImageBase64 = media.base64;
      clarifyImageMediaType = media.mediaType;
    } catch (err) {
      console.error("Could not re-download the original WhatsApp photo:", err);
      await adapter.sendMessage(
        fromPhone,
        "Sorry, I lost track of the original photo — could you resend it along with your answer?",
      );
      return;
    }

    const clarifyResult = await getQuoteEstimate({
      data: {
        businessName: tenant.name,
        laborRate: tenant.laborRate,
        serviceCallFee: tenant.serviceCallFee,
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
      await adapter.sendMessage(fromPhone, questionText);
      return;
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
        channel,
        problem: openLead.problem,
        diagnosis: clarifyResult.diagnosis,
        confidence: clarifyResult.confidence,
        isEmergency: clarifyResult.isEmergency,
        lineItems: clarifyLineItems,
      },
    });

    await adapter.sendMessage(
      fromPhone,
      `${clarifyResult.diagnosis} Estimated price: ${money(clarifyTotal, tenant.currency)}. This estimate is based on the photos and information provided remotely. If the actual issue or scope of work is different than what was presented, the final price may change after inspection. Want me to get this booked in?`,
    );

    return;
  }

  if (openLead) {
    // Already quoted (confidence is set): continuing an existing
    // conversation as a human follow-up reply — record it and let the
    // business reply from their already-built dashboard message thread,
    // rather than re-running AI diagnosis.
    await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "customer", body });
    void sendFollowUpNotificationEmail({
      tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
      customerName: openLead.customer_name || profileName || "A customer",
      body,
    });
    return;
  }

  // New conversation. Real-world finding from Cabos Handyman's actual
  // WhatsApp use (see ROADMAP.md): customers greet first and don't lead
  // with a photo unless asked. Ask immediately rather than attempting a
  // diagnosis with nothing to diagnose.
  if (!mediaRef) {
    await adapter.sendMessage(
      fromPhone,
      `Thanks for reaching out to ${tenant.name}! To get you a fast, accurate price, please send a photo of the problem along with a quick description.`,
    );
    return;
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
    const media = await adapter.fetchMedia(mediaRef);
    imageBase64 = media.base64;
    imageMediaType = media.mediaType;
  } catch (err) {
    console.error("Could not download WhatsApp photo:", err);
    await adapter.sendMessage(fromPhone, "I couldn't load that photo — could you try sending it again?");
    return;
  }

  const result = await getQuoteEstimate({
    data: {
      businessName: tenant.name,
      laborRate: tenant.laborRate,
      serviceCallFee: tenant.serviceCallFee,
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

    // Create the lead now, at the first clarification round, instead of
    // just replying and discarding the original photo/description — that
    // discard was the root cause of the clarification conversation losing
    // context on later rounds.
    const openingProblem = body || "(photo only, no description provided)";
    const { id: leadId } = await createClarifyingLead({
      data: {
        tenantSlug: tenant.slug,
        customerName: profileName || "WhatsApp customer",
        phone: fromPhone,
        channel,
        photoUrl: mediaRef,
        problem: openingProblem,
      },
    });
    await admin.from("lead_messages").insert({ lead_id: leadId, role: "customer", body: openingProblem });
    await admin.from("lead_messages").insert({ lead_id: leadId, role: "assistant", body: questionText });

    await adapter.sendMessage(fromPhone, questionText);
    return;
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
      channel,
      photoUrl: mediaRef,
      problem: body || "(photo only, no description provided)",
      diagnosis: result.diagnosis,
      confidence: result.confidence,
      isEmergency: result.isEmergency,
      lineItems,
    },
  });

  await adapter.sendMessage(
    fromPhone,
    `${result.diagnosis} Estimated price: ${money(total, tenant.currency)}. This estimate is based on the photos and information provided remotely. If the actual issue or scope of work is different than what was presented, the final price may change after inspection. Want me to get this booked in?`,
  );
}
