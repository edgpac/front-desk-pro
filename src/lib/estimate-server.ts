import { createServerFn } from "@tanstack/react-start";

// Generalized version of the vision+pricing logic proven out in Cabos
// Handyman's api/analyze-parts.js — same shape (photo in, clarify-or-price
// out), but driven by a tenant's own price sheet/labor rate instead of one
// business's hardcoded numbers.

export type PriceSheetItem = {
  task: string;
  keywords: string[];
  priceMin: number;
  priceMax: number;
  hours: number;
};

export type Answer = { question: string; answer: string };

export type QuoteInput = {
  businessName: string;
  laborRate: number;
  serviceCallFee: number;
  priceSheet: PriceSheetItem[];
  description: string;
  imageBase64?: string | undefined;
  imageMediaType?: string | undefined;
  answers?: Answer[] | undefined;
};

export type ClarifyingQuestion = { question: string; options: string[] };
export type LineItem = { description: string; detail: string; amount: number };

export type QuoteResult =
  | { needsClarification: true; questions: ClarifyingQuestion[] }
  | {
      needsClarification: false;
      isEmergency: boolean;
      issueType: string;
      severity: "Low" | "Medium" | "High";
      confidence: "High" | "Medium" | "Low";
      diagnosis: string;
      lineItems: LineItem[];
      totalLow: number;
      totalHigh: number;
    };

export const SAMPLE_PRICE_SHEET: PriceSheetItem[] = [
  {
    task: "Drain valve replacement",
    keywords: ["water heater", "drain valve", "dripping", "bottom fitting"],
    priceMin: 130,
    priceMax: 200,
    hours: 1,
  },
  {
    task: "Tank flush & sediment clear",
    keywords: ["water heater", "sediment", "flush", "old heater"],
    priceMin: 80,
    priceMax: 110,
    hours: 0.5,
  },
  {
    task: "P-trap rebuild",
    keywords: ["sink", "p-trap", "slip joint", "drip under sink"],
    priceMin: 120,
    priceMax: 170,
    hours: 1,
  },
  {
    task: "Drain clearing",
    keywords: ["clog", "slow drain", "backed up", "snake"],
    priceMin: 150,
    priceMax: 250,
    hours: 1,
  },
  {
    task: "Dedicated circuit run",
    keywords: ["breaker trips", "dedicated circuit", "dryer circuit", "shared circuit"],
    priceMin: 500,
    priceMax: 750,
    hours: 3,
  },
  {
    task: "Breaker replacement",
    keywords: ["breaker", "double-tapped", "panel"],
    priceMin: 100,
    priceMax: 180,
    hours: 1,
  },
  {
    task: "Outlet or switch replacement",
    keywords: ["outlet", "switch", "scorched", "sparking"],
    priceMin: 60,
    priceMax: 140,
    hours: 1,
  },
  {
    task: "Faucet installation",
    keywords: ["faucet", "tap", "leaking faucet"],
    priceMin: 150,
    priceMax: 280,
    hours: 1.5,
  },
];

const MAX_DESCRIPTION_LENGTH = 2000;

// Spanish heuristic ported from Cabos Handyman's api/analyze-parts.js
// detectSpanish() — fast, free (no extra API call) instead of asking Claude
// to detect language as a separate step.
const SPANISH_PATTERNS = [
  /\b(hola|buenos días|buenas tardes|gracias|por favor|necesito|tengo|estoy|puede|cuánto|cuanto|dónde|donde|cuál|cual)\b/i,
  /\b(servicio|precio|costo|ayuda|problema|roto|reparar|instalar|fuga|gotea|arreglar)\b/i,
  /[¿¡]/,
  /ción\b/i,
  /ñ/i,
];

// Hebrew uses its own Unicode block, so detection is actually more reliable
// than the Spanish word-pattern heuristic — no overlap with Latin script, no
// false positives from English text.
const HEBREW_PATTERN = /[֐-׿]/;

export type DetectedLanguage = "es" | "he" | "en";

