import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { callClaude } from "@/lib/estimate-server";
import type { PriceSheetRow, PricingType } from "@/lib/mock-data";

type PriceSheetItemRow = {
  id: string;
  task: string;
  category: string;
  keywords: string[];
  pricing_type: PricingType;
  price_min: number;
  price_max: number;
  hours: number;
};

function toRow(item: PriceSheetItemRow): PriceSheetRow {
  return {
    id: item.id,
    task: item.task,
    category: item.category,
    keywords: item.keywords,
    pricingType: item.pricing_type,
    priceMin: item.price_min,
    priceMax: item.price_max,
    hours: item.hours,
  };
}

export const listMyPriceSheet = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PriceSheetRow[]> => {
    const { data: tenant, error: tenantError } = await context.supabase
      .from("tenants")
      .select("id")
      .eq("user_id", context.userId)
      .single();
    if (tenantError) throw new Error(`Could not load your business: ${tenantError.message}`);

    const { data, error } = await context.supabase
      .from("price_sheet_items")
      .select("id, task, category, keywords, pricing_type, price_min, price_max, hours")
      .eq("tenant_id", tenant.id)
      .order("sort_order", { ascending: true });
    if (error) throw new Error(`Could not load price sheet: ${error.message}`);
    return (data as PriceSheetItemRow[]).map(toRow);
  });

// Full replace: the price sheet is small and edited rarely, so swapping the
// whole set is simpler and safer than diffing inserts/updates/deletes.
export const saveMyPriceSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (input: {
      items: Array<{
        task: string;
        category: string;
        keywords: string[];
        pricingType: PricingType;
        priceMin: number;
        priceMax: number;
        hours: number;
      }>;
    }) => input,
  )
  .handler(async ({ context, data }) => {
    const { data: tenant, error: tenantError } = await context.supabase
      .from("tenants")
      .select("id")
      .eq("user_id", context.userId)
      .single();
    if (tenantError) throw new Error(`Could not load your business: ${tenantError.message}`);

    const { error: deleteError } = await context.supabase
      .from("price_sheet_items")
      .delete()
      .eq("tenant_id", tenant.id);
    if (deleteError) throw new Error(`Could not save price sheet: ${deleteError.message}`);

    if (data.items.length === 0) return { ok: true as const };

    const { error: insertError } = await context.supabase.from("price_sheet_items").insert(
      data.items.map((item, index) => ({
        tenant_id: tenant.id,
        task: item.task,
        category: item.category,
        keywords: item.keywords,
        pricing_type: item.pricingType,
        price_min: item.priceMin,
        price_max: item.priceMax,
        hours: item.hours,
        sort_order: index,
      })),
    );
    if (insertError) throw new Error(`Could not save price sheet: ${insertError.message}`);
    return { ok: true as const };
  });

export type ExtractedPriceSheetItem = {
  task: string;
  category: string;
  keywords: string[];
  pricingType: PricingType;
  priceMin: number;
  priceMax: number;
  hours: number;
};

const VALID_PRICING_TYPES: PricingType[] = ["flat", "hourly", "range"];

// The upload button used to be a stub (a toast saying "isn't wired up yet").
// Real extraction, using the same Claude-vision pattern already proven in
// estimate-server.ts's getQuoteEstimate — reusing its callClaude() rather
// than duplicating the Anthropic fetch call.
export const extractPriceSheetFromImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { imageBase64: string; imageMediaType: string }) => input)
  .handler(async ({ data }): Promise<ExtractedPriceSheetItem[]> => {
    const prompt = `This image shows a price list or menu of services for a trades/service business.

Extract every distinct service and its price into a JSON array. For each one, determine:
- "task": a short, clear name for the service.
- "category": a short grouping (e.g. "Plumbing", "Electrical", "General") — group similar tasks together, invent reasonable categories if none are labeled in the image.
- "keywords": 2-4 lowercase words a customer might use when describing this problem (for matching later, not shown to anyone).
- "pricingType": "flat" if it's a single price, "hourly" if it's a rate per hour, or "range" if a price range is given.
- "priceMin" and "priceMax": both equal to the price for "flat" or "hourly"; the low/high ends for "range".
- "hours": your best numeric estimate of typical hours for the job (use the midpoint if a duration range is shown; use 1 if none is given).

Respond with ONLY a JSON array, no markdown fences, no commentary — just:
[{"task":"...","category":"...","keywords":["...","..."],"pricingType":"flat","priceMin":100,"priceMax":100,"hours":1}, ...]

If the image doesn't contain any readable prices or services, respond with an empty array: []`;

    const response = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      temperature: 0.2,
      system: "You extract structured price lists from photos. Respond with ONLY valid JSON, no markdown fences, no commentary.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: data.imageMediaType || "image/jpeg", data: data.imageBase64 },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    });

    const raw: string | undefined = response.content?.[0]?.text?.trim();
    if (!raw) throw new Error("No response from the AI — try again.");

    return parseExtractedItems(raw);
  });

