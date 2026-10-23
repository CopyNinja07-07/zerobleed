// Dev helper: measure input-token overhead and latency per lane and system prompt.
import { chat } from "../src/llm.ts";
import { WORKER_SYSTEM } from "../src/broker/contracts.ts";

const contract = JSON.stringify({ task: "T1_EXTRACT", instruction: "Normalise this record.", inputs: { delay_days: "21", breach_date: "2026-09-14" }, allowed_outputs: ["delay_days", "breach_date"], may_request: ["shipments.hub_region"] });
const cases: [string, "fast" | "deep", string][] = [
  ["fast plain", "fast", WORKER_SYSTEM],
  ["fast think-off", "fast", "detailed thinking off\n" + WORKER_SYSTEM],
  ["fast /no_think", "fast", WORKER_SYSTEM + " /no_think"],
  ["deep think-off", "deep", "detailed thinking off\n" + WORKER_SYSTEM],
];
for (const [name, lane, sys] of cases) {
  const r = await chat(lane, sys, contract);
  console.log(name.padEnd(16), `in=${r.usage.input_tokens} out=${r.usage.output_tokens} ${r.ms}ms chars=${sys.length + contract.length} |`, r.text.slice(0, 100).replace(/\n/g, " "));
}
