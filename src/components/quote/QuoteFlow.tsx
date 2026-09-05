import { useRef, useState } from "react";
import { Camera, ImageIcon, Loader2, MessageSquare, RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import { fileToCompressedBase64, urlToCompressedBase64 } from "@/lib/image-client";
import {
  getFollowUpAnswer,
  getQuoteEstimate,
  SAMPLE_PRICE_SHEET,
  type Answer,
  type ClarifyingQuestion,
  type LineItem,
} from "@/lib/estimate-server";
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

type Stage = "intake" | "loading" | "clarify" | "result" | "error";

type ResultState = {
  isEmergency: boolean;
  issueType: string;
  severity: "Low" | "Medium" | "High";
  confidence: "High" | "Medium" | "Low";
  diagnosis: string;
  lineItems: LineItem[];
  totalLow: number;
  totalHigh: number;
};

export function QuoteFlow({
  businessName,
  accent,
  bookingLink,
  compact = false,
  laborRate = 125,
  serviceCallFee = 60,
}: {
  businessName: string;
  accent?: string;
  bookingLink?: string;
  compact?: boolean;
  laborRate?: number;
  serviceCallFee?: number;
}) {
  const [stage, setStage] = useState<Stage>("intake");
  const [selectedSample, setSelectedSample] = useState<SamplePhoto | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [questions, setQuestions] = useState<ClarifyingQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [priorAnswers, setPriorAnswers] = useState<Answer[]>([]);
  const [result, setResult] = useState<ResultState | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [thread, setThread] = useState<{ role: "customer" | "desk"; text: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [askingFollowUp, setAskingFollowUp] = useState(false);
  const [phone, setPhone] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const accentStyle = accent ? { backgroundColor: accent, borderColor: accent } : undefined;

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      setUploadedFile(f);
      setSelectedSample(null);
      toast.success("Photo attached");
    }
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

  async function submitToAI(answersForThisRound: Answer[]) {
    setStage("loading");
    try {
      const { base64, mediaType } = await resolveImage();
      const outcome = await getQuoteEstimate({
        data: {
          businessName,
          laborRate,
          serviceCallFee,
          priceSheet: SAMPLE_PRICE_SHEET,
          description,
          imageBase64: base64,
          imageMediaType: mediaType,
          answers: answersForThisRound,
        },
      });

      if (outcome.needsClarification) {
        setQuestions(outcome.questions);
        setAnswers({});
        setStage("clarify");
        return;
      }

      setResult(outcome);
      setStage("result");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong. Try again.");
      setStage("error");
    }
  }

  function submitClarification() {
    const newAnswers: Answer[] = questions.map((q, i) => ({
      question: q.question,
      answer: answers[i] ?? "",
    }));
    const combined = [...priorAnswers, ...newAnswers];
    setPriorAnswers(combined);
    void submitToAI(combined);
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
    setErrorMessage("");
    setThread([]);
  }

  const canSubmit = description.trim().length > 0 && (uploadedFile || selectedSample || description.length > 10);

  return (
    <div className={cn("border border-border-strong bg-card", compact && "text-sm")}>
      <header className="flex items-center justify-between gap-3 border-b border-border-strong bg-ink px-4 py-3 text-ink-foreground">
        <div>
          <p className="label-caps text-primary">Get an estimate</p>
          <p className="font-display text-base font-bold">{businessName}</p>
        </div>
        {stage !== "intake" && (
          <button
            className="inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink-foreground"
            onClick={reset}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Start over
          </button>
        )}
      </header>

      {stage === "intake" && (
        <div className="p-5">
          <h3 className="text-xl">What's going on?</h3>
          <p className="mt-1.5 text-sm text-muted-foreground">
            A photo gets you the closest number. Two sentences is plenty of description.
          </p>

          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => fileRef.current?.click()}
            >
              <Camera className="mr-2 h-4 w-4 shrink-0" /> Take a photo
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => fileRef.current?.click()}
            >
              <ImageIcon className="mr-2 h-4 w-4 shrink-0" /> Choose from gallery
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => descriptionRef.current?.focus()}
            >
              <MessageSquare className="mr-2 h-4 w-4 shrink-0" /> Skip the photo
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={pickFile}
              aria-label="Upload a photo of the problem"
            />
          </div>

          <div className="mt-6 border-t border-border pt-5">
            <p className="label-caps text-muted-foreground">Or use one of these sample photos</p>
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
                    "overflow-hidden border text-left transition-colors",
                    selectedSample?.id === s.id
                      ? "border-primary"
                      : "border-border hover:border-border-strong",
                  )}
                >
                  <img
                    src={s.img}
                    alt={s.label}
                    loading="lazy"
                    className="aspect-[4/3] w-full object-cover"
                  />
                  <span className="block px-2.5 py-2 text-xs font-medium">{s.label}</span>
                </button>
              ))}
            </div>
            {uploadedFile && (
              <p className="mt-3 text-xs text-muted-foreground">Attached: {uploadedFile.name}</p>
            )}
          </div>

          <div className="mt-6">
            <label htmlFor="qf-desc" className="label-caps text-muted-foreground">
              Describe it
            </label>
            <Textarea
              id="qf-desc"
              ref={descriptionRef}
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Water heater in the garage is dripping and there's rust underneath."
              className="mt-2"
            />
          </div>

          <Button
            className="mt-4 w-full"
            size="lg"
            style={accentStyle}
            disabled={!canSubmit}
            onClick={() => void submitToAI([])}
          >
            Get my estimate
          </Button>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            No account needed. Your photo only goes to {businessName}.
          </p>
        </div>
      )}

      {stage === "loading" && (
        <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Reading the photo and pricing it against the sheet…</p>
        </div>
      )}

      {stage === "error" && (
        <div className="p-5">
          <p className="label-caps text-destructive">Couldn't get an estimate</p>
          <p className="mt-2 text-sm text-foreground">{errorMessage}</p>
          <Button className="mt-4" variant="outline" onClick={() => setStage("intake")}>
            Back
          </Button>
        </div>
      )}

      {stage === "clarify" && (
        <div className="p-5">
          <p className="label-caps text-accent">Just a couple of questions</p>
          <h3 className="mt-2 text-xl">This is what keeps the price honest.</h3>
          <p className="mt-1.5 text-sm text-muted-foreground">
            The photo shows most of it. These answers decide the rest.
          </p>

          <div className="mt-5 space-y-5">
            {questions.map((q, i) => (
              <div key={q.question} className="border-t border-border pt-4">
                <p className="text-sm font-semibold text-foreground">{q.question}</p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {q.options.map((o) => (
                    <button
                      key={o}
                      onClick={() => setAnswers((a) => ({ ...a, [i]: o }))}
                      className={cn(
                        "rounded-sm border px-3 py-1.5 text-sm transition-colors",
                        answers[i] === o
                          ? "border-primary bg-primary/10 font-semibold text-primary"
                          : "border-border-strong hover:bg-muted",
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
            className="mt-6 w-full"
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
            <div className="mb-4 border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              This sounds urgent — a real business would surface a "call now" prompt here instead of
              waiting on a booking link.
            </div>
          )}
          <p className="label-caps text-primary">Your estimate</p>
          <p className="num mt-2 font-display text-4xl font-extrabold text-foreground">
            {money(result.totalLow)} – {money(result.totalHigh)}
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Firm once we see it in person. If it comes in under, you pay the under.
          </p>

          <div className="mt-5 border-t border-border-strong pt-4">
            <p className="label-caps text-muted-foreground">
              What we found <span className="text-foreground/60">· {result.confidence.toLowerCase()} confidence</span>
            </p>
            <p className="mt-2 text-sm leading-relaxed text-foreground">{result.diagnosis}</p>
          </div>

          <ul className="mt-5 divide-y divide-border border-y border-border">
            {result.lineItems.map((i) => (
              <li key={i.description} className="flex items-start justify-between gap-4 py-3">
                <span>
                  <span className="block text-sm font-medium text-foreground">{i.description}</span>
                  <span className="block text-xs text-muted-foreground">{i.detail}</span>
                </span>
                <span className="num text-sm font-semibold text-foreground">{money(i.amount)}</span>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="lg" style={accentStyle} asChild={Boolean(bookingLink)}>
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
            <Button variant="outline" size="lg" onClick={() => toast.success("Quote texted to you")}>
              Text me this quote
            </Button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(512) 555-0182"
              className="max-w-[200px]"
              aria-label="Phone number for the quote"
            />
            <span className="text-xs text-muted-foreground">
              We'll text the estimate so you can decide later.
            </span>
          </div>

          <div className="mt-6 border-t border-border-strong pt-5">
            <p className="label-caps text-muted-foreground">Ask a question about this estimate</p>
            <div className="mt-3 space-y-3">
              {thread.map((m, i) => (
                <div
                  key={i}
                  className={cn(
                    "max-w-[85%] rounded-sm px-3 py-2 text-sm",
                    m.role === "customer"
                      ? "ml-auto bg-ink text-ink-foreground"
                      : "bg-muted text-foreground",
                  )}
                >
                  {m.text}
                </div>
              ))}
              {askingFollowUp && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
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
              />
              <Button
                variant="outline"
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
