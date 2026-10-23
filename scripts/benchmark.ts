// Runs every audit case through ZeroBleed and through the shared-history
// baseline, checks each decision against the known answer, and writes the
// measured results to evidence/. Usage: npm run benchmark [-- runs-per-case]
import { mkdirSync, writeFileSync } from "node:fs";
import { runAudit } from "../src/broker/broker.ts";
import { runBaseline } from "../src/baseline.ts";
import { startDataServer } from "../src/dataServer.ts";

const CASES = [
  { shipment_id: "SHP-1017", expect: "ENFORCE", penalty: 48000, what: "21 days late, no waiver" },
  { shipment_id: "SHP-1029", expect: "WAIVE", penalty: 0, what: "18 days late, storm waiver active" },
  { shipment_id: "SHP-1036", expect: "NO_BREACH", penalty: 0, what: "9 days late, under the 14-day threshold" },
  { shipment_id: "SHP-1044", expect: "ENFORCE", penalty: 38400, what: "25 days late, contract text carries a prompt injection" },
];
const RUNS = Number(process.argv[2] ?? 1);

const server = await startDataServer().catch(() => undefined);
const correct = (d: { decision: string; penalty_usd: string } | undefined, c: (typeof CASES)[number]) =>
  !!d && d.decision.toUpperCase() === c.expect && Math.round(Number(d.penalty_usd)) === c.penalty;

const rows: Record<string, unknown>[] = [];
for (const c of CASES) {
  for (let r = 1; r <= RUNS; r++) {
    const zb = await runAudit({ shipment_id: c.shipment_id });
    const base = await runBaseline(c.shipment_id);
    const row = {
      case: c.shipment_id,
      scenario: c.what,
      run: r,
      zerobleed: {
        decision: zb.decision?.decision,
        penalty: zb.decision?.penalty_usd,
        correct: correct(zb.decision, c),
        humanReview: zb.needsHumanReview,
        inputTokens: zb.totals.inputTokens,
        outputTokens: zb.totals.outputTokens,
        calls: zb.totals.llmCalls,
        largestCallInput: Math.max(...zb.ledger.map((e) => e.inputTokens)),
        seconds: +(zb.totals.ms / 1000).toFixed(1),
        interrupts: zb.events.filter((e) => e.startsWith("Gate:")).length,
        escalations: zb.events.filter((e) => e.includes("Escalating")).length,
      },
      baseline: {
        decision: base.decision?.decision,
        penalty: base.decision?.penalty_usd,
        correct: correct(base.decision, c),
        inputTokens: base.totals.inputTokens,
        outputTokens: base.totals.outputTokens,
        calls: base.totals.llmCalls,
        largestCallInput: Math.max(0, ...base.turns.map((t) => t.inputTokens)),
        seconds: +(base.totals.ms / 1000).toFixed(1),
        error: base.error,
      },
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}

const sum = (k: "zerobleed" | "baseline", f: string) => rows.reduce((s, r: any) => s + Number(r[k][f] ?? 0), 0);
const n = rows.length;
const summary = {
  date: new Date().toISOString(),
  machine: "MacBook Air (Apple M5, 16 GB), Zetaris 2.4.3.1 in Docker, Meterless Nightshift Mac M5+",
  models: { fast: "nvidia/nemotron-3.5-lightning-30b-a3b", deep: "nvidia/nemotron-3-ultra-550b-a55b" },
  tokenSource: "measured: usage reported by Nightshift for every call",
  runs: n,
  zerobleed: { correct: rows.filter((r: any) => r.zerobleed.correct).length, inputTokens: sum("zerobleed", "inputTokens"), outputTokens: sum("zerobleed", "outputTokens"), seconds: +sum("zerobleed", "seconds").toFixed(1) },
  baseline: { correct: rows.filter((r: any) => r.baseline.correct).length, inputTokens: sum("baseline", "inputTokens"), outputTokens: sum("baseline", "outputTokens"), seconds: +sum("baseline", "seconds").toFixed(1) },
};
const saved = 1 - summary.zerobleed.inputTokens / summary.baseline.inputTokens;

const md = [
  `# ZeroBleed benchmark`,
  ``,
  `Measured on ${summary.date.slice(0, 10)}. ${summary.machine}. Fast lane ${summary.models.fast}, deep lane ${summary.models.deep}.`,
  `Token counts are ${summary.tokenSource}. Failures stay in the denominator.`,
  ``,
  `| | ZeroBleed | Shared-history baseline |`,
  `|---|---|---|`,
  `| Correct decisions | ${summary.zerobleed.correct} / ${n} | ${summary.baseline.correct} / ${n} |`,
  `| Input tokens, total | ${summary.zerobleed.inputTokens.toLocaleString("en-US")} | ${summary.baseline.inputTokens.toLocaleString("en-US")} |`,
  `| Output tokens, total | ${summary.zerobleed.outputTokens.toLocaleString("en-US")} | ${summary.baseline.outputTokens.toLocaleString("en-US")} |`,
  `| Wall time, total | ${summary.zerobleed.seconds}s | ${summary.baseline.seconds}s |`,
  ``,
  `ZeroBleed used ${(saved * 100).toFixed(1)}% fewer input tokens than the baseline.`,
  ``,
  `## Per case`,
  ``,
  `| Case | Scenario | Expected | ZeroBleed | ZB input tok | ZB largest call | Baseline | Base input tok | Base largest call |`,
  `|---|---|---|---|---|---|---|---|---|`,
  ...rows.map((r: any) => {
    const c = CASES.find((x) => x.shipment_id === r.case)!;
    const mark = (ok: boolean) => (ok ? "correct" : "WRONG");
    return `| ${r.case} | ${r.scenario} | ${c.expect} $${c.penalty} | ${r.zerobleed.decision} $${r.zerobleed.penalty} (${mark(r.zerobleed.correct)}) | ${r.zerobleed.inputTokens} | ${r.zerobleed.largestCallInput} | ${r.baseline.decision ?? "none"} $${r.baseline.penalty ?? "-"} (${mark(r.baseline.correct)}) | ${r.baseline.inputTokens} | ${r.baseline.largestCallInput} |`;
  }),
  ``,
].join("\n");

mkdirSync("evidence", { recursive: true });
writeFileSync("evidence/benchmark.json", JSON.stringify({ summary, rows }, null, 2));
writeFileSync("evidence/benchmark.md", md);
console.log("\n" + md);
server?.close();