export function detectLanguage(...texts: (string | undefined)[]): DetectedLanguage {
  const combined = texts.filter(Boolean).join(" ");
  if (HEBREW_PATTERN.test(combined)) return "he";
  if (SPANISH_PATTERNS.some((pattern) => pattern.test(combined))) return "es";
  return "en";
}

export const LANGUAGE_NAME: Record<DetectedLanguage, string> = {
  es: "Spanish",
  he: "Hebrew",
  en: "English",
};

// Naive in-memory global sliding window — no per-tenant/per-IP request
// context is wired up at this layer yet, so this only protects against a
// single instance getting hammered. Revisit once this sits behind real
// auth/hosting and tenants have their own quotas.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
let windowStart = Date.now();
let windowCount = 0;

function withinRateLimit(): boolean {
  const now = Date.now();
  if (now - windowStart > WINDOW_MS) {
    windowStart = now;
    windowCount = 0;
  }
  windowCount++;
  return windowCount <= MAX_PER_WINDOW;
}

export async function callClaude(body: unknown): Promise<any> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set on the server. Copy .env.example to .env and add a real key.",
    );
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Claude API error ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

function buildPrompt(input: QuoteInput): string {
  const sheetLines = input.priceSheet
    .map(
      (item) =>
        `- ${item.task} (matches: ${item.keywords.join(", ")}) — about ${item.hours}hr, $${item.priceMin}-$${item.priceMax}`,
    )
    .join("\n");

  const answersBlock = input.answers?.length
    ? `\n\nCUSTOMER'S ANSWERS TO YOUR FOLLOW-UP QUESTIONS:\n${input.answers
        .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
        .join("\n")}`
    : "";

  const language = detectLanguage(input.description, ...(input.answers?.map((a) => a.answer) ?? []));
  const languageInstruction =
    language !== "en"
      ? `\n\nIMPORTANT: The customer is writing in ${LANGUAGE_NAME[language]}. Write every human-readable value in your JSON response — diagnosis, questions, options, line item description/detail — in ${LANGUAGE_NAME[language]}. Keep the JSON keys themselves in English exactly as shown (issueType, severity, etc.) — only translate the values.`
      : "";

  const hasPhoto = Boolean(input.imageBase64);
  const photoStatus = hasPhoto
    ? "A customer sent a photo and a description of a problem."
    : "A customer sent only a text description — no photo was attached.";

  return `You are the AI front desk for ${input.businessName}, a trades business. ${photoStatus} Diagnose it and produce a priced estimate the way an experienced tradesperson would after seeing the photo and asking a couple of clarifying questions.${languageInstruction}

CUSTOMER'S DESCRIPTION: "${input.description}"${answersBlock}

THE BUSINESS'S OWN PRICE SHEET (use these numbers when the job matches; otherwise estimate reasonably against the $${input.laborRate}/hr labor rate):
${sheetLines || "(no price sheet provided — estimate using the labor rate only)"}

Service call fee: $${input.serviceCallFee} (covers diagnosis plus the first hour of labor; only hours beyond the first are billed at $${input.laborRate}/hr).

RULES:
1. If the photo and description together are not enough to price this confidently, respond with 1-2 short clarifying questions instead of guessing. Give each question 2-4 short tappable answer options. Only ask if the answer would actually change the price. ${hasPhoto ? "" : "No photo was provided — a photo is almost always the single most useful thing you're missing, so make your first clarifying question a request for one (with an option for 'I don't have a photo handy' so the conversation isn't blocked) rather than asking about a detail a photo would answer faster."}
2. If you have enough information, give a plain-language diagnosis (what's actually wrong, not just a restatement of the question), a severity (Low/Medium/High — High means it risks getting worse or is a safety issue), your confidence in reading the photo, and a line-item cost breakdown.
3. Only include line items that make sense for what was described — don't pad the estimate.
4. If this describes an active emergency (active flooding, sparking, a gas smell, no power to the whole house), set isEmergency to true and say so plainly in the diagnosis.

Respond with ONLY valid JSON, no markdown fences, matching exactly one of these two shapes:

{"needsClarification": true, "questions": [{"question": "...", "options": ["...", "..."]}]}

or

{"needsClarification": false, "isEmergency": false, "issueType": "...", "severity": "Low|Medium|High", "confidence": "High|Medium|Low", "diagnosis": "...", "lineItems": [{"description": "...", "detail": "...", "amount": 120}], "totalLow": 100, "totalHigh": 140}`;
}

