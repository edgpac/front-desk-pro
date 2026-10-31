import { describe, expect, it } from "vitest";
import { countSentences } from "./sentence-counter";

describe("countSentences", () => {
  it("counts zero for empty or whitespace-only text", () => {
    expect(countSentences("")).toBe(0);
    expect(countSentences("   ")).toBe(0);
  });

  it("counts one for text with no terminal punctuation at all", () => {
    expect(countSentences("Gracias")).toBe(1);
    expect(countSentences("Sure thing")).toBe(1);
  });

  it("counts one simple declarative sentence", () => {
    expect(countSentences("Gracias.")).toBe(1);
  });

  it("counts two sentences separated by a period", () => {
    expect(countSentences("No reparamos secadoras. Puede contactar a Kiki.")).toBe(2);
  });

  it("counts three sentences", () => {
    expect(
      countSentences(
        "Buenos días. No reparamos secadoras. Puede contactar a Kiki; él los puede ayudar.",
      ),
    ).toBe(3);
  });

  it("does not split a decimal price into two sentences", () => {
    expect(countSentences("El precio es $75.50 por hora.")).toBe(1);
  });

  it("does not split '3.5 hours' as a decimal mid-sentence", () => {
    expect(countSentences("Tarda unas 3.5 horas en total.")).toBe(1);
  });

  it("does not split after a single-word abbreviation (Dr., Sra., Lic.)", () => {
    expect(countSentences("Dr. Smith revisará el caso.")).toBe(1);
    expect(countSentences("La Sra. García llamó ayer.")).toBe(1);
    expect(countSentences("El Lic. Pérez firmó el contrato.")).toBe(1);
  });

  it("does not split inside a.m./p.m., even mid-sentence", () => {
    expect(countSentences("Nos vemos a las 3:00 p.m. mañana.")).toBe(1);
    expect(countSentences("Abrimos a las 8:00 a.m. todos los días.")).toBe(1);
  });

  it("does not split after e.g. or i.e.", () => {
    expect(countSentences("Podemos hacer reparaciones menores, e.g. grifos y llaves.")).toBe(1);
  });

  it("treats consecutive punctuation (?!, !!!) as a single sentence boundary", () => {
    expect(countSentences("¿En serio?! No lo puedo creer.")).toBe(2);
    expect(countSentences("¡Genial!!! Nos vemos pronto.")).toBe(2);
  });

  it("treats an ellipsis as one boundary, not three", () => {
    expect(countSentences("Esto es un mensaje con puntos suspensivos... y continúa.")).toBe(2);
  });

  it("counts a question and an exclamation correctly", () => {
    expect(countSentences("¡Hola! ¿Cómo estás?")).toBe(2);
  });

  it("a real two-sentence reply counts exactly two, at the boundary of the limit", () => {
    expect(countSentences("Hola! Claro que sí, podemos revisar el grifo mañana.")).toBe(2);
  });
});
