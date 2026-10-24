import {
  getQuoteEstimate,
  getFollowUpAnswer,
  classifyFollowUpIntent,
  classifyFollowUpPhotoIntent,
  isSupportedImageBase64,
  detectLanguage,
  NO_DESCRIPTION_PLACEHOLDER,
  UNSUPPORTED_IMAGE_MESSAGE,
  type Answer,
  type PriceSheetItem,
  type DetectedLanguage,
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
import {
  evaluateInboundInteraction,
  evaluateOutboundInteraction,
  hasPriorInboundInteraction,
  claimLoopNotice,
  releaseLoopNoticeClaim,
  markLoopNoticeSent,
  LoopGuardCheckFailed,
  type FactSignatureInput,
  type LoopGuardEvaluation,
} from "@/lib/whatsapp-loop-guard-server";
import {
  isOptOutKeyword,
  isOptInKeyword,
  isOptedOut,
  recordOptOut,
  claimOptOutConfirmation,
  releaseOptOutConfirmationClaim,
  markOptOutConfirmationSent,
  resumeOptOut,
  OptOutCheckFailed,
  normalizePhone,
} from "@/lib/whatsapp-opt-out-server";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// WhatsApp AI-to-AI / non-progressing-answer loop guard — see
// 0024_whatsapp_loop_guards.sql and whatsapp-loop-guard-server.ts for the
// full design. This message is deliberately generic (never restates a
// price or any job-specific detail) so the pause itself can never become
// part of a stale/incorrect restatement if sent more than once (the
// guard's notification is explicitly at-least-once, never exactly-once —
// see markLoopNoticeSent's own comment).
export const LOOP_PAUSE_MESSAGE =
  "We've paused automated replies here for a moment — our team will follow up with you directly.";

// Bounded, in-process retry for confirming a pause notice as sent AFTER
// the real provider send has already succeeded — see handleLoopGuardPause
// below for why this exists (a prior review found the failure path for
// "send succeeded, but the DB write confirming it failed" was silently
// ignored). Small and immediate: the underlying cause of a single failed
// write here is usually transient, so a couple of quick retries often
// resolves it cleanly; this is not an attempt to build real reliability
// infrastructure, just to not give up on the FIRST transient blip when a
// cheap retry costs almost nothing against a webhook response budget.
const LOOP_NOTICE_MARK_SENT_RETRIES = 3;
const LOOP_NOTICE_MARK_SENT_RETRY_DELAY_MS = 200;

// Attempts to flag the currently-open lead (if any) as loop_suspected —
// WHERE flag_type IS NULL, so an existing, unrelated flag (needs_human_
// review, outside_service_scope, etc.) is never overwritten — and
// attempts/retries the pause notice if one is still owed. Called both from
// the moment a trip is first detected and from the fast-path at the top of
// handleInboundWhatsAppMessage for an already-tripped phone, so a notice
// left 'pending' after a crash or timeout gets retried the next time any
// message arrives, per the documented at-least-once guarantee.
// flag_type values that mean the customer was ALREADY sent a real,
// specific message about this exact situation needing a human
// (localizedPassAlongMessage for outside_service_scope,
// localizedRecoveryMessage for needs_human_review — both sent in the same
// breath as the flag being set). Production regression: a customer got
// "I'll pass your message along to our team." immediately followed, on
// their very next message, by the loop guard's own generic "We've paused
// automated replies... our team will follow up with you directly." — true
// but redundant, since they were just told exactly that. Suppressing the
// SECOND message doesn't weaken the guard itself: the trip state (and the
// future-message pause it causes) lives entirely in whatsapp_loop_guards,
// untouched by this — only the repeat customer-facing text is skipped.
const ALREADY_HANDED_OFF_FLAG_TYPES = new Set(["outside_service_scope", "needs_human_review"]);

export async function handleLoopGuardPause(params: {
  admin: ReturnType<typeof getAdminClient>;
  tenant: InboundWhatsAppTenant;
  fromPhone: string;
  adapter: ChannelAdapter;
  leadId: string | null;
}): Promise<void> {
  const { admin, tenant, fromPhone, adapter, leadId } = params;

  // Resolve which lead (if any) this pause concerns and its CURRENT flag —
  // leadId is often null here (the top-of-function inbound-trip-check call
  // site never looks one up), so a fresh, 48-hour-windowed lookup by
  // (tenant, phone) is the only way to see it, same scope as every other
  // open-lead lookup in this file.
  let relevantLeadId = leadId;
  let currentFlagType: string | null = null;
  if (relevantLeadId) {
    const { data } = await admin.from("leads").select("flag_type").eq("id", relevantLeadId).maybeSingle();
    currentFlagType = (data?.flag_type as string | undefined) ?? null;
  } else {
    const { data } = await admin
      .from("leads")
      .select("id, flag_type")
      .eq("tenant_id", tenant.id)
      .eq("phone", fromPhone)
      .gte("created_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    relevantLeadId = (data?.id as string | undefined) ?? null;
    currentFlagType = (data?.flag_type as string | undefined) ?? null;
  }

  if (currentFlagType != null && ALREADY_HANDED_OFF_FLAG_TYPES.has(currentFlagType)) {
    return;
  }

  if (relevantLeadId) {
    const { error } = await admin
      .from("leads")
      .update({
        status: "flagged",
        flag_type: "loop_suspected",
        flag_reason:
          "Automated replies paused — repeated or high-volume WhatsApp exchange detected.",
      })
      .eq("id", relevantLeadId)
      .is("flag_type", null);
    if (error) {
      console.error(
        `Could not flag lead ${relevantLeadId} as loop_suspected (non-fatal, pause still in effect):`,
        error.message,
      );
    }
  }

  // Atomic claim, not a plain read — closes the concurrent-notice-claim
  // race a prior review found (two near-simultaneous callers could both
  // read notice_status = 'pending' and both attempt a real send before
  // either confirmed). A caller that doesn't win the claim must not send
  // at all; the notice is either already sent, already being sent by the
  // caller who did win, or nothing is owed yet.
  const claimed = await claimLoopNotice(admin, tenant.id, fromPhone);
  if (!claimed) return;

  try {
    await adapter.sendMessage(fromPhone, LOOP_PAUSE_MESSAGE);
  } catch (err) {
    // The provider SEND itself failed (not a DB-confirmation problem) —
    // release immediately so the very next inbound message retries right
    // away, per the existing at-least-once design. Still never claims
    // exactly-once delivery — see mark_whatsapp_loop_notice_sent's own
    // comment for the honest, accepted uncertainty when a provider call
    // times out after possibly already succeeding.
    await releaseLoopNoticeClaim(admin, tenant.id, fromPhone);
    console.error(
      `Could not send WhatsApp loop-pause notice for tenant ${tenant.id}, phone ${fromPhone} (will retry on next inbound message):`,
      err,
    );
    return;
  }

  // The provider has CONFIRMED the send succeeded. Record that
  // confirmation durably — retried a few times in-process, since a
  // single failed write here is often transient. A prior review found
  // this call's return value was previously never checked at all: if the
  // very first attempt failed, the claim was silently left stuck in
  // 'sending' with no explicit handling, and the next inbound message's
  // staleness-based reclaim would then resend the IDENTICAL notice — a
  // guaranteed, not just possible, duplicate.
  let confirmed = false;
  for (let attempt = 0; attempt < LOOP_NOTICE_MARK_SENT_RETRIES && !confirmed; attempt++) {
    if (attempt > 0) await sleep(LOOP_NOTICE_MARK_SENT_RETRY_DELAY_MS);
    confirmed = await markLoopNoticeSent(admin, tenant.id, fromPhone);
  }

  if (!confirmed) {
    // The message DEFINITELY reached the customer (no exception above),
    // but this database could not confirm that fact after several
    // attempts — a genuinely uncertain outcome, not a guarantee this
    // code can manufacture. Deliberately NOT released back to 'pending'
    // here: doing so would let the very next inbound message resend
    // immediately, turning an uncertain outcome into a GUARANTEED
    // duplicate. Left in 'sending' instead, so recovery follows the same
    // staleness-based reclaim already relied on for a provider-timeout-
    // with-unknown-result — at most one eventual retry, bounded by
    // LOOP_NOTICE_CLAIM_STALE_SECONDS, consistent with the same honest
    // at-least-once guarantee this design has always stated.
    console.error(
      `WhatsApp loop-pause notice was sent to tenant ${tenant.id}, phone ${fromPhone}, but could not be confirmed in the database after ${LOOP_NOTICE_MARK_SENT_RETRIES} attempts — delivery state is now uncertain; recovery will follow the existing stale-claim path, not an immediate retry.`,
    );
  }
}

export const OPT_OUT_CONFIRMATION_MESSAGE =
  "You've been unsubscribed and won't receive further messages here. Reply START to resubscribe.";
export const OPT_IN_CONFIRMATION_MESSAGE =
  "You're resubscribed — you'll receive messages here again.";

// Same claim -> send -> confirm crash-safety sequence as
// handleLoopGuardPause above (see its own comments for the full reasoning
// — a DIFFERENT concern, deliberately not merged with it: opting out is an
// explicit customer request, not a detected non-progressing exchange).
// Called only after recordOptOut has already written the opted-out state,
// so this message must bypass the normal opt-out send-block — that's
// exactly what adapter.sendMessage's third parameter is for.
//
// Takes BOTH a normalizedPhone (every whatsapp_opt_outs key below — must
// be the exact same normalized form recordOptOut just wrote under in
// handleOptOutState, or the claim here would silently look up a
// different key than the row that actually exists) and the original
// fromPhone (the actual provider-routable delivery address passed to
// adapter.sendMessage — normalization is a DB-key concern only, never
// applied to where the message is actually sent).
async function handleOptOutConfirmation(params: {
  admin: ReturnType<typeof getAdminClient>;
  tenant: InboundWhatsAppTenant;
  fromPhone: string;
  normalizedPhone: string;
  adapter: ChannelAdapter;
}): Promise<void> {
  const { admin, tenant, fromPhone, normalizedPhone, adapter } = params;
  const claimed = await claimOptOutConfirmation(admin, tenant.id, normalizedPhone);
  if (!claimed) return;
  try {
    await adapter.sendMessage(fromPhone, OPT_OUT_CONFIRMATION_MESSAGE, true);
  } catch (err) {
    await releaseOptOutConfirmationClaim(admin, tenant.id, normalizedPhone);
    console.error(
      `Could not send WhatsApp opt-out confirmation for tenant ${tenant.id}, phone ${fromPhone} (will retry on next inbound message):`,
      err,
    );
    return;
  }
  let confirmed = false;
  for (let attempt = 0; attempt < LOOP_NOTICE_MARK_SENT_RETRIES && !confirmed; attempt++) {
    if (attempt > 0) await sleep(LOOP_NOTICE_MARK_SENT_RETRY_DELAY_MS);
    confirmed = await markOptOutConfirmationSent(admin, tenant.id, normalizedPhone);
  }
  if (!confirmed) {
    console.error(
      `WhatsApp opt-out confirmation was sent to tenant ${tenant.id}, phone ${fromPhone}, but could not be confirmed in the database after ${LOOP_NOTICE_MARK_SENT_RETRIES} attempts — delivery state is now uncertain.`,
    );
  }
}

// The opt-in confirmation does NOT need adapter.sendMessage's bypass —
// by the time this runs, resumeOptOut has already cleared the opted-out
// state, so the normal send path's own check already passes.
async function sendOptInConfirmation(fromPhone: string, adapter: ChannelAdapter): Promise<void> {
  try {
    await adapter.sendMessage(fromPhone, OPT_IN_CONFIRMATION_MESSAGE);
  } catch (err) {
    console.error(`Could not send WhatsApp opt-in confirmation to ${fromPhone}:`, err);
  }
}

// The opt-out/opt-in state machine — called as the very first thing in
// handleInboundWhatsAppMessage, before even the loop guard, since an
// opted-out customer must get NO automated reply at all regardless of
// what the loop guard's own evidence would otherwise allow, and an
// opt-out/opt-in control message itself is never ordinary conversation
// content worth feeding into that evidence log. Returns true if the
// caller should stop processing this message entirely (opted out and not
// an opt-in message; or this message WAS the opt-out/opt-in keyword
// itself, already fully handled here).
async function handleOptOutState(params: {
  admin: ReturnType<typeof getAdminClient>;
  tenant: InboundWhatsAppTenant;
  fromPhone: string;
  body: string;
  adapter: ChannelAdapter;
}): Promise<{ stop: boolean }> {
  const { admin, tenant, fromPhone, body, adapter } = params;
  // Normalized ONCE here and used for every whatsapp_opt_outs key below —
  // matches exactly what the three outbound enforcement checks already do
  // (isOptedOut(..., normalizePhone(params.to)) inside sendWhatsAppMessage/
  // sendWhatsAppMessageMeta/sendWhatsAppTemplateMessage) and what
  // resumeWhatsAppOptOut's own dashboard action and the loop guard's
  // resumeLoopGuardState callers already do. A prior review found this
  // function used the raw, unnormalized fromPhone for its DB keys while
  // the enforcement checks normalized theirs — if the raw and normalized
  // forms of a number ever actually differed (not just coincidentally
  // matched), the write and read keys would silently diverge and an opt-
  // out could fail to enforce. adapter.sendMessage below still takes the
  // original fromPhone, never the normalized form — normalization is only
  // about the DB key, not the provider-routable delivery address.
  const normalizedPhone = normalizePhone(fromPhone);

  if (isOptOutKeyword(body)) {
    let justOptedOut: boolean;
    try {
      ({ justOptedOut } = await recordOptOut(admin, tenant.id, normalizedPhone));
    } catch (err) {
      // Fails CLOSED: if the opt-out itself can't be durably recorded,
      // do not proceed as if this were ordinary conversation — the
      // customer explicitly asked to stop, and the safer failure here is
      // "no reply at all" rather than risking a reply to someone who may
      // now be opted out in intent but not yet in the database.
      console.error(
        `Could not record WhatsApp opt-out for tenant ${tenant.id}, phone ${fromPhone}:`,
        err,
      );
      return { stop: true };
    }
    if (justOptedOut) {
      await handleOptOutConfirmation({ admin, tenant, fromPhone, normalizedPhone, adapter });
    }
    return { stop: true };
  }

  let optedOut: boolean;
  try {
    optedOut = await isOptedOut(admin, tenant.id, normalizedPhone);
  } catch (err) {
    console.error(
      `WhatsApp opt-out check failed for tenant ${tenant.id}, phone ${fromPhone} — failing closed (no automated reply):`,
      err instanceof OptOutCheckFailed ? err.message : err,
    );
    return { stop: true };
  }

  if (!optedOut) return { stop: false };

  if (isOptInKeyword(body)) {
    const resumed = await resumeOptOut(admin, tenant.id, normalizedPhone, "opt_in_keyword");
    if (resumed) await sendOptInConfirmation(fromPhone, adapter);
    return { stop: true };
  }

  // Currently opted out, and this message is neither the opt-out nor the
  // opt-in keyword — an ordinary message must never auto-resume
  // messaging. No reply, no AI call, nothing.
  return { stop: true };
}

// The one chokepoint every automated WhatsApp reply in this file sends
// through. Evaluates the loop guard (repeated-answer signal AND volume
// signal, independently — see evaluate_whatsapp_loop_guard) before
// sending; on a trip (just now or already tripped), suppresses the
// automated reply entirely and hands off to handleLoopGuardPause instead.
// On a guard-check FAILURE (RPC error, etc.), fails CLOSED — no automated
// reply — rather than the fail-open choice claimLeadSlot makes elsewhere
// in this file for an unrelated, lower-stakes concern (a missed dedup
// there risks a possible duplicate lead; failing open here risks
// unbounded automated cost/spam).
export async function sendGuardedReply(params: {
  admin: ReturnType<typeof getAdminClient>;
  tenant: InboundWhatsAppTenant;
  fromPhone: string;
  adapter: ChannelAdapter;
  leadId: string | null;
  signature: FactSignatureInput;
  messageText: string;
  onSent?: () => Promise<void>;
}): Promise<{ sent: boolean }> {
  const { admin, tenant, fromPhone, adapter, leadId, signature, messageText, onSent } = params;

  let tripped: boolean;
  try {
    const evaluation = await evaluateOutboundInteraction(admin, tenant.id, fromPhone, {
      signature,
      leadId,
    });
    tripped = evaluation.tripped;
  } catch (err) {
    console.error(
      `WhatsApp loop guard check failed for tenant ${tenant.id}, phone ${fromPhone} — failing closed (no automated reply):`,
      err instanceof LoopGuardCheckFailed ? err.message : err,
    );
    tripped = true; // fail closed
  }

  if (tripped) {
    await handleLoopGuardPause({ admin, tenant, fromPhone, adapter, leadId });
    return { sent: false };
  }

  if (onSent) await onSent();
  await adapter.sendMessage(fromPhone, messageText);
  return { sent: true };
}

// Duplicate-lead race mitigation (0019_lead_write_atomicity.sql). The
// "no open lead found" read below and the eventual lead-creation write are
// separated by an AI round-trip (several seconds) — long enough for a
// second, near-simultaneous message from the same customer to also read
// "no open lead" and create a second one. claimLeadSlot/releaseLeadSlot
// wrap only the branch that actually creates a brand-new lead; a caller
// that can't acquire the claim (another request is already handling this
// phone's first message) polls briefly for that lead to appear via
// findRecentLeadId, rather than racing to create a duplicate. If nothing
// appears within the bound, it proceeds exactly as before this fix — never
// worse than the pre-fix behavior, just no longer better-than-average-case
// racy for the common, fast-response case.
async function claimLeadSlot(
  admin: ReturnType<typeof getAdminClient>,
  tenantId: string,
  phone: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("claim_whatsapp_lead_slot", {
    p_tenant_id: tenantId,
    p_phone: phone,
  });
  if (error) {
    console.error("claim_whatsapp_lead_slot failed, proceeding without the claim:", error.message);
    return true; // fail open — never block a real conversation over a lock-table hiccup
  }
  return Boolean(data);
}

async function releaseLeadSlot(
  admin: ReturnType<typeof getAdminClient>,
  tenantId: string,
  phone: string,
): Promise<void> {
  const { error } = await admin.rpc("release_whatsapp_lead_slot", {
    p_tenant_id: tenantId,
    p_phone: phone,
  });
  if (error) {
    // Not fatal — p_stale_seconds on the claim RPC bounds how long a
    // leaked claim can block a later, genuinely new conversation.
    console.error("release_whatsapp_lead_slot failed:", error.message);
  }
}

// Reuses the exact same (tenant, phone) mutex as the brand-new-lead path
// above, applied to a DIFFERENT risk: two near-simultaneous messages for
// a lead that's already mid-clarification (or already quoted and
// answering a same-job follow-up) both running the AI pipeline
// concurrently for that one lead. Unlike a duplicate brand-new lead (an
// annoying but recoverable outcome), finalizeLeadWithQuote's own
// update_lead_with_line_items (0019_lead_write_atomicity.sql)
// unconditionally INSERTs line items whenever any are supplied — calling
// it twice concurrently for the same lead would insert duplicate line
// items on that one lead, a real data-correctness problem, not just a
// duplicate reply. It also directly inflates the WhatsApp loop guard's
// own evidence with self-inflicted duplicates rather than genuine
// repetition.
//
// Deliberately NOT the same "poll for something to appear, then proceed
// anyway" fallback the brand-new-lead path uses on a lost claim — there's
// no safe way to "proceed anyway" here (the risk above applies), so a
// lost claim here means skipping this round's automated reply entirely.
// The customer's message is still recorded (by the caller, before this
// is invoked); the in-flight round will complete and reply on its own.
// This is a deliberate, stated trade-off, not an oversight: a message
// arriving in this exact race window may not get its own immediate
// automated reply. Widening this to a retry/poll loop was considered and
// rejected for this pass as unnecessary complexity for a narrow race
// window — worth revisiting if it proves too strict in practice.
export async function withLeadProcessingClaim(
  admin: ReturnType<typeof getAdminClient>,
  tenantId: string,
  phone: string,
  run: () => Promise<void>,
): Promise<boolean> {
  const claimed = await claimLeadSlot(admin, tenantId, phone);
  if (!claimed) return false;
  try {
    await run();
  } finally {
    await releaseLeadSlot(admin, tenantId, phone);
  }
  return true;
}

async function findRecentLeadId(
  admin: ReturnType<typeof getAdminClient>,
  tenantId: string,
  phone: string,
): Promise<string | null> {
  const { data } = await admin
    .from("leads")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("phone", phone)
    .gte("created_at", new Date(Date.now() - 2 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

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
  hasPartiallyDeferredWork: boolean,
  language: DetectedLanguage,
): string {
  if (hasNoPricedWork) {
    // Distinct from isDiagnosisOnly: that case still has a real, priced fee
    // to state a number for. This is "negotiated" mode with nothing else
    // matched at all — no lineItem, no number, "$0" would be a lie.
    return isEs(language)
      ? "No podemos darle un precio sin verlo en persona — aplica una tarifa de visita de servicio/diagnóstico, y confirmaremos el monto exacto cuando nos comuniquemos con usted para agendar la visita."
      : "We can't price this without seeing it in person — a service-call/diagnostic fee applies, and we'll confirm the exact amount when we contact you to schedule the visit.";
  }
  const pricedPortion = isDiagnosisOnly
    ? isEs(language)
      ? `Tarifa de visita de diagnóstico: ${money(totalLow, currency)}, correspondiente a una visita en persona — este monto se aplica al costo total de la reparación una vez que sepamos qué se necesita.`
      : `Diagnosis visit fee: ${money(totalLow, currency)}, due for an in-person visit — this applies toward the total repair cost once we know what's needed.`
    : isEs(language)
      ? `Precio estimado: ${money(totalLow, currency)}.`
      : `Estimated price: ${money(totalLow, currency)}.`;
  // P2 mixed-pricing: at least one other described issue has no price-sheet
  // match and was deferred — the total above is real and correct for what
  // IS priced, but it is not the whole request, so that must be said
  // explicitly rather than left to be inferred.
  if (hasPartiallyDeferredWork) {
    return isEs(language)
      ? `${pricedPortion} Una parte de esta solicitud aún necesita una revisión en persona antes de poder darle un precio — se lo confirmaremos por separado cuando nos comuniquemos.`
      : `${pricedPortion} One part of this request still needs an in-person look before we can price it — we'll confirm that separately when we're in touch.`;
  }
  return pricedPortion;
}

// WhatsApp-specific customer-facing copy, localized to the customer's
// detected language (estimate-server.ts's detectLanguage/LANGUAGE_NAME —
// Claude already localizes diagnosis/questions/options per that same
// detection inside getQuoteEstimate/getFollowUpAnswer/
// classifyFollowUpPhotoIntent's own prompts). These are the surrounding
// hardcoded strings THIS file builds itself around that AI-generated text
// — previously always English regardless of detected language, producing
// a jarring language switch mid-conversation for Spanish-speaking
// customers (confirmed live, 2026-10-19: a fully-Spanish conversation
// ended with an English "Estimated price... Want me to get this booked
// in?" tail). Hebrew (also a detectLanguage outcome) has no translated
// copy anywhere in this codebase yet (same pre-existing gap already in
// reply-composer.ts's buildSuggestedReply) — falls back to English here
// too, for consistency with that existing precedent rather than inventing
// a half-covered third language.
function isEs(language: DetectedLanguage): boolean {
  return language === "es";
}

function localizedGreeting(language: DetectedLanguage, businessName: string): string {
  return isEs(language)
    ? `¡Gracias por contactar a ${businessName}! Para darle un precio rápido y preciso, envíe una foto junto con una descripción de lo que necesita — o simplemente describa el problema con más detalle y puedo ayudarle sin foto.`
    : `Thanks for reaching out to ${businessName}! To get you a fast, accurate price, send a photo along with a description of what you need — or just describe the problem in more detail and I can help without one.`;
}

// A short wave, prefixed onto whatever the real first reply turns out to be
// (a clarifying question, an out-of-scope handoff, or an instant quote) —
// never its own separate message, and never a fixed, generic "how can I
// help" line, since the actual content right after it is always real,
// AI-generated text specific to what the customer described. Callers gate
// this behind isFirstContact (openLead == null — see
// handleInboundWhatsAppMessage's own 48-hour, phone+tenant-scoped lookup)
// rather than applying it unconditionally, so a message that's part of an
// existing conversation (a flagged lead still inside the 48-hour window, or
// a "different job" fallthrough from an already-quoted lead) never gets
// re-greeted — only a message with no lead at all in that window does.
// Deliberately NOT used for the thin-description case (localizedGreeting above opens warmly on
// its own — "Hi! Thanks for reaching out..." would be redundant).
function localizedFirstContactGreeting(language: DetectedLanguage): string {
  return isEs(language) ? "¡Hola! 👋 " : "Hi! 👋 ";
}

function localizedLostPhotoMessage(language: DetectedLanguage): string {
  return isEs(language)
    ? "Disculpe, perdí la foto original — ¿podría reenviarla junto con su respuesta?"
    : "Sorry, I lost track of the original photo — could you resend it along with your answer?";
}

// A WhatsApp-only Spanish variant — the shared UNSUPPORTED_IMAGE_MESSAGE
// constant (estimate-server.ts) stays English-only and unchanged, since
// it's also compared with === as an error-type sentinel across channels
// that don't have a conversational language to detect (the dashboard price
// sheet upload, the widget's QuoteFlow.tsx). Only the customer-facing text
// actually sent over WhatsApp is localized here.
function localizedUnsupportedImageMessage(language: DetectedLanguage): string {
  return isEs(language)
    ? "Por favor envíe una foto en formato JPG o PNG. Las fotos HEIC no son compatibles."
    : UNSUPPORTED_IMAGE_MESSAGE;
}

function localizedRecoveryMessage(language: DetectedLanguage): string {
  return isEs(language)
    ? "Entendido — hemos anotado todo hasta ahora, y el equipo le dará seguimiento con un precio. Si está preguntando sobre algo más, solo descríbalo y le daremos un nuevo estimado."
    : "Got it — we've noted everything so far, and the team will follow up with you on a price. If you're asking about something else, just describe it and we'll get you a fresh estimate.";
}

function localizedClarifyingFallbackQuestion(language: DetectedLanguage): string {
  return isEs(language) ? "¿Podría darme un poco más de detalle?" : "Can you tell me a bit more?";
}

function localizedPassAlongMessage(language: DetectedLanguage): string {
  return isEs(language)
    ? "Voy a pasar su mensaje a nuestro equipo."
    : "I'll pass your message along to our team.";
}

function localizedPhotoLoadFailedMessage(language: DetectedLanguage): string {
  return isEs(language)
    ? "No pude cargar esa foto — ¿podría intentar enviarla de nuevo?"
    : "I couldn't load that photo — could you try sending it again?";
}

function localizedPhotoDisambiguationQuestion(language: DetectedLanguage): string {
  return isEs(language)
    ? "¿Esta foto es sobre el trabajo que ya cotizamos, o es algo diferente que le gustaría que cotizáramos? Si es el mismo trabajo, por favor reenvíe la foto para poder verla con más detalle."
    : "Is this photo about the job I already quoted, or something different you'd like priced? If it's the same job, go ahead and resend the photo so I can take a closer look.";
}

// Text equivalent of the photo disambiguation question above — same
// "ambiguous" classification outcome (classifyFollowUpIntent now returns a
// 3-way same_job/different_job/ambiguous result, mirroring
// classifyFollowUpPhotoIntent), just without the "resend the photo"
// instruction, which only makes sense for the photo path.
function localizedTextDisambiguationQuestion(language: DetectedLanguage): string {
  return isEs(language)
    ? "¿Esto es sobre el trabajo que ya cotizamos, o es algo diferente que le gustaría que cotizáramos?"
    : "Is this about the job I already quoted, or something different you'd like priced?";
}

function localizedReassessFailedMessage(language: DetectedLanguage): string {
  return isEs(language)
    ? "Gracias por la foto — el equipo la revisará de cerca y le daremos seguimiento con el precio actualizado."
    : "Thanks for the photo — I'll have the team take a closer look and follow up on the updated price.";
}

function localizedAskToConfirmMessage(language: DetectedLanguage): string {
  return isEs(language)
    ? "Gracias por la foto — para asegurarme de darle el precio correcto, ¿podría confirmar: esto sigue siendo sobre el mismo trabajo que cotizamos, o algo cambió?"
    : "Thanks for the photo — to make sure I price this correctly, can you confirm: is this still about the same job I quoted, or has something changed?";
}

function localizedPhotoUpdateIntro(language: DetectedLanguage): string {
  return isEs(language)
    ? "¡Gracias por la foto! Según lo que puedo ver, actualicé su estimado:"
    : "Thanks for the photo! Based on what I can see, I've updated your estimate:";
}

function localizedPreviousPriceNote(language: DetectedLanguage, amount: string): string {
  return isEs(language) ? ` (antes ${amount}.)` : ` (previously ${amount}.)`;
}

// Evidence-aware closing line — must never claim photo evidence that was
// never actually sent. Live-confirmed defect, 2026-10-19: a text-only
// Spanish conversation (no photo ever attached) still received "Este
// estimado se basa en las fotos..." — the photo-based wording was
// previously unconditional regardless of whether a photo existed. hadPhoto
// reflects whether THIS round's message actually carried one (not whether
// any photo exists anywhere in the lead's history).
// Kept to ONE sentence plus the booking question — a WhatsApp reply that
// repeats this on every single quote shouldn't spend three sentences on a
// disclaimer every time. Still says exactly what it must (a genuinely
// different in-person finding can change the price) and still correctly
// distinguishes "based on what you described" from "based on the photos" —
// that distinction is load-bearing (never claim photo evidence that was
// never sent), not just wording, so it's preserved even in the shorter form.
function localizedEstimateBasisClosing(language: DetectedLanguage, hadPhoto: boolean): string {
  if (isEs(language)) {
    const basis = hadPhoto ? "las fotos" : "lo descrito";
    return `El precio podría cambiar si el problema real es diferente a ${basis} — ¿le gustaría que agendemos la visita?`;
  }
  const basis = hadPhoto ? "the photos" : "what you described";
  return `Price may change if the actual issue is different from ${basis} — want me to get this booked in?`;
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
  // The third parameter exists for exactly one caller — the opt-out
  // confirmation send in this file (see handleOptOutConfirmation below) —
  // which must reach a number the instant it transitions to opted-out.
  // Every other caller must omit it / pass false so the normal opt-out
  // enforcement (inside sendWhatsAppMessage/sendWhatsAppMessageMeta, the
  // actual HTTP-call layer) applies.
  sendMessage: (to: string, body: string, allowWhileOptedOut?: boolean) => Promise<void>;
  fetchMedia: (ref: string) => Promise<{ base64: string; mediaType: string }>;
};

// P2: the explicit state machine for routing an inbound message against an
// existing lead — confidence stays null for three genuinely different
// states (actively clarifying, resolved out-of-scope, failed AI
// finalization), and this makes the distinction a single, testable
// decision instead of scattered inline conditions. See
// handleInboundWhatsAppMessage's use of this below for what each outcome
// actually does.
//
// Any flagged lead (regardless of flag_type) with no confidence set is a
// resolved/terminal state, not active clarification — routed to
// fresh_quote uniformly. Live-tested finding: an EARLIER design gave
// needs_human_review its own permanently-sticky "sent to review" reply for
// every future message from that phone, for the rest of the 48-hour
// window — including a completely different, legitimate new request. The
// one-time recovery message still fires immediately when the failure
// happens (see the catch block that sets this flag); this only governs
// what a LATER message gets, and that must never be permanently blocked.
// The flag itself is unchanged and still drives the owner's dashboard
// "needs review" view — this only affects customer-facing routing.
export type LeadRouteDecision =
  | "fresh_quote" // no open lead, or one resolved/flagged for any reason — start clean
  | "continue_clarification" // genuinely still mid-clarification
  | "quoted_follow_up"; // already has a real quote (confidence set) — includes pending_negotiated_price

export function decideLeadRoute(
  openLead: { confidence: string | null; flag_type: string | null } | null | undefined,
): LeadRouteDecision {
  if (!openLead) return "fresh_quote";
  // Order matters: pending_negotiated_price also has a non-null flag_type,
  // but always has a real confidence value too (finalizeLeadWithQuote
  // always sets one) — checking confidence first keeps its verified
  // reopen/follow-up path completely unaffected by the flag_type check
  // below, which exists only to catch the flag_type + null-confidence
  // combination (outside_service_scope, needs_human_review, or any other
  // reason) that createFlaggedLead/finalizeLeadAsOutOfScope/the failure
  // handler below actually produce. P2 mixed-pricing's partially_priced
  // also always has a real confidence value (same finalizeLeadWithQuote
  // path) — it needs zero changes here, already correctly falls into
  // quoted_follow_up, same as pending_negotiated_price does.
  if (openLead.confidence !== null) return "quoted_follow_up";
  if (openLead.flag_type != null) return "fresh_quote";
  return "continue_clarification";
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
  // Twilio's MessageSid or Meta's wamid, where the channel supplies one —
  // recorded as evidence (see evaluateInboundInteraction) and used for the
  // "exact duplicate content, different id" signal. Never required: a
  // channel/caller that can't supply one still works, just without that
  // specific signal's benefit for this message.
  providerMessageId: string | undefined;
  profileName: string | undefined;
  channel: "WhatsApp";
  adapter: ChannelAdapter;
}): Promise<void> {
  const { tenant, fromPhone, body, mediaRef, providerMessageId, profileName, channel, adapter } =
    params;
  const admin = getAdminClient();

  // Opt-out/opt-in state — checked BEFORE the loop guard, since an
  // opted-out customer gets no automated reply regardless of what the
  // loop guard's own evidence would otherwise allow, and a control
  // message (STOP/START) is never ordinary conversation worth recording
  // as loop-guard evidence in the first place.
  const optOutState = await handleOptOutState({ admin, tenant, fromPhone, body, adapter });
  if (optOutState.stop) return;

  // Captured BEFORE evaluateInboundInteraction records this message's own
  // event below — see hasPriorInboundInteraction's own comment for why
  // this can't be derived from lead existence alone (the pre-lead
  // thin-description greeting path never creates one, so several short
  // messages in a row would otherwise all look like a first contact).
  // Read failures fail safe toward "assume prior contact" (false), the
  // same direction as every other fail-safe default in this file that
  // would otherwise risk an extra, unwanted greeting rather than a missing
  // one — the opposite of the loop guard's own fail-closed posture below,
  // which is protecting against unbounded automated cost, not a cosmetic
  // repeat.
  let hadPriorInboundInteraction = true;
  try {
    hadPriorInboundInteraction = await hasPriorInboundInteraction(admin, tenant.id, fromPhone);
  } catch (err) {
    console.error(
      `Could not check prior WhatsApp interactions for tenant ${tenant.id}, phone ${fromPhone} (assuming prior contact, no extra greeting risked):`,
      err,
    );
  }

  // Every inbound message is recorded as evidence AND evaluated in one
  // atomic call — this is both the "is this phone already paused" fast
  // path and the duplicate-content/volume detection step; neither AI nor
  // routing logic runs below this until the evaluation comes back clear.
  // A guard-read/write failure fails CLOSED (treated as tripped), same
  // reasoning as sendGuardedReply below.
  let inboundEvaluation: LoopGuardEvaluation;
  try {
    inboundEvaluation = await evaluateInboundInteraction(admin, tenant.id, fromPhone, {
      body,
      mediaRef,
      providerMessageId,
      leadId: null,
    });
  } catch (err) {
    console.error(
      `WhatsApp loop guard pre-check failed for tenant ${tenant.id}, phone ${fromPhone} — failing closed (no automated reply):`,
      err,
    );
    inboundEvaluation = {
      tripped: true,
      justTripped: false,
      tripReason: null,
      isDuplicateContent: false,
      duplicateContentCount: 0,
      repeatCount: 0,
      recentEventCount: 0,
    };
  }
  if (inboundEvaluation.tripped) {
    await handleLoopGuardPause({ admin, tenant, fromPhone, adapter, leadId: null });
    return;
  }

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
  // and why confidence alone was never enough to distinguish them. A
  // flagged lead (needs_human_review, outside_service_scope, or any other
  // reason) routes to fresh_quote below — the one-time recovery message
  // for a failure fires directly in the catch block that sets the flag,
  // not here; a later message always gets a genuine fresh attempt.
  const route = decideLeadRoute(openLead);

  // confidence is only ever set once a real quote exists (createLead and
  // finalizeLeadWithQuote both require it; createClarifyingLead deliberately
  // omits it) — so NULL here means this lead is still mid-clarification, not
  // yet quoted. Continue the AI conversation instead of treating this as a
  // human follow-up reply.
  if (route === "continue_clarification" && openLead) {
    await admin.from("lead_messages").insert({ lead_id: openLead.id, role: "customer", body });

    const claimed = await withLeadProcessingClaim(admin, tenant.id, fromPhone, async () => {
      // Computed once per round and reused for every customer-facing string
      // this branch builds itself (the AI's own diagnosis/questions/options
      // are already localized independently, per getQuoteEstimate's own
      // prompt instruction) — keeps every reply in one conversation turn in
      // the same language, rather than redetecting (and risking a
      // different outcome) per message.
      const language = detectLanguage(openLead.problem, body);

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
          "id, task, category, keywords, pricing_type, price_min, price_max, hours, bundleable, materials_policy, diagnosis_pricing_type, diagnosis_fee, ai_notes",
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
        diagnosisFee: row.diagnosis_pricing_type
          ? { pricingType: row.diagnosis_pricing_type, amount: row.diagnosis_fee }
          : null,
        aiNotes: row.ai_notes,
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
          const lostPhotoMessage = localizedLostPhotoMessage(language);
          await sendGuardedReply({
            admin,
            tenant,
            fromPhone,
            adapter,
            leadId: openLead.id,
            signature: { kind: "text", text: lostPhotoMessage },
            messageText: lostPhotoMessage,
          });
          return;
        }
      }

      let clarifyResult;
      try {
        clarifyResult = await getQuoteEstimate({
          data: {
            tenantSlug: tenant.slug,
            businessName: tenant.name,
            laborRate: tenant.laborRate,
            serviceCallFee: tenant.serviceCallFee,
            serviceCallFeeMode: tenant.serviceCallFeeMode,
            priceSheet: clarifyPriceSheet,
            description: openLead.problem,
            ...(clarifyImageBase64 !== undefined ? { imageBase64: clarifyImageBase64 } : {}),
            ...(clarifyImageMediaType !== undefined
              ? { imageMediaType: clarifyImageMediaType }
              : {}),
            answers,
          },
        });
      } catch (err) {
        if (err instanceof Error && err.message === UNSUPPORTED_IMAGE_MESSAGE) {
          const unsupportedImageMessage = localizedUnsupportedImageMessage(language);
          await sendGuardedReply({
            admin,
            tenant,
            fromPhone,
            adapter,
            leadId: openLead.id,
            signature: { kind: "text", text: unsupportedImageMessage },
            messageText: unsupportedImageMessage,
          });
          return;
        }
        // P2: getQuoteEstimate exhausted its retry (e.g. a validation/wording
        // failure it couldn't self-correct) partway through an existing
        // conversation — re-throwing here left the lead at confidence: null
        // forever, so every future message from this phone re-entered this
        // exact same clarification round for the rest of the 48-hour window,
        // live-confirmed as an actual defect. Mark it terminal instead: the
        // conversation and its history are preserved, and decideLeadRoute
        // sends the NEXT message from this phone to fresh_quote (not back
        // into clarification) — this message is only the one-time
        // acknowledgment of this specific failure.
        console.error(
          `WhatsApp clarification finalize failed for lead ${openLead.id}, marking needs_human_review:`,
          err,
        );
        await admin
          .from("leads")
          .update({
            status: "flagged",
            flag_type: "needs_human_review",
            flag_reason: "AI couldn't finalize this quote automatically after clarification.",
          })
          .eq("id", openLead.id);
        // Deliberately not "sent to the team for review" — reads like an
        // escalation/complaint. Softer framing, and explicitly invites a new
        // request in the same breath (the next message gets a genuine fresh
        // attempt either way, per decideLeadRoute — this just tells the
        // customer that's an option instead of leaving it implicit).
        const recoveryMessage = localizedRecoveryMessage(language);
        await sendGuardedReply({
          admin,
          tenant,
          fromPhone,
          adapter,
          leadId: openLead.id,
          signature: { kind: "text", text: recoveryMessage },
          messageText: recoveryMessage,
          onSent: async () => {
            await admin
              .from("lead_messages")
              .insert({ lead_id: openLead.id, role: "assistant", body: recoveryMessage });
          },
        });
        return;
      }

      if (clarifyResult.needsClarification) {
        const question = clarifyResult.questions[0];
        const optionsText = question?.options?.length ? `\n(${question.options.join(" / ")})` : "";
        const questionText = `${question?.question ?? localizedClarifyingFallbackQuestion(language)}${optionsText}`;
        await sendGuardedReply({
          admin,
          tenant,
          fromPhone,
          adapter,
          leadId: openLead.id,
          signature: { kind: "text", text: questionText },
          messageText: questionText,
          onSent: async () => {
            await admin
              .from("lead_messages")
              .insert({ lead_id: openLead.id, role: "assistant", body: questionText });
          },
        });
        return;
      }

      if (clarifyResult.outOfScope) {
        const acknowledgmentPrefix = clarifyResult.acknowledgment ? `${clarifyResult.acknowledgment} ` : "";
        const passAlongMessage = `${acknowledgmentPrefix}${localizedPassAlongMessage(language)}`;
        // Flag update and owner notification happen regardless of guard
        // state — if automation is paused, the owner needs to know even
        // more, not less, so they can follow up manually. Only the
        // customer-facing pass-along message itself is subject to the guard.
        await admin
          .from("leads")
          .update({
            status: "flagged",
            flag_type: "outside_service_scope",
            flag_reason: `Nothing on the price sheet covers: ${openLead.problem}`,
          })
          .eq("id", openLead.id);
        await sendGuardedReply({
          admin,
          tenant,
          fromPhone,
          adapter,
          leadId: openLead.id,
          signature: { kind: "text", text: passAlongMessage },
          messageText: passAlongMessage,
          onSent: async () => {
            await admin
              .from("lead_messages")
              .insert({ lead_id: openLead.id, role: "assistant", body: passAlongMessage });
          },
        });
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
        priceSheetItemId: item.priceSheetItemId ?? null,
        hours: item.hours,
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
          hasPartiallyDeferredWork: clarifyResult.hasPartiallyDeferredWork,
        },
      });

      // The lead itself is finalized above regardless — only the WhatsApp
      // notification of it is subject to the loop guard.
      await sendGuardedReply({
        admin,
        tenant,
        fromPhone,
        adapter,
        leadId: openLead.id,
        signature: {
          kind: "priced",
          priceSheetItemIds: clarifyResult.lineItems.map((item) => item.priceSheetItemId),
          amounts: [...clarifyResult.lineItems.map((item) => item.amount), clarifyResult.totalLow],
        },
        messageText: `${clarifyResult.diagnosis} ${formatQuotePriceLine(clarifyResult.totalLow, tenant.currency, clarifyResult.isDiagnosisOnly, clarifyResult.hasNoPricedWork, clarifyResult.hasPartiallyDeferredWork, language)} ${localizedEstimateBasisClosing(language, clarifyImageBase64 !== undefined)}`,
      });

      return;
    });
    if (!claimed) {
      console.error(
        `Could not claim lead slot for tenant ${tenant.id}, phone ${fromPhone} while mid-clarification — another message is already being processed for this lead; skipping automated reply for this round.`,
      );
      // Losing the claim must not also silently drop the owner's
      // visibility into this message — the lead-slot claim is only
      // meant to prevent duplicate AI/finalize processing, not to decide
      // whether the owner gets told anything. The AI call itself never
      // ran here, though, so this round's actual classification (needs
      // clarification? out of scope? a real quote?) was never
      // determined — neither the outside_service_scope flag nor its
      // specific "[Outside price sheet]" wording can be honestly applied
      // without that classification. Flagging needs_human_review instead
      // (the exact same guarded, never-overwrite-an-existing-flag pattern
      // handleLoopGuardPause already uses for the loop guard) still makes
      // sure a human sees this lead needs attention, without asserting a
      // classification this code never actually made.
      await admin
        .from("leads")
        .update({
          status: "flagged",
          flag_type: "needs_human_review",
          flag_reason:
            "A message arrived while another was already being processed for this conversation.",
        })
        .eq("id", openLead.id)
        .is("flag_type", null);
      void sendFollowUpNotificationEmail({
        tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
        customerName: openLead.customer_name || profileName || "A customer",
        body: `[Received while another message was being processed for this conversation] ${body}`,
      });
    }
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

    // Photo-intelligence Priority 2 (2026-10-19): a photo attached here used
    // to be treated unconditionally as proof of a new job, skipping straight
    // to the fresh-quote flow — never as additional evidence for the job
    // already quoted. Replaced with a real classification using the photo
    // itself plus the prior job's own context, rather than assuming either
    // way from photo-presence alone. See handleQuotedFollowUpPhoto below.
    if (mediaRef) {
      const handled = await handleQuotedFollowUpPhoto({
        tenant,
        fromPhone,
        body,
        mediaRef,
        profileName,
        channel,
        adapter,
        admin,
        openLead,
      });
      if (handled) return;
      // Classified as a different job (or the photo itself didn't load/
      // validate, already handled with its own user-facing message and an
      // early return inside handleQuotedFollowUpPhoto — reaching here means
      // specifically "different job") — falls through to the fresh-quote
      // flow below, exactly like today's behavior for that case.
    } else {
      const { classification } = await classifyFollowUpIntent({
        data: {
          priorProblem: openLead.problem,
          priorDiagnosis: openLead.diagnosis || "",
          customerReply: body,
        },
      });

      // Genuinely unclear whether this continues the open job or starts a
      // new one — ask rather than guess. This is the fix for a confirmed
      // production bug: a message about a completely different job
      // ("check for water heater" on an open kitchen-faucet lead) used to
      // have no third option and got forced into "same job," so
      // getFollowUpAnswer answered using the old diagnosis and $120
      // estimate — a reply mis-attributed to the wrong job entirely.
      // Mirrors handleQuotedFollowUpPhoto's identical "ambiguous" branch
      // for the photo path. No lead is created, nothing is priced, and the
      // old job's diagnosis/line items are never referenced in the reply.
      if (classification === "ambiguous") {
        const language = detectLanguage(openLead.problem, body);
        const disambiguationQuestion = localizedTextDisambiguationQuestion(language);
        await sendGuardedReply({
          admin,
          tenant,
          fromPhone,
          adapter,
          leadId: openLead.id,
          signature: { kind: "text", text: disambiguationQuestion },
          messageText: disambiguationQuestion,
          onSent: async () => {
            await admin
              .from("lead_messages")
              .insert({ lead_id: openLead.id, role: "assistant", body: disambiguationQuestion });
          },
        });
        void sendFollowUpNotificationEmail({
          tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
          customerName: openLead.customer_name || profileName || "A customer",
          body,
        });
        return;
      }

      if (classification === "same_job") {
        const claimedFollowUp = await withLeadProcessingClaim(
          admin,
          tenant.id,
          fromPhone,
          async () => {
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
                tenantSlug: tenant.slug,
                businessName: tenant.name,
                diagnosis: openLead.diagnosis || "",
                lineItems: lineItemsForAnswer,
                question: body,
                history,
                // P1-B: broadened from the flag alone — a lead reviewed/dismissed
                // without a price ever being added has the identical "nothing to
                // state a number for" problem, and lineItemRows is already fetched
                // above for this exact branch.
                hasNoPricedWork:
                  openLead.flag_type === "pending_negotiated_price" ||
                  (lineItemRows ?? []).length === 0,
                // P2 mixed-pricing: this lead's real, priced lineItemRows are
                // only part of what was originally described — another issue is
                // still deferred, so a "how much total?" follow-up must not
                // treat the listed items as the complete picture.
                hasPartiallyDeferredWork: openLead.flag_type === "partially_priced",
              },
            });

            // lead_line_items has no priceSheetItemId column (a real,
            // pre-existing schema limitation, not introduced here) — item
            // descriptions stand in as the identity key for this specific
            // site's signature, a stated precision reduction. Dollar amounts
            // actually stated in the answer text are extracted directly
            // (getFollowUpAnswer already validates every "$" figure traces to
            // a real known amount — see its own allowedAmounts invariant),
            // which is what mainly differentiates "still $194?" from
            // "can you come at 3pm?" for the same already-quoted job, since
            // the latter typically states no dollar figure at all.
            const mentionedAmounts = [...answer.matchAll(/\$([\d,]+(?:\.\d{2})?)/g)].map((m) =>
              Number(m[1]!.replace(/,/g, "")),
            );
            await sendGuardedReply({
              admin,
              tenant,
              fromPhone,
              adapter,
              leadId: openLead.id,
              signature: {
                kind: "priced",
                priceSheetItemIds: lineItemsForAnswer.map((item) => item.description),
                amounts: mentionedAmounts,
              },
              messageText: answer,
              onSent: async () => {
                await admin
                  .from("lead_messages")
                  .insert({ lead_id: openLead.id, role: "assistant", body: answer });
              },
            });
          },
        );
        if (!claimedFollowUp) {
          console.error(
            `Could not claim lead slot for tenant ${tenant.id}, phone ${fromPhone} for a same-job follow-up — another message is already being processed for this lead; skipping automated reply for this round.`,
          );
        }
        // Owner notification fires regardless of guard state AND
        // regardless of the lead-slot claim outcome — unlike the
        // out-of-scope flag/notification in the clarification branch
        // above, this one was never dependent on any AI classification
        // (it just reports the customer's own message text), so there is
        // no reason a lost claim should suppress it too. Moved outside
        // the claimed callback so it still fires exactly once even when
        // claimedFollowUp is false; the single unconditional `return`
        // right after means this can never run twice for the same
        // message.
        void sendFollowUpNotificationEmail({
          tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
          customerName: openLead.customer_name || profileName || "A customer",
          body,
        });
        return;
      }
      // classification === "different_job", no photo attached — falls
      // through to the fresh-quote flow below (fresh getQuoteEstimate call,
      // no reference to the prior lead's diagnosis/line items/estimate),
      // which will correctly ask for a photo since none has actually been
      // provided yet.
    }
    void sendFollowUpNotificationEmail({
      tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
      customerName: openLead.customer_name || profileName || "A customer",
      body,
    });
    // Falls through to the fresh-quote flow below — a photo classified as a
    // genuinely different job, or a text-only reply classified the same way.
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
  // Combines two signals, both scoped to the same 48-hour conversation
  // window: no open lead (the signal decideLeadRoute is built around —
  // still needed, since a flagged lead within the window correctly
  // suppresses re-greeting too), AND no prior inbound interaction event
  // recorded for this phone at all (closes the real gap lead-existence
  // alone misses — see hasPriorInboundInteraction's own comment: the
  // thin-description short-circuit below never creates a lead, so several
  // short messages in a row would otherwise each look like a first
  // contact). No activity in that window means a genuinely new
  // conversation, even if this same phone has contacted this tenant before
  // (e.g. weeks ago, well outside the window). Computed once here and
  // threaded into handleFreshQuote below so both the thin-description
  // short-circuit and the full quote/clarification paths agree on one
  // answer.
  const isFirstContact = openLead == null && !hadPriorInboundInteraction;

  const hasSubstantialDescription = body.trim().length > 10;
  if (!mediaRef && !hasSubstantialDescription) {
    // No lead exists yet at this point — leadId: null. This is exactly the
    // path a prior review found entirely unguarded and entirely
    // unrecorded (nothing was ever inserted into lead_messages here
    // either, so even the volume signal had nothing to count). The
    // evidence log is keyed on (tenant, phone), not on a lead, so this
    // now records and evaluates correctly even before any lead exists.
    const thinDescriptionLanguage = detectLanguage(body);
    await sendGuardedReply({
      admin,
      tenant,
      fromPhone,
      adapter,
      leadId: null,
      signature: { kind: "text", text: "canned:thin-description-greeting" },
      messageText: `${isFirstContact ? localizedFirstContactGreeting(thinDescriptionLanguage) : ""}${localizedGreeting(thinDescriptionLanguage, tenant.name)}`,
    });
    return;
  }

  // Duplicate-lead race guard (see claimLeadSlot's own comment above): every
  // path from here on creates a brand-new lead, so the claim covers the
  // whole block, released in `finally` regardless of which branch returns.
  const claimed = await claimLeadSlot(admin, tenant.id, fromPhone);
  if (!claimed) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(750);
      const existingId = await findRecentLeadId(admin, tenant.id, fromPhone);
      if (existingId) {
        await admin.from("lead_messages").insert({ lead_id: existingId, role: "customer", body });
        return;
      }
    }
    // Nothing appeared within the bound (the other request is taking
    // unusually long) — proceed without the claim rather than block this
    // customer's message indefinitely. No worse than before this fix.
  }
  try {
    await handleFreshQuote({
      tenant,
      fromPhone,
      body,
      mediaRef,
      profileName,
      channel,
      adapter,
      admin,
      isFirstContact,
    });
  } finally {
    if (claimed) await releaseLeadSlot(admin, tenant.id, fromPhone);
  }
}

