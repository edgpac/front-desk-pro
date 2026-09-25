import { useRef, useState } from "react";
import { ImageIcon, Loader2, Plus, RefreshCw, Send, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import { fileToCompressedBase64, urlToCompressedBase64, isSupportedImageFile, UNSUPPORTED_IMAGE_MESSAGE } from "@/lib/image-client";
import {
  getFollowUpAnswer,
  getQuoteEstimate,
  SAMPLE_PRICE_SHEET,
  type Answer,
  type ClarifyingQuestion,
  type LineItem,
  type PriceSheetItem,
} from "@/lib/estimate-server";
import {
  createLead,
  createFlaggedLead,
  createClarifyingLead,
  finalizeLeadWithQuote,
  finalizeLeadAsOutOfScope,
  finalizeLeadAsNeedsReview,
  saveClarificationMessages,
} from "@/lib/public-lead-server";
import leakPhoto from "@/assets/leak-detail.jpg";
import panelPhoto from "@/assets/electrician-panel.jpg";
import sinkPhoto from "@/assets/plumber-under-sink.jpg";

type SamplePhoto = { id: string; img: string; label: string; problem: string };

const SAMPLE_PHOTOS: SamplePhoto[] = [
  {
    id: "heater",
    img: leakPhoto,
    label: "Leaking water heater",
    problem: "Water heater dripping at the bottom fitting, rust on the floor.",
  },
  {
    id: "panel",
    img: panelPhoto,
    label: "Breaker keeps tripping",
    problem: "Dryer trips the breaker every time it runs, panel looks old.",
  },
  {
    id: "sink",
    img: sinkPhoto,
    label: "Kitchen sink backing up",
    problem: "Sink drains slow and the pipe under the cabinet drips.",
  },
];

type Stage = "intake" | "loading" | "clarify" | "result" | "outOfScope" | "needsReview";

type ResultState = {
  isEmergency: boolean;
  issueType: string;
  severity: "Low" | "Medium" | "High";
  confidence: "High" | "Medium" | "Low";
  diagnosis: string;
  lineItems: LineItem[];
  totalLow: number;
  totalHigh: number;
  isDiagnosisOnly: boolean;
  hasNoPricedWork: boolean;
  hasPartiallyDeferredWork: boolean;
};

export function QuoteFlow({
  businessName,
  accent,
  bookingLink,
  compact = false,
  laborRate = 125,
  serviceCallFee = 60,
  serviceCallFeeMode = "fixed",
  currency = "USD",
  priceSheet = SAMPLE_PRICE_SHEET,
  tenantSlug,
  channel = "Quote link",
}: {
  businessName: string;
  accent?: string;
  bookingLink?: string;
  compact?: boolean;
  laborRate?: number;
  serviceCallFee?: number;
  serviceCallFeeMode?: "fixed" | "negotiated";
  currency?: string;
  priceSheet?: PriceSheetItem[];
  tenantSlug?: string;
  // Which intake surface this instance is running on — threaded straight
  // through to createLead/createFlaggedLead so a lead's origin (embedded
  // widget vs. the standalone /quote/:slug link) is recorded accurately
  // instead of every non-WhatsApp lead looking like it came from the link.
  channel?: "Quote link" | "Widget";
}) {
  const [stage, setStage] = useState<Stage>("intake");
  const [selectedSample, setSelectedSample] = useState<SamplePhoto | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [questions, setQuestions] = useState<ClarifyingQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [priorAnswers, setPriorAnswers] = useState<Answer[]>([]);
  const [result, setResult] = useState<ResultState | null>(null);
  const [thread, setThread] = useState<{ role: "customer" | "desk"; text: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [askingFollowUp, setAskingFollowUp] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [sendingLead, setSendingLead] = useState(false);
  const [leadSent, setLeadSent] = useState(false);
  // P1-D: set the moment a clarification round is first persisted (see
  // submitToAI below). Null means either no clarification has happened yet,
  // or this is a demo/no-tenant session (tenantSlug undefined) where nothing
  // is ever persisted. Once set, later rounds/finalization update this same
  // lead instead of creating new ones.
  const [clarifyingLeadId, setClarifyingLeadId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const accentStyle = accent ? { backgroundColor: accent, borderColor: accent } : undefined;

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    // Signature check, not filename/extension — rejects a real HEIC/HEIF
    // photo (the iPhone camera-roll default) before any compression,
    // upload, or Claude call is ever attempted for it.
    if (!(await isSupportedImageFile(f))) {
      toast.error(UNSUPPORTED_IMAGE_MESSAGE);
      return;
    }
    setUploadedFile(f);
    setSelectedSample(null);
    toast.success("Photo attached");
  }

  async function resolveImage(): Promise<{ base64?: string; mediaType?: string }> {
    if (uploadedFile) {
      const { base64, mediaType } = await fileToCompressedBase64(uploadedFile);
      return { base64, mediaType };
    }
    if (selectedSample) {
      const { base64, mediaType } = await urlToCompressedBase64(selectedSample.img);
      return { base64, mediaType };
    }
    return {};
  }

  // P1-D: persists this round's Q&A to lead_messages, creating the
  // clarifying lead on the very first round if one doesn't exist yet.
  // newAnswersThisRound is just the round that was JUST answered (empty on
  // the initial submission, which has nothing to answer yet) — kept
  // separate from the full accumulated answers passed to getQuoteEstimate
  // so this never re-persists earlier rounds. Never blocks the customer's
  // flow on a persistence failure: the in-memory clarification loop (via
  // priorAnswers/questions state) already works today regardless of this,
  // so a failure here is logged and swallowed, not surfaced as an error.
  async function persistClarificationRound(newAnswersThisRound: Answer[], nextQuestions: ClarifyingQuestion[]) {
    if (!tenantSlug) return; // demo/no-tenant session — nothing to persist to
    try {
      if (clarifyingLeadId === null) {
        // No clarification has ever happened for this request, and this
        // round resolved immediately (a final quote or out-of-scope on the
        // very first call) — nothing to persist here; sendQuoteToBusiness/
        // sendFlaggedRequest create the lead normally, exactly as before.
        if (nextQuestions.length === 0) return;
        const { id } = await createClarifyingLead({
          data: { tenantSlug, customerName: "", phone: "", channel, photoUrl: "", problem: description },
        });
        setClarifyingLeadId(id);
        await saveClarificationMessages({
          data: {
            leadId: id,
            messages: [
              { role: "customer", body: description },
              ...nextQuestions.map((q) => ({ role: "assistant" as const, body: q.question })),
            ],
          },
        });
      } else {
        await saveClarificationMessages({
          data: {
            leadId: clarifyingLeadId,
            messages: [
              ...newAnswersThisRound.map((a) => ({ role: "customer" as const, body: a.answer })),
              ...nextQuestions.map((q) => ({ role: "assistant" as const, body: q.question })),
            ],
          },
        });
      }
    } catch (err) {
      console.error("Could not persist clarification round:", err);
    }
  }

  async function submitToAI(answersForThisRound: Answer[], newAnswersThisRound: Answer[] = []) {
    setStage("loading");
    try {
      const { base64, mediaType } = await resolveImage();
      const outcome = await getQuoteEstimate({
        data: {
          businessName,
          laborRate,
          serviceCallFee,
          serviceCallFeeMode,
          priceSheet,
          description,
          imageBase64: base64,
          imageMediaType: mediaType,
          answers: answersForThisRound,
          tenantSlug,
        },
      });

      if (outcome.needsClarification) {
        await persistClarificationRound(newAnswersThisRound, outcome.questions);
        setQuestions(outcome.questions);
        setAnswers({});
        setStage("clarify");
        return;
      }

      if (outcome.outOfScope) {
        // The lead still resolves to "out of scope" as a final state — no
        // further questions — so persist the round's answers with no
        // follow-up questions, same helper, empty nextQuestions.
        await persistClarificationRound(newAnswersThisRound, []);
        setStage("outOfScope");
        return;
      }

      await persistClarificationRound(newAnswersThisRound, []);
      setResult(outcome);
      setStage("result");
    } catch (err) {
      // getQuoteEstimate exhausted its retry — never a dead-end error
      // screen, since the customer hasn't been asked for contact info yet
      // at this point and "the business will follow up manually" would be
      // false without it. needsReview collects it (same pattern as
      // outOfScope) and marks the lead for human review instead.
      console.error("Could not finalize this quote:", err);
      setStage("needsReview");
    }
  }

  function submitClarification() {
    const newAnswers: Answer[] = questions.map((q, i) => ({
      question: q.question,
      answer: answers[i] ?? "",
    }));
    const combined = [...priorAnswers, ...newAnswers];
    setPriorAnswers(combined);
    void submitToAI(combined, newAnswers);
  }

  async function ask() {
    if (!result || !draft.trim()) return;
    const question = draft;
    setThread((t) => [...t, { role: "customer", text: question }]);
    setDraft("");
    setAskingFollowUp(true);
    try {
      const answer = await getFollowUpAnswer({
        data: {
          businessName,
          diagnosis: result.diagnosis,
          lineItems: result.lineItems,
          question,
          history: thread,
          tenantSlug,
          hasNoPricedWork: result.hasNoPricedWork,
          hasPartiallyDeferredWork: result.hasPartiallyDeferredWork,
        },
      });
      setThread((t) => [...t, { role: "desk", text: answer }]);
    } catch {
      setThread((t) => [
        ...t,
        { role: "desk", text: "Sorry, couldn't get an answer just now — try again in a moment." },
      ]);
    } finally {
      setAskingFollowUp(false);
    }
  }

  function reset() {
    setStage("intake");
    setSelectedSample(null);
    setUploadedFile(null);
    setDescription("");
    setQuestions([]);
    setAnswers({});
    setPriorAnswers([]);
    setResult(null);
    setThread([]);
    setCustomerName("");
    setPhone("");
    setLeadSent(false);
    setClarifyingLeadId(null);
  }

  async function sendQuoteToBusiness() {
    if (!result || !tenantSlug) {
      toast.success("Quote texted to you");
      return;
    }
    if (!customerName.trim() || !phone.trim()) {
      toast.error("Add your name and phone so the business can reach you.");
      return;
    }
    setSendingLead(true);
    try {
      const lineItems = result.lineItems.map((item) => ({
        description: item.detail ? `${item.description} — ${item.detail}` : item.description,
        qty: 1,
        unit: "job",
        rate: item.amount,
      }));
      // P1-D: a clarifying lead already exists from an earlier round —
      // complete that same row instead of inserting a second one.
      if (clarifyingLeadId !== null) {
        await finalizeLeadWithQuote({
          data: {
            leadId: clarifyingLeadId,
            tenantSlug,
            customerName: customerName.trim(),
            phone: phone.trim(),
            channel,
            problem: description,
            diagnosis: result.diagnosis,
            confidence: result.confidence,
            isEmergency: result.isEmergency,
            pendingNegotiatedPrice: result.hasNoPricedWork,
            hasPartiallyDeferredWork: result.hasPartiallyDeferredWork,
            lineItems,
          },
        });
      } else {
        await createLead({
          data: {
            tenantSlug,
            customerName: customerName.trim(),
            phone: phone.trim(),
            address: "",
            channel,
            problem: description,
            diagnosis: result.diagnosis,
            confidence: result.confidence,
            isEmergency: result.isEmergency,
            pendingNegotiatedPrice: result.hasNoPricedWork,
            hasPartiallyDeferredWork: result.hasPartiallyDeferredWork,
            lineItems,
          },
        });
      }
      setLeadSent(true);
      toast.success("Sent — the business will reach out.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send that — try again.");
    } finally {
      setSendingLead(false);
    }
  }

  async function sendFlaggedRequest() {
    if (!tenantSlug) {
      toast.success("Request sent to the team");
      setLeadSent(true);
      return;
    }
    if (!customerName.trim() || !phone.trim()) {
      toast.error("Add your name and phone so the business can reach you.");
      return;
    }
    setSendingLead(true);
    try {
      // P1-D: same reasoning as sendQuoteToBusiness above — complete the
      // existing clarifying lead rather than creating a duplicate.
      if (clarifyingLeadId !== null) {
        await finalizeLeadAsOutOfScope({
          data: {
            leadId: clarifyingLeadId,
            customerName: customerName.trim(),
            phone: phone.trim(),
            flagReason: `Nothing on the price sheet covers: ${description}`,
          },
        });
      } else {
        await createFlaggedLead({
          data: {
            tenantSlug,
            customerName: customerName.trim(),
            phone: phone.trim(),
            channel,
            photoUrl: null,
            problem: description,
            flagType: "outside_service_scope",
            flagReason: `Nothing on the price sheet covers: ${description}`,
          },
        });
      }
      setLeadSent(true);
      toast.success("Sent — the business will reach out with a custom quote.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send that — try again.");
    } finally {
      setSendingLead(false);
    }
  }

  // P2 (widget parity with WhatsApp's needs_human_review handling): reached
  // when getQuoteEstimate exhausted its retry. Same branch shape as
  // sendFlaggedRequest above — complete the existing clarifying lead if one
  // exists, otherwise create a new flagged one, so this works whether the
  // failure happened on the very first attempt or after a clarification
  // round.
  async function sendNeedsReviewRequest() {
    if (!tenantSlug) {
      toast.success("Request sent to the team");
      setLeadSent(true);
      return;
    }
    if (!customerName.trim() || !phone.trim()) {
      toast.error("Add your name and phone so the business can reach you.");
      return;
    }
    setSendingLead(true);
    try {
      if (clarifyingLeadId !== null) {
        await finalizeLeadAsNeedsReview({
          data: { leadId: clarifyingLeadId, customerName: customerName.trim(), phone: phone.trim() },
        });
      } else {
        await createFlaggedLead({
          data: {
            tenantSlug,
            customerName: customerName.trim(),
            phone: phone.trim(),
            channel,
            photoUrl: null,
            problem: description,
            flagType: "needs_human_review",
            flagReason: "AI couldn't finalize this quote automatically.",
          },
        });
      }
      setLeadSent(true);
      toast.success("Sent — the business will reach out with a price.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send that — try again.");
    } finally {
      setSendingLead(false);
    }
  }

  const canSubmit = description.trim().length > 0 && (uploadedFile || selectedSample || description.length > 10);

  return (
    <div className={cn("overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-sm", compact && "text-sm")}>
      <header className="flex items-center justify-between gap-3 border-b border-neutral-100 bg-white px-5 py-4">
        <div>
          <p className="text-[11px] font-medium text-neutral-400">Get an estimate</p>
          <p className="text-base font-semibold text-neutral-900">{businessName}</p>
        </div>
        {stage !== "intake" && (
          <button
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-neutral-400 hover:bg-neutral-50 hover:text-neutral-600"
            onClick={reset}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Start over
          </button>
        )}
      </header>

      {stage === "intake" && (
        <div className="p-5">
          <h3 className="text-xl font-semibold text-neutral-900">What's going on?</h3>
          <p className="mt-1.5 text-sm text-neutral-500">
            Attach a photo and describe it — the more you share, the closer the number.
          </p>

          {/* Sample photos are a "try it without a real problem" affordance
              for prospective businesses exploring the product on /demo —
              tenantSlug is unset there. A real customer on a real business's
              widget always has an actual problem to describe, so showing
              someone else's stock photos here would just be clutter. */}
          {!tenantSlug && (
            <div className="mt-5 border-t border-neutral-100 pt-5">
              <p className="text-xs font-medium text-neutral-400">Try a sample photo</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {SAMPLE_PHOTOS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setSelectedSample(s);
                      setUploadedFile(null);
                      setDescription(s.problem);
                    }}
                    className={cn(
                      "overflow-hidden rounded-2xl border text-left transition-colors",
                      selectedSample?.id === s.id
                        ? "border-neutral-900"
                        : "border-neutral-200 hover:border-neutral-300",
                    )}
                  >
                    <img
                      src={s.img}
                      alt={s.label}
                      loading="lazy"
                      className="aspect-[4/3] w-full object-cover"
                    />
                    <span className="block px-3 py-2 text-xs font-medium text-neutral-700">{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {(uploadedFile || selectedSample) && (
            <div className="mt-4 flex w-fit items-center gap-2 rounded-full border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs text-neutral-600">
              <ImageIcon className="h-3.5 w-3.5 text-neutral-400" />
              {uploadedFile ? uploadedFile.name : selectedSample?.label}
              <button
                type="button"
                onClick={() => {
                  setUploadedFile(null);
                  setSelectedSample(null);
                }}
                aria-label="Remove photo"
                className="text-neutral-400 hover:text-neutral-700"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          <div className="mt-4 flex items-end gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              aria-label="Attach a photo"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-50"
            >
              <Plus className="h-5 w-5" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={pickFile}
              aria-label="Upload a photo of the problem"
            />
            <Textarea
              id="qf-desc"
              ref={descriptionRef}
              rows={1}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSubmit) void submitToAI([]);
                }
              }}
              placeholder="Water heater in the garage is dripping and there's rust underneath."
              className="min-h-0 flex-1 resize-none rounded-3xl border-neutral-200 py-3 focus-visible:ring-neutral-300"
            />
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => void submitToAI([])}
              aria-label="Send"
              style={accentStyle}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white transition-colors hover:bg-neutral-800 disabled:opacity-30"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-2 text-center text-xs text-neutral-400">
            No account needed. Your photo only goes to {businessName}.
          </p>
        </div>
      )}

      {stage === "loading" && (
        <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-neutral-400" />
          <p className="text-sm text-neutral-500">Reading the photo and pricing it against the sheet…</p>
        </div>
      )}

      {stage === "needsReview" && (
        <div className="p-5">
          <p className="text-xs font-medium text-neutral-400">Let's get this priced by hand</p>
          <p className="mt-2 text-sm text-neutral-700">
            This one needs a closer look before {businessName} can give you a firm number. Leave your name and
            number and the team will follow up with a price directly.
          </p>
          {!leadSent && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Input
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Your name"
                className="max-w-[200px] rounded-full border-neutral-200"
                aria-label="Your name"
                disabled={sendingLead}
              />
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(512) 555-0182"
                className="max-w-[200px] rounded-full border-neutral-200"
                aria-label="Phone number for the quote"
                disabled={sendingLead}
              />
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="lg"
              className="rounded-full bg-neutral-900 text-white hover:bg-neutral-800"
              style={accentStyle}
              disabled={sendingLead || leadSent}
              onClick={() => void sendNeedsReviewRequest()}
            >
              {leadSent ? "Sent — the team will reach out" : sendingLead ? "Sending…" : "Send my request"}
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="rounded-full border-neutral-200"
              onClick={() => setStage("intake")}
            >
              Never mind
            </Button>
          </div>
        </div>
      )}

      {stage === "outOfScope" && (
        <div className="p-5">
          <p className="text-xs font-medium text-neutral-400">Not on our standard price list</p>
          <p className="mt-2 text-sm text-neutral-700">
            {businessName} doesn't have set pricing for this specific request. I can pass it along to the team
            for a custom quote — want me to do that?
          </p>
          {!leadSent && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Input
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Your name"
                className="max-w-[200px] rounded-full border-neutral-200"
                aria-label="Your name"
                disabled={sendingLead}
              />
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(512) 555-0182"
                className="max-w-[200px] rounded-full border-neutral-200"
                aria-label="Phone number for the quote"
                disabled={sendingLead}
              />
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="lg"
              className="rounded-full bg-neutral-900 text-white hover:bg-neutral-800"
              style={accentStyle}
              disabled={sendingLead || leadSent}
              onClick={() => void sendFlaggedRequest()}
            >
              {leadSent ? "Sent — the team will reach out" : sendingLead ? "Sending…" : "Yes, send my request"}
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="rounded-full border-neutral-200"
              onClick={() => setStage("intake")}
            >
              Never mind
            </Button>
          </div>
        </div>
      )}

      {stage === "clarify" && (
        <div className="p-5">
          <p className="text-xs font-medium text-neutral-400">Just a couple of questions</p>
          <h3 className="mt-2 text-xl font-semibold text-neutral-900">This is what keeps the price honest.</h3>
          <p className="mt-1.5 text-sm text-neutral-500">
            The photo shows most of it. These answers decide the rest.
          </p>

          <div className="mt-5 space-y-5">
            {questions.map((q, i) => (
              <div key={q.question} className="border-t border-neutral-100 pt-4">
                <p className="text-sm font-medium text-neutral-900">{q.question}</p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {q.options.map((o) => (
                    <button
                      key={o}
                      onClick={() => setAnswers((a) => ({ ...a, [i]: o }))}
                      className={cn(
                        "rounded-full border px-3.5 py-1.5 text-sm transition-colors",
                        answers[i] === o
                          ? "border-neutral-900 bg-neutral-900 font-medium text-white"
                          : "border-neutral-200 text-neutral-700 hover:bg-neutral-50",
                      )}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <Button
            className="mt-6 w-full rounded-full bg-neutral-900 text-white hover:bg-neutral-800"
            size="lg"
            style={accentStyle}
            disabled={Object.keys(answers).length < questions.length}
            onClick={submitClarification}
          >
            {Object.keys(answers).length < questions.length
              ? "Answer to continue"
              : "Show me the estimate"}
          </Button>
        </div>
      )}

      {stage === "result" && result && (
        <div className="p-5">
          {result.isEmergency && (
            <div className="mb-4 rounded-2xl border border-red-100 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
              This sounds urgent — a real business would surface a "call now" prompt here instead of
              waiting on a booking link.
            </div>
          )}
          {result.hasNoPricedWork ? (
            <>
              <p className="text-xs font-medium text-neutral-400">Diagnostic fee — confirmed later</p>
              <p className="mt-2 text-sm text-neutral-500">
                We can't price this without seeing it in person. A service-call/diagnostic fee applies — we'll
                confirm the exact amount when we contact you to schedule the visit.
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium text-neutral-400">
                {result.isDiagnosisOnly ? "Diagnosis visit fee" : "Your estimate"}
              </p>
              <p className="num mt-2 text-4xl font-semibold tracking-tight text-neutral-900">
                {money(result.totalLow, currency)} – {money(result.totalHigh, currency)}
              </p>
              {result.isDiagnosisOnly ? (
                <p className="mt-1.5 text-sm text-neutral-500">
                  Due for an in-person visit to see exactly what's needed. This amount applies toward the total
                  repair cost — we'll confirm the full price once we know what the fix requires.
                </p>
              ) : (
                <p className="mt-1.5 text-sm text-neutral-500">
                  Firm once we see it in person. If it comes in under, you pay the under.
                </p>
              )}
              {result.hasPartiallyDeferredWork && (
                // P2 mixed-pricing: the total above is real and correct for
                // what IS priced — this makes clear it isn't the whole
                // request, without hiding the real number or replacing it
                // with "Price pending".
                <p className="mt-3 rounded-2xl border border-amber-100 bg-amber-50 px-3.5 py-2.5 text-sm font-medium text-amber-800">
                  One part of this still needs an in-person look before we can price it — we'll confirm that
                  separately.
                </p>
              )}
            </>
          )}

          <div className="mt-5 rounded-2xl border border-neutral-100 bg-neutral-50 p-4">
            <p className="text-xs font-medium text-neutral-400">
              What we found <span className="text-neutral-400">· {result.confidence.toLowerCase()} confidence</span>
            </p>
            <p className="mt-2 text-sm leading-relaxed text-neutral-700">{result.diagnosis}</p>
          </div>

          {!result.hasNoPricedWork && (
            <ul className="mt-5 divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-100">
              {result.lineItems.map((i) => (
                <li key={i.description} className="flex items-start justify-between gap-4 px-4 py-3">
                  <span>
                    <span className="block text-sm font-medium text-neutral-900">{i.description}</span>
                    <span className="block text-xs text-neutral-400">{i.detail}</span>
                  </span>
                  <span className="num text-sm font-semibold text-neutral-900">{money(i.amount, currency)}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="lg"
              className="rounded-full bg-neutral-900 text-white hover:bg-neutral-800"
              style={accentStyle}
              asChild={Boolean(bookingLink)}
            >
              {bookingLink ? (
                <a href={bookingLink} target="_blank" rel="noreferrer">
                  Book this now
                </a>
              ) : (
                <span onClick={() => toast.success("In your account this opens your booking link")}>
                  Book this now
                </span>
              )}
            </Button>
          </div>

          <div className="mt-4 space-y-2">
            {!leadSent && (
              <div className="flex flex-wrap gap-2">
                <Input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Your name"
                  className="max-w-[200px] rounded-full border-neutral-200"
                  aria-label="Your name"
                  disabled={sendingLead}
                />
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(512) 555-0182"
                  className="max-w-[200px] rounded-full border-neutral-200"
                  aria-label="Phone number for the quote"
                  disabled={sendingLead}
                />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="lg"
                className="rounded-full border-neutral-200"
                disabled={sendingLead || leadSent}
                onClick={() => void sendQuoteToBusiness()}
              >
                {leadSent ? "Sent — the business will reach out" : sendingLead ? "Sending…" : "Send my request"}
              </Button>
              {!leadSent && (
                <span className="text-xs text-neutral-400">
                  The business gets notified right away and will follow up with you directly.
                </span>
              )}
            </div>
          </div>

          <div className="mt-6 border-t border-neutral-100 pt-5">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-600 text-xs font-bold text-white">
                J
              </span>
              <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-semibold text-neutral-700">
                JIR
              </span>
            </div>
            <p className="mt-3 text-xs font-medium text-neutral-400">Ask a question about this estimate</p>
            <div className="mt-3 space-y-2.5">
              {thread.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex items-end gap-2",
                    m.role === "customer" ? "justify-end" : "justify-start",
                  )}
                >
                  {m.role === "desk" && (
                    <span className="mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-600 text-[10px] font-bold text-white">
                      J
                    </span>
                  )}
                  <div
                    className={cn(
                      "max-w-[80%] px-3.5 py-2.5 text-sm leading-relaxed",
                      m.role === "customer"
                        ? "rounded-2xl rounded-br-md bg-blue-100 text-neutral-900"
                        : "rounded-2xl rounded-bl-md bg-neutral-100 text-neutral-800",
                    )}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              {askingFollowUp && (
                <div className="flex items-center gap-2 pl-8 text-xs text-neutral-400">
                  <Loader2 className="h-3 w-3 animate-spin" /> JIR is thinking…
                </div>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && draft.trim()) void ask();
                }}
                placeholder="Does that price include the part?"
                aria-label="Your question"
                disabled={askingFollowUp}
                className="rounded-full border-neutral-200"
              />
              <Button
                variant="outline"
                className="shrink-0 rounded-full border-neutral-200"
                disabled={!draft.trim() || askingFollowUp}
                onClick={() => void ask()}
                aria-label="Send question"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