function parseExtractedItems(raw: string): ExtractedPriceSheetItem[] {
  const cleaned = raw.replace(/```json\n?|\n?```/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Couldn't read a price list from that — try a different page or a clearer photo.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Couldn't find any price sheet rows there.");
  }
  return parsed.map((item: Record<string, unknown>) => {
    const pricingType = VALID_PRICING_TYPES.includes(item["pricingType"] as PricingType)
      ? (item["pricingType"] as PricingType)
      : "flat";
    const priceMin = Number(item["priceMin"]) || 0;
    return {
      task: String(item["task"] ?? "Untitled service"),
      category: String(item["category"] ?? "General"),
      keywords: Array.isArray(item["keywords"]) ? item["keywords"].map(String) : [],
      pricingType,
      priceMin,
      priceMax: Number(item["priceMax"] ?? priceMin) || priceMin,
      hours: Number(item["hours"]) || 1,
    };
  });
}

const PRICE_LIST_EXTRACTION_PROMPT = `The text below was extracted from a business's web page. It may contain a price list or menu of services, mixed in with navigation, headers, and other page text — ignore everything that isn't a priced service.

For each distinct service with a price, determine:
- "task": a short, clear name for the service.
- "category": a short grouping (e.g. "Plumbing", "Electrical", "General") — group similar tasks together.
- "keywords": 2-4 lowercase words a customer might use when describing this problem.
- "pricingType": "flat" for a single price, "hourly" for a rate per hour, or "range" for a price range.
- "priceMin" and "priceMax": both equal to the price for "flat"/"hourly"; the low/high ends for "range".
- "hours": your best numeric estimate of typical hours for the job (midpoint if a duration range is given, 1 if none).

Respond with ONLY a JSON array, no markdown fences, no commentary:
[{"task":"...","category":"...","keywords":["...","..."],"pricingType":"flat","priceMin":100,"priceMax":100,"hours":1}, ...]

If no priced services are found in the text, respond with an empty array: []

PAGE TEXT:
"""`;

// Blocks the obvious SSRF targets (internal/loopback/link-local addresses) —
// this is a server making a request to a URL an authenticated user chose,
// so it shouldn't be usable to probe internal network addresses.
function isSafePublicUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") return false;
  if (host === "169.254.169.254") return false; // cloud metadata endpoint

  const ipMatch = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [a, b] = [Number(ipMatch[1]), Number(ipMatch[2])];
    if (a === 127) return false; // loopback
    if (a === 10) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 169 && b === 254) return false; // link-local
  }
  return true;
}

// Strips scripts/styles/tags and decodes the common entities — enough to
// turn HTML into readable text for Claude without adding an HTML-parsing
// dependency this codebase doesn't otherwise use.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_PAGE_TEXT_LENGTH = 15_000;

// Lightweight, server-side fetch + text extraction — works well for most
// small-business sites (Wix, Squarespace, WordPress, plain HTML), which
// serve real content directly in the HTML. Won't find anything on a
// client-rendered single-page app (React/Vue/etc. with no server-rendered
// content) since the page's real content only exists after JavaScript runs,
// which this never does — that's a real limitation, not a bug, and photo
// upload (extractPriceSheetFromImage, above) is the right tool for those.
export const extractPriceSheetFromUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { url: string }) => input)
  .handler(async ({ data }): Promise<ExtractedPriceSheetItem[]> => {
    if (!isSafePublicUrl(data.url)) {
      throw new Error("That doesn't look like a public website address.");
    }

    let html: string;
    try {
      const response = await fetch(data.url, {
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "Mozilla/5.0 (compatible; JobItReadyBot/1.0)" },
      });
      if (!response.ok) {
        throw new Error(`That page returned an error (${response.status}).`);
      }
      html = await response.text();
    } catch (err) {
      throw new Error(err instanceof Error && err.message.includes("error (") ? err.message : "Couldn't reach that page.");
    }

    const text = htmlToText(html).slice(0, MAX_PAGE_TEXT_LENGTH);
    if (!text) {
      throw new Error("That page didn't have any readable text — it may need JavaScript to show its content.");
    }

    const response = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      temperature: 0.2,
      system: "You extract structured price lists from web page text. Respond with ONLY valid JSON, no markdown fences, no commentary.",
      messages: [{ role: "user", content: `${PRICE_LIST_EXTRACTION_PROMPT}${text}"""` }],
    });

    const raw: string | undefined = response.content?.[0]?.text?.trim();
    if (!raw) throw new Error("No response from the AI — try again.");

    return parseExtractedItems(raw);
  });