// Photo-intelligence Priority 2 (2026-10-19). Handles a photo attached to
// an already-quoted lead's follow-up message — classifies it as additional
// evidence for the SAME job, a genuinely DIFFERENT job, or too AMBIGUOUS to
// tell, using the photo itself plus the prior job's own context, rather
// than assuming either way from photo-presence alone (the prior, now-
// replaced behavior always assumed "new job"). Returns true when this
// function fully handled the message — same job reassessed, an ambiguous
// clarifying question sent, or a photo-load/format error already replied
// to — the caller must not fall through to the fresh-quote flow in any of
// those cases. Returns false only for "different job," where the caller's
// existing fresh-quote fallthrough is exactly the right, unchanged
// behavior.
async function handleQuotedFollowUpPhoto(params: {
  tenant: InboundWhatsAppTenant;
  fromPhone: string;
  body: string;
  mediaRef: string;
  profileName: string | undefined;
  channel: "WhatsApp";
  adapter: ChannelAdapter;
  admin: ReturnType<typeof getAdminClient>;
  openLead: {
    id: string;
    customer_name: string | null;
    photo_url: string | null;
    problem: string;
    confidence: string | null;
    diagnosis: string | null;
    flag_type: string | null;
  };
}): Promise<boolean> {
  const { tenant, fromPhone, body, mediaRef, profileName, adapter, admin, openLead } = params;
  // Computed once and reused for every customer-facing string this
  // function builds itself — see the continue_clarification branch above
  // for the same reasoning (the AI's own diagnosis/classification text is
  // already localized independently). Deliberately customer-authored text
  // ONLY (problem + this round's reply) — openLead.diagnosis is AI-
  // generated, not something the customer wrote, and including it here
  // would let a stored diagnosis in one language silently override a
  // reliable signal from the customer's own words in the other. Found
  // during review (2026-10-19): the original version of this line included
  // openLead.diagnosis, which meant a lead whose diagnosis happened to
  // read differently than the customer's own problem/reply text could
  // flip the detected language out from under them.
  const language = detectLanguage(openLead.problem, body);

  let imageBase64: string;
  let imageMediaType: string;
  try {
    const media = await adapter.fetchMedia(mediaRef);
    imageBase64 = media.base64;
    imageMediaType = media.mediaType;
  } catch (err) {
    console.error(
      `Could not download WhatsApp photo for follow-up classification, lead ${openLead.id}:`,
      err,
    );
    const photoLoadFailedMessage = localizedPhotoLoadFailedMessage(language);
    await sendGuardedReply({
      admin,
      tenant,
      fromPhone,
      adapter,
      leadId: openLead.id,
      signature: { kind: "text", text: photoLoadFailedMessage },
      messageText: photoLoadFailedMessage,
    });
    return true;
  }

  if (!isSupportedImageBase64(imageBase64)) {
    const unsupportedImageMessage = localizedUnsupportedImageMessage(language);
    await sendGuardedReply({
      admin,
      tenant,
      fromPhone,
      adapter,
      leadId: openLead.id,
      signature: { kind: "text", text: unsupportedImageMessage },
      messageText: unsupportedImageMessage,
    });
    return true;
  }

  const { classification } = await classifyFollowUpPhotoIntent({
    data: {
      priorProblem: openLead.problem,
      priorDiagnosis: openLead.diagnosis || "",
      customerReply: body,
      imageBase64,
      imageMediaType,
    },
  });

  if (classification === "different_job") {
    return false;
  }

  if (classification === "ambiguous") {
    const disambiguationQuestion = localizedPhotoDisambiguationQuestion(language);
    await sendGuardedReply({
      admin,
      tenant,
      fromPhone,
      adapter,
      leadId: openLead.id,
      signature: { kind: "text", text: disambiguationQuestion },
      messageText: disambiguationQuestion,
      onSent: async () => {
        await admin
          .from("lead_messages")
          .insert({ lead_id: openLead.id, role: "assistant", body: disambiguationQuestion });
      },
    });
    void sendFollowUpNotificationEmail({
      tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
      customerName: openLead.customer_name || profileName || "A customer",
      body,
    });
    return true;
  }

  // classification === "same_job": reassess using the original problem plus
  // this new photo, compare against what was already quoted, and only ever
  // tell the customer something changed if it genuinely did.
  const claimedReassessment = await withLeadProcessingClaim(
    admin,
    tenant.id,
    fromPhone,
    async () => {
      const { data: priceSheetRows } = await admin
        .from("price_sheet_items")
        .select(
          "id, task, category, keywords, pricing_type, price_min, price_max, hours, bundleable, materials_policy, diagnosis_pricing_type, diagnosis_fee, ai_notes",
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
        diagnosisFee: row.diagnosis_pricing_type
          ? { pricingType: row.diagnosis_pricing_type, amount: row.diagnosis_fee }
          : null,
        aiNotes: row.ai_notes,
      }));

      const { data: lineItemRows } = await admin
        .from("lead_line_items")
        .select("description, rate, qty")
        .eq("lead_id", openLead.id);
      const existingLineItems = (lineItemRows ?? []).map((row) => ({
        description: row.description,
        amount: lineItemAmount(row),
      }));
      const existingTotal = existingLineItems.reduce((sum, i) => sum + i.amount, 0);
      const existingHasNoPricedWork =
        openLead.flag_type === "pending_negotiated_price" || existingLineItems.length === 0;
      const existingHasPartiallyDeferredWork = openLead.flag_type === "partially_priced";

      const updatedDescription = body
        ? `${openLead.problem}\n\nAdditional note from customer with this new photo: ${body}`
        : openLead.problem;

      let reassessed;
      try {
        reassessed = await getQuoteEstimate({
          data: {
            tenantSlug: tenant.slug,
            businessName: tenant.name,
            laborRate: tenant.laborRate,
            serviceCallFee: tenant.serviceCallFee,
            serviceCallFeeMode: tenant.serviceCallFeeMode,
            priceSheet,
            description: updatedDescription || NO_DESCRIPTION_PLACEHOLDER,
            imageBase64,
            imageMediaType,
          },
        });
      } catch (err) {
        console.error(`Reassessment failed for lead ${openLead.id}:`, err);
        const reassessFailedMessage = localizedReassessFailedMessage(language);
        await sendGuardedReply({
          admin,
          tenant,
          fromPhone,
          adapter,
          leadId: openLead.id,
          signature: { kind: "text", text: reassessFailedMessage },
          messageText: reassessFailedMessage,
        });
        return;
      }

      // Sequential, not combined — TypeScript can only narrow QuoteResult's
      // discriminated union one member at a time (see getQuoteEstimate's own
      // callers elsewhere in this file for the same pattern). Both lead to
      // the same fallback here: couldn't confidently reassess even with the
      // photo in hand, so ask rather than silently guess, change nothing, and
      // never duplicate the lead.
      const askToConfirmMessage = localizedAskToConfirmMessage(language);
      if (reassessed.needsClarification) {
        await sendGuardedReply({
          admin,
          tenant,
          fromPhone,
          adapter,
          leadId: openLead.id,
          signature: { kind: "text", text: askToConfirmMessage },
          messageText: askToConfirmMessage,
          onSent: async () => {
            await admin
              .from("lead_messages")
              .insert({ lead_id: openLead.id, role: "assistant", body: askToConfirmMessage });
          },
        });
        return;
      }
      if (reassessed.outOfScope) {
        await sendGuardedReply({
          admin,
          tenant,
          fromPhone,
          adapter,
          leadId: openLead.id,
          signature: { kind: "text", text: askToConfirmMessage },
          messageText: askToConfirmMessage,
          onSent: async () => {
            await admin
              .from("lead_messages")
              .insert({ lead_id: openLead.id, role: "assistant", body: askToConfirmMessage });
          },
        });
        return;
      }

      const newTotal = reassessed.totalLow;

      // lead_line_items has no priceSheetItemId column (same pre-existing
      // schema limitation noted elsewhere in this file) — {description,
      // amount} is the same identity key already used for that reason.
      const existingKey = new Set(
        existingLineItems.map((i) => `${i.description}::${i.amount.toFixed(2)}`),
      );
      const newKey = new Set(
        reassessed.lineItems.map((i) => `${i.description}::${i.amount.toFixed(2)}`),
      );
      const sameComposition =
        existingKey.size === newKey.size && [...newKey].every((k) => existingKey.has(k));
      const materiallyChanged =
        Math.abs(existingTotal - newTotal) >= 0.01 ||
        !sameComposition ||
        existingHasNoPricedWork !== reassessed.hasNoPricedWork ||
        existingHasPartiallyDeferredWork !== reassessed.hasPartiallyDeferredWork;

      if (!materiallyChanged) {
        // Silently keep the existing quote as-is — no unnecessary
        // confirmation message, per the explicit requirement.
        return;
      }

      // Re-enabled 2026-10-19 (0028_fix_lead_reassessment_atomicity.sql):
      // update_lead_with_line_items now replaces (not appends) an existing
      // lead's line items atomically, and genuinely clears a stale pricing
      // flag while still protecting any unrelated operational flag — both
      // proven against a real disposable Postgres instance, 35/35 checks,
      // see scripts/pg-lead-reassessment-check.sh. This was previously
      // disabled (flagging for manual review instead) pending exactly this
      // fix — see SECURITY_REMEDIATION_TRACKER.md for the full incident.
      const newLineItems = reassessed.lineItems.map((item) => ({
        description: item.detail ? `${item.description} — ${item.detail}` : item.description,
        qty: 1,
        unit: "job",
        rate: item.amount,
        priceSheetItemId: item.priceSheetItemId ?? null,
        hours: item.hours,
      }));

      await finalizeLeadWithQuote({
        data: {
          leadId: openLead.id,
          tenantSlug: tenant.slug,
          customerName: openLead.customer_name || profileName || "WhatsApp customer",
          phone: fromPhone,
          channel: "WhatsApp",
          problem: openLead.problem,
          diagnosis: reassessed.diagnosis,
          confidence: reassessed.confidence,
          isEmergency: reassessed.isEmergency,
          lineItems: newLineItems,
          pendingNegotiatedPrice: reassessed.hasNoPricedWork,
          hasPartiallyDeferredWork: reassessed.hasPartiallyDeferredWork,
        },
      });

      // No "(previously $X)" note when nothing was priced before at all —
      // there's no real prior figure to cite, and stating "$0.00" would read
      // as a fabricated number rather than "nothing was priced yet."
      const previousPriceNote = existingHasNoPricedWork
        ? ""
        : localizedPreviousPriceNote(language, money(existingTotal, tenant.currency));
      const updateMessage = `${localizedPhotoUpdateIntro(language)} ${reassessed.diagnosis} ${formatQuotePriceLine(newTotal, tenant.currency, reassessed.isDiagnosisOnly, reassessed.hasNoPricedWork, reassessed.hasPartiallyDeferredWork, language)}${previousPriceNote}`;
      await sendGuardedReply({
        admin,
        tenant,
        fromPhone,
        adapter,
        leadId: openLead.id,
        signature: {
          kind: "priced",
          priceSheetItemIds: reassessed.lineItems.map((item) => item.priceSheetItemId),
          amounts: [...reassessed.lineItems.map((item) => item.amount), newTotal],
        },
        messageText: updateMessage,
        onSent: async () => {
          await admin
            .from("lead_messages")
            .insert({ lead_id: openLead.id, role: "assistant", body: updateMessage });
        },
      });
    },
  );

  if (!claimedReassessment) {
    console.error(
      `Could not claim lead slot for tenant ${tenant.id}, phone ${fromPhone} for a photo-based reassessment — another message is already being processed for this lead; skipping automated reply for this round.`,
    );
  }
  void sendFollowUpNotificationEmail({
    tenant: { name: tenant.name, email: tenant.email, currency: tenant.currency },
    customerName: openLead.customer_name || profileName || "A customer",
    body,
  });
  return true;
}

