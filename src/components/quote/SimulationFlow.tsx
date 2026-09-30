import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { money } from "@/lib/mock-data";
import leakPhoto from "@/assets/leak-detail.jpg";
import panelPhoto from "@/assets/electrician-panel.jpg";

// Fully scripted — no getQuoteEstimate, no createLead, no tenant slug, no
// network call of any kind. Every question, answer option, and outcome
// below is a fixed literal; picking any option always leads to the same
// result for that scenario. Built specifically so this page can be used
// to demonstrate/test the intake→clarify→result flow without touching a
// real tenant's data or making a real Anthropic/Supabase call.
type ScenarioId = "heater" | "panel";

type Scenario = {
  id: ScenarioId;
  img: string;
  label: string;
  problem: string;
  questions: [
    { question: string; options: [string, string] },
    { question: string; options: [string, string] },
  ];
  diagnosis: string;
  lineItems: { description: string; detail: string; amount: number }[];
  totalLow: number;
  totalHigh: number;
};

const SCENARIOS: Scenario[] = [
  {
    id: "heater",
    img: leakPhoto,
    label: "Leaking water heater",
    problem: "Water heater dripping at the bottom fitting, rust on the floor.",
    questions: [
      { question: "Do you have a clear photo of the leak?", options: ["Yes", "No"] },
      { question: "Is the tank itself visibly rusted or corroded?", options: ["Yes", "No"] },
    ],
    diagnosis:
      "Fitting leak at the base of the tank, with early corrosion visible on the tank shell — recommend replacing the fitting now rather than waiting for a full tank failure.",
    lineItems: [
      { description: "Water heater fitting repair", detail: "Labor + parts", amount: 145 },
      { description: "Corrosion inspection", detail: "Tank shell + surrounding area", amount: 45 },
    ],
    totalLow: 180,
    totalHigh: 220,
  },
  {
    id: "panel",
    img: panelPhoto,
    label: "Breaker keeps tripping",
    problem: "Dryer trips the breaker every time it runs, panel looks old.",
    questions: [
      { question: "Do you have a clear photo of the breaker panel?", options: ["Yes", "No"] },
      { question: "Does it trip immediately, or after running a while?", options: ["Immediately", "After a while"] },
    ],
    diagnosis:
      "Breaker is correctly tripping on an overloaded circuit — the dryer is likely sharing a circuit it's outgrown. A dedicated 240V circuit resolves this permanently.",
    lineItems: [
      { description: "Circuit diagnostic", detail: "Panel + load check", amount: 89 },
      { description: "Dedicated circuit install", detail: "If panel has capacity", amount: 220 },
    ],
    totalLow: 89,
    totalHigh: 309,
  },
];

type Stage = "pick" | "clarify" | "result";

export function SimulationFlow() {
  const [stage, setStage] = useState<Stage>("pick");
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});

  function pickScenario(s: Scenario) {
    setScenario(s);
    setAnswers({});
    setStage("clarify");
  }

  function reset() {
    setStage("pick");
    setScenario(null);
    setAnswers({});
  }

  return (
    <div className="overflow-hidden rounded-sm border border-border-strong bg-card">
      <div className="border-b border-border-strong bg-amber-50 px-5 py-2.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
          Simulation only — no photo is analyzed, no AI is called, nothing is saved
        </p>
      </div>

      {stage === "pick" && (
        <div className="p-5">
          <p className="text-xs font-medium text-neutral-400">Get an estimate</p>
          <h3 className="mt-2 text-xl font-semibold text-neutral-900">Pick a sample job</h3>
          <p className="mt-1.5 text-sm text-neutral-500">
            Every outcome below is scripted ahead of time — same two questions, same result, every time.
          </p>
          <div className="mt-5 grid grid-cols-2 gap-3">
            {SCENARIOS.map((s) => (
              <button
                key={s.id}
                onClick={() => pickScenario(s)}
                className="overflow-hidden rounded-2xl border border-neutral-200 text-left transition-colors hover:border-neutral-400"
              >
                <img src={s.img} alt={s.label} className="h-28 w-full object-cover" />
                <p className="px-3 py-2 text-sm font-medium text-neutral-900">{s.label}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {stage === "clarify" && scenario && (
        <div className="p-5">
          <p className="text-xs font-medium text-neutral-400">Just a couple of questions</p>
          <h3 className="mt-2 text-xl font-semibold text-neutral-900">This is what keeps the price honest.</h3>
          <p className="mt-1.5 text-sm text-neutral-500">{scenario.problem}</p>

          <div className="mt-5 space-y-5">
            {scenario.questions.map((q, i) => (
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
            disabled={Object.keys(answers).length < scenario.questions.length}
            onClick={() => setStage("result")}
          >
            {Object.keys(answers).length < scenario.questions.length
              ? "Answer to continue"
              : "Show me the estimate"}
          </Button>
        </div>
      )}

      {stage === "result" && scenario && (
        <div className="p-5">
          <p className="text-xs font-medium text-neutral-400">Your estimate</p>
          <p className="num mt-2 text-4xl font-semibold tracking-tight text-neutral-900">
            {money(scenario.totalLow, "USD")} – {money(scenario.totalHigh, "USD")}
          </p>
          <p className="mt-1.5 text-sm text-neutral-500">
            Firm once we see it in person. If it comes in under, you pay the under.
          </p>

          <div className="mt-5 rounded-2xl border border-neutral-100 bg-neutral-50 p-4">
            <p className="text-xs font-medium text-neutral-400">What we found</p>
            <p className="mt-2 text-sm leading-relaxed text-neutral-700">{scenario.diagnosis}</p>
          </div>

          <ul className="mt-5 divide-y divide-neutral-100 overflow-hidden rounded-2xl border border-neutral-100">
            {scenario.lineItems.map((i) => (
              <li key={i.description} className="flex items-start justify-between gap-4 px-4 py-3">
                <span>
                  <span className="block text-sm font-medium text-neutral-900">{i.description}</span>
                  <span className="block text-xs text-neutral-400">{i.detail}</span>
                </span>
                <span className="num text-sm font-semibold text-neutral-900">{money(i.amount, "USD")}</span>
              </li>
            ))}
          </ul>

          <Button variant="outline" size="lg" className="mt-5 rounded-full border-neutral-200" onClick={reset}>
            Try another sample
          </Button>
        </div>
      )}
    </div>
  );
}