export const getQuoteEstimate = createServerFn({ method: "POST" })
  .validator((input: QuoteInput) => input)
  .handler(async ({ data }): Promise<QuoteResult> => {
    if (!withinRateLimit()) {
      throw new Error("This demo is getting a lot of traffic right now — try again in a minute.");
    }
    if (!data.description || data.description.trim().length === 0) {
      throw new Error("Description is required.");
    }
    if (data.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error("Description is too long.");
    }

    const content: Array<Record<string, unknown>> = [{ type: "text", text: buildPrompt(data) }];
    if (data.imageBase64) {
      content.unshift({
        type: "image",
        source: {
          type: "base64",
          media_type: data.imageMediaType || "image/jpeg",
          data: data.imageBase64,
        },
      });
    }

    const response = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      temperature: 0.3,
      system:
        "You are an expert trades estimator. Respond with ONLY valid JSON, no markdown code fences, matching the shape described in the prompt exactly.",
      messages: [{ role: "user", content }],
    });

    const raw: string | undefined = response.content?.[0]?.text?.trim();
    if (!raw) throw new Error("No response from Claude.");

    const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error("Couldn't parse the estimate — try again.");
    }

    if (parsed.needsClarification) {
      return { needsClarification: true, questions: parsed.questions ?? [] };
    }

    const lineItems: LineItem[] = Array.isArray(parsed.lineItems) ? parsed.lineItems : [];
    const total = lineItems.reduce((sum, i) => sum + (Number(i.amount) || 0), 0);

    return {
      needsClarification: false,
      isEmergency: Boolean(parsed.isEmergency),
      issueType: parsed.issueType || "Maintenance Issue",
      severity: parsed.severity || "Medium",
      confidence: parsed.confidence || "Medium",
      diagnosis: parsed.diagnosis || "",
      lineItems,
      totalLow: parsed.totalLow ?? total,
      totalHigh: parsed.totalHigh ?? total,
    };
  });

export type FollowUpInput = {
  businessName: string;
  diagnosis: string;
  lineItems: LineItem[];
  question: string;
  history: { role: "customer" | "desk"; text: string }[];
};

export const getFollowUpAnswer = createServerFn({ method: "POST" })
  .validator((input: FollowUpInput) => input)
  .handler(async ({ data }): Promise<string> => {
    if (!withinRateLimit()) {
      throw new Error("This demo is getting a lot of traffic right now — try again in a minute.");
    }
    if (!data.question || data.question.trim().length === 0) {
      throw new Error("Question is required.");
    }

    const itemsText = data.lineItems.map((i) => `- ${i.description}: $${i.amount}`).join("\n");
    const historyText = data.history
      .map((m) => `${m.role === "customer" ? "Customer" : "You"}: ${m.text}`)
      .join("\n");

    const language = detectLanguage(data.question, data.diagnosis, ...data.history.map((m) => m.text));
    const languageInstruction =
      language !== "en"
        ? ` Reply in ${LANGUAGE_NAME[language]} — the conversation so far has been in ${LANGUAGE_NAME[language]}.`
        : "";

    const prompt = `You are answering a follow-up question on behalf of ${data.businessName} about an estimate you already gave a customer.

DIAGNOSIS GIVEN: ${data.diagnosis}
LINE ITEMS:
${itemsText}
${historyText ? `\nCONVERSATION SO FAR:\n${historyText}` : ""}

CUSTOMER'S QUESTION: "${data.question}"

Answer briefly (2-4 sentences), in plain language, staying consistent with the estimate above.${languageInstruction} If you don't know something (exact timing, whether a part is in stock), say the business will confirm it, don't invent specifics.`;

    const response = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      temperature: 0.4,
      messages: [{ role: "user", content: prompt }],
    });

    const raw: string | undefined = response.content?.[0]?.text?.trim();
    return raw || "Good question — the business will follow up with specifics on that.";
  });
