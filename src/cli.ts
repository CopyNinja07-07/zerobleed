// Command line: run one ZeroBleed audit and print the decision, the evidence
// trail and the token ledger. Usage: npm run audit -- SHP-1017   (or ALR-2001)
import { mkdirSync, writeFileSync } from "node:fs";
import { runAudit, showValue } from "./broker/broker.ts";
import { domainForId } from "./domains/index.ts";
import { startDataServer } from "./dataServer.ts";
import { SAMPLE_MODE } from "./replay.ts";

const id = process.argv[2] ?? "SHP-1017";
const domain = domainForId(id);
const server = await startDataServer().catch(() => undefined); // already running is fine

console.log(`\nZeroBleed ${domain.title.toLowerCase()}: ${id}${SAMPLE_MODE ? "  [SAMPLE_MODE: replaying recorded Zetaris and Nightshift responses]" : ""}\n`);
const result = await runAudit({ id, domain: domain.id }, { onEvent: (e) => console.log(`  - ${e}`), historyDir: ".zerobleed" });

console.log(`\nDecision: ${result.decision?.decision ?? "none"}  ${result.valueKey} ${showValue(domain, result.decision?.[result.valueKey])}`);
console.log(`Rationale: ${result.decision?.rationale ?? "-"}`);
console.log(`Human review needed: ${result.needsHumanReview ? "YES: " + result.reviewReasons.join(" | ") : "no"}`);
console.log(`\nEvidence (every fact traces to one Zetaris query):`);
for (const c of result.citations) console.log(`  ${c.fact} = ${c.value}   <- ${c.sql}`);
console.log(`\nToken ledger (measured by Nightshift):`);
for (const e of result.ledger) console.log(`  ${e.task.padEnd(12)} ${e.model.padEnd(40)} in ${String(e.inputTokens).padStart(5)}  out ${String(e.outputTokens).padStart(5)}  ${String(e.ms).padStart(6)}ms  ${e.outcome}`);
console.log(`  TOTAL input ${result.totals.inputTokens}, output ${result.totals.outputTokens}, ${result.totals.llmCalls} calls, ${(result.totals.ms / 1000).toFixed(1)}s`);
console.log(`\nMarkovian run: ${result.run.chunks.length} chunks, status ${result.run.status}, largest carryover ${Math.max(...result.run.chunks.map((c) => c.carryover.length))} chars`);

mkdirSync("runs", { recursive: true });
const file = `runs/${id}-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(result, null, 2));
console.log(`Saved ${file}`);
server?.close();
