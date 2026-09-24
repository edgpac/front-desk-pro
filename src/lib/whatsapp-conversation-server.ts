import {
  getQuoteEstimate,
  getFollowUpAnswer,
  classifyFollowUpIntent,
  NO_DESCRIPTION_PLACEHOLDER,
  UNSUPPORTED_IMAGE_MESSAGE,
  type Answer,
  type PriceSheetItem,
} from "@/lib/estimate-server";
import {
  createLead,
  createClarifyingLead,
  createFlaggedLead,
  finalizeLeadWithQuote,
  getAdminClient,
} from "@/lib/public-lead-server";
import { sendFollowUpNotificationEmail } from "@/lib/notify-server";
import { lineItemAmount, money } from "@/lib/mock-data";

// Mirrors QuoteFlow.tsx's rendering of the same field — a pure diagnosis
// visit (nothing else matched yet) needs to say so plainly rather than
// presenting the visit fee as if it were a completed job price. Any other
// case is a simple, fully-additive total: each line item is independently
// verified and correct, and a service-call/diagnosis-style charge that
// coexists with other, separately-matched work is never blended into a
// "credited, X remaining" figure — that number can't be computed honestly
// (the diagnosed item's own eventual price is still unknown), so it isn't
// attempted. The "goes toward the approved repair" language lives in the
// diagnosis text itself (see CREDIT_WORDING_INDICATORS), wording only.
function formatQuotePriceLine(
  totalLow: number,
  currency: string,
  isDiagnosisOnly: boolean,
  hasNoPricedWork: boolean,
): string {
  if (hasNoPricedWork) {
    // Distinct from isDiagnosisOnly: that case still has a real, priced fee
    // to state a number for. This is "negotiated" mode with nothing else
    // matched at all — no lineItem, no number, "$0" would be a lie.
    return `We can't price this without seeing it in person — a service-call/diagnostic fee applies, and we'll confirm the exact amount when we contact you to schedule the visit.`;
  }
  if (isDiagnosisOnly) {
    return `Diagnosis visit fee: ${money(totalLow, currency)}, due for an in-person visit — this applies toward the total repair cost once we know what's needed.`;
  }
  return `Estimated price: ${money(totalLow, currency)}.`;
}

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

// P2: the explicit state machine for routing an inbound message against an
// existing lead — confidence stays null for three genuinely different
// states (actively clarifying, resolved out-of-scope, failed AI
// finalization), and this makes the distinction a single, testable
// decision instead of scattered inline conditions. See
// handleInboundWhatsAppMessage's use of this below for what each outcome
// actually does.
export type LeadRouteDecision =
  | "fresh_quote" // no open lead, or one resolved out-of-scope — start clean
  | "needs_human_review_recovery" // AI previously failed to finalize this lead
  | "continue_clarification" // genuinely still mid-clarification
  | "quoted_follow_up"; // already has a real quote (confidence set) — includes pending_negotiated_price

export function decideLeadRoute(openLead: { confidence: string | null; flag_type: string | null } | null | undefined): LeadRouteDecision {
  if (!openLead) return "fresh_quote";
  if (openLead.flag_type === "needs_human_review") return "needs_human_review_recovery";
  // A resolved out-of-scope lead also has confidence: null (createFlaggedLead/
  // finalizeLeadAsOutOfScope never set it) but is terminal, not active
  // clarification — decision: treat it exactly like no open lead existed.
  if (openLead.flag_type === "outside_service_scope") return "fresh_quote";
  if (openLead.confidence === null) return "continue_clarification";
  return "quoted_follow_up";
}

