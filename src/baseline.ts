// The comparison: a conventional shared-history agent pipeline. Same models,
// same Zetaris data, same question. The difference is the architecture: every
// raw row goes into one conversation that every later turn re-reads.
import { chatMessages, type ChatResult, type Lane, type Message } from "./llm.ts";
import { query } from "./zetaris.ts";

export interface BaselineResult {
  decision?: { decision: string; penalty_usd: string; rationale: string };
  turns: { turn: string; lane: Lane; inputTokens: number; outputTokens: number; ms: number }[];
  totals: { inputTokens: number; outputTokens: number; llmCalls: number; ms: number };
  error?: string;
}

export async function runBaseline(shipment_id: string): Promise<BaselineResult> {
  const started = Date.now();
  const [shipments, contracts, weather] = await Promise.all([
    query("SELECT * FROM zerobleed.shipments"),
    query("SELECT * FROM zerobleed.contracts"),
    query("SELECT * FROM zerobleed.force_majeure"),
  ]);
  const history: Message[] = [
    { role: "system", content: "You are a team of audit agents sharing one conversation. Answer each request briefly." },
    {
      role: "user",
      content:
        `Here is all the data for the audit.\nSHIPMENTS: ${JSON.stringify(shipments)}\nCONTRACTS: ${JSON.stringify(contracts)}\n` +
        `FORCE_MAJEURE_LOGS: ${JSON.stringify(weather)}\nAcknowledge in one line.`,
    },
  ];
  const steps: [string, Lane, string][] = [
    ["LOAD", "fast", ""],
    ["EXTRACT", "fast", `Extract the delay_days, breach_date, hub_region and vendor_id for shipment ${shipment_id}.`],
    ["CRITIQUE", "fast", "Find that vendor's contract clause and say whether its penalty applies to this delay."],
    ["WEATHER", "fast", "Check the force majeure log for that date and region. Was a waiver active?"],
    [
      "DECIDE",
      "deep",
      'Give the final decision as one JSON object: {"decision": "ENFORCE"|"WAIVE"|"NO_BREACH", "penalty_usd": number, "rationale": "one sentence"}.',
    ],
  ];
  const turns: BaselineResult["turns"] = [];
  let last: ChatResult | undefined;
  try {
    for (const [turn, lane, ask] of steps) {
      if (ask) history.push({ role: "user", content: ask });
      last = await chatMessages(lane, history, { maxTokens: 1200 });
      history.push({ role: "assistant", content: last.text });
      turns.push({ turn, lane, inputTokens: last.usage.input_tokens, outputTokens: last.usage.output_tokens, ms: last.ms });
    }
  } catch (err) {
    return { turns, totals: totalsOf(turns, started), error: (err as Error).message.slice(0, 300) };
  }
  let decision: BaselineResult["decision"];
  try {
    const t = last!.text;
    const o = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    decision = { decision: String(o.decision), penalty_usd: String(o.penalty_usd), rationale: String(o.rationale) };
  } catch {
    decision = undefined;
  }
  return { decision, turns, totals: totalsOf(turns, started) };
}

function totalsOf(turns: BaselineResult["turns"], started: number) {
  return {
    inputTokens: turns.reduce((s, t) => s + t.inputTokens, 0),
    outputTokens: turns.reduce((s, t) => s + t.outputTokens, 0),
    llmCalls: turns.length,
    ms: Date.now() - started,
  };
}