async function handleFreshQuote(params: {
  tenant: InboundWhatsAppTenant;
  fromPhone: string;
  body: string;
  mediaRef: string | undefined;
  profileName: string | undefined;
  channel: "WhatsApp";
  adapter: ChannelAdapter;
  admin: ReturnType<typeof getAdminClient>;
  // Computed once by the caller (shared with the thin-description
  // short-circuit above it) as openLead == null — the same 48-hour,
  // phone+tenant-scoped lookup decideLeadRoute uses, not derived from
  // whether a lead is being newly created here.
  isFirstContact: boolean;
}): Promise<void> {
  const { tenant, fromPhone, body, mediaRef, profileName, channel, adapter, admin, isFirstContact } = params;
  // No prior lead/diagnosis exists yet at this point — body is the only
  // signal available, same reasoning as the thin-description greeting
  // above.
  const language = detectLanguage(body);
  const firstContactGreeting = isFirstContact ? localizedFirstContactGreeting(language) : "";

  const { data: priceSheetRows } = await admin
    .from("price_sheet_items")
    .select(
      "id, task, category, keywords, pricing_type, price_min, price_max, hours, bundleable, materials_policy, diagnosis_pricing_type, diagnosis_fee, ai_notes",
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
    diagnosisFee: row.diagnosis_pricing_type
      ? { pricingType: row.diagnosis_pricing_type, amount: row.diagnosis_fee }
      : null,
    aiNotes: row.ai_notes,
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
      const photoLoadFailedMessage = localizedPhotoLoadFailedMessage(language);
      await sendGuardedReply({
        admin,
        tenant,
        fromPhone,
        adapter,
        leadId: null,
        signature: { kind: "text", text: photoLoadFailedMessage },
        messageText: photoLoadFailedMessage,
      });
      return;
    }
  }

  let result;
  try {
    result = await getQuoteEstimate({
      data: {
        tenantSlug: tenant.slug,
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
      const unsupportedImageMessage = localizedUnsupportedImageMessage(language);
      await sendGuardedReply({
        admin,
        tenant,
        fromPhone,
        adapter,
        leadId: null,
        signature: { kind: "text", text: unsupportedImageMessage },
        messageText: unsupportedImageMessage,
      });
      return;
    }
    throw err;
  }

  if (result.needsClarification) {
    const question = result.questions[0];
    const optionsText = question?.options?.length ? `\n(${question.options.join(" / ")})` : "";
    const questionText = `${firstContactGreeting}${question?.question ?? localizedClarifyingFallbackQuestion(language)}${optionsText}`;

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
    await admin
      .from("lead_messages")
      .insert({ lead_id: leadId, role: "customer", body: openingProblem });

    await sendGuardedReply({
      admin,
      tenant,
      fromPhone,
      adapter,
      leadId,
      signature: { kind: "text", text: questionText },
      messageText: questionText,
      onSent: async () => {
        await admin
          .from("lead_messages")
          .insert({ lead_id: leadId, role: "assistant", body: questionText });
      },
    });
    return;
  }

  if (result.outOfScope) {
    const openingProblem = body || NO_DESCRIPTION_PLACEHOLDER;
    const acknowledgmentPrefix = result.acknowledgment ? `${result.acknowledgment} ` : "";
    const passAlongMessage = `${firstContactGreeting}${acknowledgmentPrefix}${localizedPassAlongMessage(language)}`;
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
    await admin
      .from("lead_messages")
      .insert({ lead_id: leadId, role: "customer", body: openingProblem });
    await sendGuardedReply({
      admin,
      tenant,
      fromPhone,
      adapter,
      leadId,
      signature: { kind: "text", text: passAlongMessage },
      messageText: passAlongMessage,
      onSent: async () => {
        await admin
          .from("lead_messages")
          .insert({ lead_id: leadId, role: "assistant", body: passAlongMessage });
      },
    });
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
    priceSheetItemId: item.priceSheetItemId ?? null,
    hours: item.hours,
  }));

  const { id: leadId } = await createLead({
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
      hasPartiallyDeferredWork: result.hasPartiallyDeferredWork,
    },
  });

  await sendGuardedReply({
    admin,
    tenant,
    fromPhone,
    adapter,
    leadId,
    signature: {
      kind: "priced",
      priceSheetItemIds: result.lineItems.map((item) => item.priceSheetItemId),
      amounts: [...result.lineItems.map((item) => item.amount), result.totalLow],
    },
    messageText: `${firstContactGreeting}${result.diagnosis} ${formatQuotePriceLine(result.totalLow, tenant.currency, result.isDiagnosisOnly, result.hasNoPricedWork, result.hasPartiallyDeferredWork, language)} ${localizedEstimateBasisClosing(language, imageBase64 !== undefined)}`,
  });
}