export type InboundWhatsAppTenant = {
  id: string;
  slug: string;
  name: string;
  email: string;
  currency: string;
  laborRate: number;
  serviceCallFee: number;
  serviceCallFeeMode: "fixed" | "negotiated";
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
    .select("id, customer_name, photo_url, problem, confidence, diagnosis, flag_type")
    .eq("tenant_id", tenant.id)
    .eq("phone", fromPhone)
    .gte("created_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // P2: see decideLeadRoute's own doc comment for what each outcome means
  // and why confidence alone was never enough to distinguish them.
  const route = decideLeadRoute(openLead);

  if (route === "needs_human_review_recovery" && openLead) {
    await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "customer", body });
    const recoveryMessage =
      "Thanks for the additional information. We've sent this to the team for review, and someone will follow up with you.";
    await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "assistant", body: recoveryMessage });
    await adapter.sendMessage(fromPhone, recoveryMessage);
    return;
  }

  // confidence is only ever set once a real quote exists (createLead and
  // finalizeLeadWithQuote both require it; createClarifyingLead deliberately
  // omits it) — so NULL here means this lead is still mid-clarification, not
  // yet quoted. Continue the AI conversation instead of treating this as a
  // human follow-up reply.
  if (route === "continue_clarification" && openLead) {
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
      .select(
        "id, task, category, keywords, pricing_type, price_min, price_max, hours, bundleable, materials_policy, diagnosis_pricing_type, diagnosis_fee",
      )
      .eq("tenant_id", tenant.id);
    const clarifyPriceSheet: PriceSheetItem[] = (clarifyPriceSheetRows ?? []).map((row) => ({
      id: row.id,
      task: row.task,
      category: row.category,
      keywords: row.keywords,
      pricingType: row.pricing_type,
      priceMin: row.price_min,
      priceMax: row.price_max,
      hours: row.hours,
      bundleable: row.bundleable,
      materialsPolicy: row.materials_policy,
      diagnosisFee: row.diagnosis_pricing_type ? { pricingType: row.diagnosis_pricing_type, amount: row.diagnosis_fee } : null,
    }));

    // The original photo stays canonical regardless of whether this reply
    // has its own attachment — re-fetched fresh each round via the adapter
    // (a stable Twilio media URL today; a Meta media id in a future
    // channel) rather than a cached short-lived redirect. A text-only
    // original lead has no photo to re-fetch at all (see photoUrl: "" at
    // lead creation, below) — that's an expected, valid state, not a lost
    // photo, so it must not hit the "lost track of it" fallback every round.
    let clarifyImageBase64: string | undefined;
    let clarifyImageMediaType: string | undefined;
    if (openLead.photo_url) {
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
    }

    let clarifyResult;
    try {
      clarifyResult = await getQuoteEstimate({
        data: {
          businessName: tenant.name,
          laborRate: tenant.laborRate,
          serviceCallFee: tenant.serviceCallFee,
          serviceCallFeeMode: tenant.serviceCallFeeMode,
          priceSheet: clarifyPriceSheet,
          description: openLead.problem,
          ...(clarifyImageBase64 !== undefined ? { imageBase64: clarifyImageBase64 } : {}),
          ...(clarifyImageMediaType !== undefined ? { imageMediaType: clarifyImageMediaType } : {}),
          answers,
        },
      });
    } catch (err) {
      if (err instanceof Error && err.message === UNSUPPORTED_IMAGE_MESSAGE) {
        await adapter.sendMessage(fromPhone, UNSUPPORTED_IMAGE_MESSAGE);
        return;
      }
      // P2: getQuoteEstimate exhausted its retry (e.g. a validation/wording
      // failure it couldn't self-correct) partway through an existing
      // conversation — re-throwing here left the lead at confidence: null
      // forever, so every future message from this phone re-entered this
      // exact same clarification round for the rest of the 48-hour window,
      // live-confirmed as an actual defect. Mark it terminal instead: the
      // conversation and its history are preserved, but the lead no longer
      // satisfies the active-clarification gate above, so the next message
      // won't loop back here — see needs_human_review handling at the top
      // of this function.
      console.error(`WhatsApp clarification finalize failed for lead ${openLead.id}, marking needs_human_review:`, err);
      await admin
        .from("leads")
        .update({ status: "flagged", flag_type: "needs_human_review", flag_reason: "AI couldn't finalize this quote automatically after clarification." })
        .eq("id", openLead.id);
      const recoveryMessage =
        "Thanks for the additional information. We've sent this to the team for review, and someone will follow up with you.";
      await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "assistant", body: recoveryMessage });
      await adapter.sendMessage(fromPhone, recoveryMessage);
      return;
    }

    if (clarifyResult.needsClarification) {
      const question = clarifyResult.questions[0];
      const optionsText = question?.options?.length ? `\n(${question.options.join(" / ")})` : "";
      const questionText = `${question?.question ?? "Can you tell me a bit more?"}${optionsText}`;
      await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "assistant", body: questionText });
      await adapter.sendMessage(fromPhone, questionText);
      return;
    }

    if (clarifyResult.outOfScope) {
      const passAlongMessage = "I can pass your request along to the team for a custom quote — want me to do that?";
      await admin
        .from("leads")
        .update({
          status: "flagged",
          flag_type: "outside_service_scope",
          flag_reason: `Nothing on the price sheet covers: ${openLead.problem}`,
        })
        .eq("id", openLead.id);
      await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "assistant", body: passAlongMessage });
      await adapter.sendMessage(fromPhone, passAlongMessage);
      void sendFollowUpNotificationEmail({
        tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
        customerName: openLead.customer_name || profileName || "A customer",
        body: `[Outside price sheet] ${openLead.problem}`,
      });
      return;
    }

    const clarifyLineItems = clarifyResult.lineItems.map((item) => ({
      description: item.detail ? `${item.description} — ${item.detail}` : item.description,
      qty: 1,
      unit: "job",
      rate: item.amount,
    }));

    await finalizeLeadWithQuote({
      data: {
        leadId: openLead.id,
        tenantSlug: tenant.slug,
        customerName: openLead.customer_name || profileName || "WhatsApp customer",
        phone: fromPhone,
        channel,
        problem: openLead.problem,
        diagnosis: clarifyResult.diagnosis,
        confidence: clarifyResult.confidence,
        isEmergency: clarifyResult.isEmergency,
        lineItems: clarifyLineItems,
        pendingNegotiatedPrice: clarifyResult.hasNoPricedWork,
      },
    });

    await adapter.sendMessage(
      fromPhone,
      `${clarifyResult.diagnosis} ${formatQuotePriceLine(clarifyResult.totalLow, tenant.currency, clarifyResult.isDiagnosisOnly, clarifyResult.hasNoPricedWork)} This estimate is based on the photos and information provided remotely. If the actual issue or scope of work is different than what was presented, the final price may change after inspection. Want me to get this booked in?`,
    );

    return;
  }

  if (route === "quoted_follow_up" && openLead) {
    // Already quoted (confidence is set). A message here could be a
    // follow-up on that same job ("still $194?", "when can you come?") or
    // a returning customer with a completely different problem. Decide
    // directly instead of always asking first — a customer who just sent a
    // fresh photo has already told us everything we need; making them
    // resend it just to answer a question we didn't need to ask is exactly
    // the kind of mechanical, non-production-ready behavior to avoid. The
    // disambiguation question is a fallback for genuine ambiguity, not the
    // default first move.
    await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "customer", body });

    // A new photo attached is itself strong, cheap-to-check evidence of a
    // new job — a customer following up on an existing quote essentially
    // never re-attaches a fresh photo just to ask "is that price still
    // good?". No AI call needed for this case; fall straight through to
    // the fresh-quote flow below, using this message's own photo/body.
    if (!mediaRef) {
      const { sameJob } = await classifyFollowUpIntent({
        data: {
          priorProblem: openLead.problem,
          priorDiagnosis: openLead.diagnosis || "",
          customerReply: body,
        },
      });

      if (sameJob) {
        const { data: lineItemRows } = await admin
          .from("lead_line_items")
          .select("description, rate, qty")
          .eq("lead_id", openLead.id);
        const lineItemsForAnswer = (lineItemRows ?? []).map((row) => ({
          description: row.description,
          detail: "",
          amount: lineItemAmount(row),
        }));

        const { data: historyRows } = await admin
          .from("lead_messages")
          .select("role, body")
          .eq("lead_id", openLead.id)
          .order("created_at", { ascending: true });
        const history = (historyRows ?? []).map((m) => ({
          role: m.role === "customer" ? ("customer" as const) : ("desk" as const),
          text: m.body,
        }));

        const answer = await getFollowUpAnswer({
          data: {
            businessName: tenant.name,
            diagnosis: openLead.diagnosis || "",
            lineItems: lineItemsForAnswer,
            question: body,
            history,
            // P1-B: broadened from the flag alone — a lead reviewed/dismissed
            // without a price ever being added has the identical "nothing to
            // state a number for" problem, and lineItemRows is already fetched
            // above for this exact branch.
            hasNoPricedWork: openLead.flag_type === "pending_negotiated_price" || (lineItemRows ?? []).length === 0,
          },
        });

        await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "assistant", body: answer });
        await adapter.sendMessage(fromPhone, answer);
        void sendFollowUpNotificationEmail({
          tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
          customerName: openLead.customer_name || profileName || "A customer",
          body,
        });
        return;
      }
      // Classified as a new, different job with no photo attached — falls
      // through to the fresh-quote flow below, which will correctly ask
      // for a photo since none has actually been provided yet.
    }
    void sendFollowUpNotificationEmail({
      tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
      customerName: openLead.customer_name || profileName || "A customer",
      body,
    });
    // Falls through to the fresh-quote flow below — either a photo was
    // attached (strong new-job signal), or the classifier above decided
    // this describes a different problem.
  }

  // A genuinely new job — either a first-time conversation, or a returning
  // customer the block above just determined has a different problem this
  // time (new photo attached, or classified as such). A photo is the best
  // signal, but getQuoteEstimate already handles a text-only description
  // fine (imageBase64 is optional — the same call shape the widget's
  // text-only flow already uses successfully). Only ask for more when the
  // description itself is too thin to work with — matching the widget's
  // own canSubmit threshold (QuoteFlow.tsx) — rather than always demanding
  // a photo regardless of what the customer already said, which reads as a
  // broken bot repeating itself when the customer has, in fact, described
  // the job in enough detail.
  const hasSubstantialDescription = body.trim().length > 10;
  if (!mediaRef && !hasSubstantialDescription) {
    await adapter.sendMessage(
      fromPhone,
      `Thanks for reaching out to ${tenant.name}! To get you a fast, accurate price, send a photo along with a description of what you need — or just describe the problem in more detail and I can help without one.`,
    );
    return;
  }

  const { data: priceSheetRows } = await admin
    .from("price_sheet_items")
    .select(
      "id, task, category, keywords, pricing_type, price_min, price_max, hours, bundleable, materials_policy, diagnosis_pricing_type, diagnosis_fee",
    )
    .eq("tenant_id", tenant.id);

  const priceSheet: PriceSheetItem[] = (priceSheetRows ?? []).map((row) => ({
    id: row.id,
    task: row.task,
    category: row.category,
    keywords: row.keywords,
    pricingType: row.pricing_type,
    priceMin: row.price_min,
    priceMax: row.price_max,
    hours: row.hours,
    bundleable: row.bundleable,
    materialsPolicy: row.materials_policy,
    diagnosisFee: row.diagnosis_pricing_type ? { pricingType: row.diagnosis_pricing_type, amount: row.diagnosis_fee } : null,
  }));

  let imageBase64: string | undefined;
  let imageMediaType: string | undefined;
  if (mediaRef) {
    try {
      const media = await adapter.fetchMedia(mediaRef);
      imageBase64 = media.base64;
      imageMediaType = media.mediaType;
    } catch (err) {
      console.error("Could not download WhatsApp photo:", err);
      await adapter.sendMessage(fromPhone, "I couldn't load that photo — could you try sending it again?");
      return;
    }
  }

  let result;
  try {
    result = await getQuoteEstimate({
      data: {
        businessName: tenant.name,
        laborRate: tenant.laborRate,
        serviceCallFee: tenant.serviceCallFee,
        serviceCallFeeMode: tenant.serviceCallFeeMode,
        priceSheet,
        description: body || NO_DESCRIPTION_PLACEHOLDER,
        ...(imageBase64 !== undefined ? { imageBase64 } : {}),
        ...(imageMediaType !== undefined ? { imageMediaType } : {}),
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message === UNSUPPORTED_IMAGE_MESSAGE) {
      await adapter.sendMessage(fromPhone, UNSUPPORTED_IMAGE_MESSAGE);
      return;
    }
    throw err;
  }

  if (result.needsClarification) {
    const question = result.questions[0];
    const optionsText = question?.options?.length ? `\n(${question.options.join(" / ")})` : "";
    const questionText = `${question?.question ?? "Can you tell me a bit more?"}${optionsText}`;

    // Create the lead now, at the first clarification round, instead of
    // just replying and discarding the original photo/description — that
    // discard was the root cause of the clarification conversation losing
    // context on later rounds.
    const openingProblem = body || NO_DESCRIPTION_PLACEHOLDER;
    const { id: leadId } = await createClarifyingLead({
      data: {
        tenantSlug: tenant.slug,
        customerName: profileName || "WhatsApp customer",
        phone: fromPhone,
        channel,
        // No photo on a text-only lead — "" is the same "nothing to
        // re-fetch" signal the clarification-continuation branch above
        // already treats as expected (falls into its existing "lost track
        // of the photo, please resend" guard) rather than a real media ref.
        photoUrl: mediaRef ?? "",
        problem: openingProblem,
      },
    });
    await admin.from("lead_messages").insert({ lead_id: leadId, role: "customer", body: openingProblem });
    await admin.from("lead_messages").insert({ lead_id: leadId, role: "assistant", body: questionText });

    await adapter.sendMessage(fromPhone, questionText);
    return;
  }

  if (result.outOfScope) {
    const openingProblem = body || NO_DESCRIPTION_PLACEHOLDER;
    const passAlongMessage = "I can pass your request along to the team for a custom quote — want me to do that?";
    const { id: leadId } = await createFlaggedLead({
      data: {
        tenantSlug: tenant.slug,
        customerName: profileName || "WhatsApp customer",
        phone: fromPhone,
        channel,
        photoUrl: mediaRef ?? null,
        problem: openingProblem,
        flagType: "outside_service_scope",
        flagReason: `Nothing on the price sheet covers: ${openingProblem}`,
      },
    });
    await admin.from("lead_messages").insert({ lead_id: leadId, role: "customer", body: openingProblem });
    await admin.from("lead_messages").insert({ lead_id: leadId, role: "assistant", body: passAlongMessage });
    await adapter.sendMessage(fromPhone, passAlongMessage);
    void sendFollowUpNotificationEmail({
      tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
      customerName: profileName || "A customer",
      body: `[Outside price sheet] ${openingProblem}`,
    });
    return;
  }

  const lineItems = result.lineItems.map((item) => ({
    description: item.detail ? `${item.description} — ${item.detail}` : item.description,
    qty: 1,
    unit: "job",
    rate: item.amount,
  }));

  await createLead({
    data: {
      tenantSlug: tenant.slug,
      customerName: profileName || "WhatsApp customer",
      phone: fromPhone,
      address: "",
      channel,
      ...(mediaRef !== undefined ? { photoUrl: mediaRef } : {}),
      problem: body || NO_DESCRIPTION_PLACEHOLDER,
      diagnosis: result.diagnosis,
      confidence: result.confidence,
      isEmergency: result.isEmergency,
      lineItems,
      pendingNegotiatedPrice: result.hasNoPricedWork,
    },
  });

  await adapter.sendMessage(
    fromPhone,
    `${result.diagnosis} ${formatQuotePriceLine(result.totalLow, tenant.currency, result.isDiagnosisOnly, result.hasNoPricedWork)} This estimate is based on the photos and information provided remotely. If the actual issue or scope of work is different than what was presented, the final price may change after inspection. Want me to get this booked in?`,
  );
}
