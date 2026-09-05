import { detectLanguage } from "@/lib/estimate-server";
import { money } from "@/lib/mock-data";

// Links the AI diagnosis + current line-item total straight to a ready-to-send
// customer message — when the diagnosis is right and nothing needs editing,
// this is the whole reply, and sending it is the only action left to take.
export function buildSuggestedReply(params: {
  problem: string;
  diagnosis: string;
  total: number;
  currency?: string;
}) {
  const language = detectLanguage(params.problem, params.diagnosis);
  const amount = money(params.total, params.currency ?? "USD");
  if (language === "es") {
    return `Según las fotos: ${params.diagnosis} En total serían ${amount}. ¿Le gustaría que agendemos la visita?`;
  }
  return `Based on the photos: ${params.diagnosis} That comes to ${amount} total. Want me to get this booked in?`;
}

export function lineItemsMatch(
  a: Array<{ description: string; qty: number; unit: string; rate: number }>,
  b: Array<{ description: string; qty: number; unit: string; rate: number }>,
) {
  if (a.length !== b.length) return false;
  const normalize = (items: typeof a) =>
    items
      .map((i) => `${i.description}|${i.qty}|${i.unit}|${i.rate}`)
      .sort()
      .join("::");
  return normalize(a) === normalize(b);
}
