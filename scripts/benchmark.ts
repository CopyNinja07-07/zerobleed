// Runs every case of a domain through ZeroBleed and through the shared-history
// baseline, checks each decision against the known answer, and writes the
// measured results to evidence/benchmark-<domain>.{md,json}.
// Usage: npm run benchmark -- [domain] [runs-per-case]     e.g. npm run benchmark -- incident 3
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { runAudit } from "../src/broker/broker.ts";
import { runBaseline } from "../src/baseline.ts";
import { startDataServer } from "../src/dataServer.ts";
import { getDomain } from "../src/domains/index.ts";
import type { BenchmarkCase } from "../src/domains/types.ts";

const domain = getDomain(process.argv[2] ?? "procurement");
const RUNS = Number(process.argv[3] ?? 1);
const server = await startDataServer().catch(() => undefined);

const norm = (v: unknown) => {
  const s = String(v ?? "").trim().toUpperCase();
  return /^-?\d+(\.\d+)?$/.test(s) ? String(Math.round(Number(s))) : s;
};
const correct = (d: Record<string, string> | undefined, c: BenchmarkCase) =>
  !!d && norm(d.decision) === c.expect && norm(d[domain.valueKey]) === norm(c.value);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

// Nightshift held 50 GB once on this 16 GB Mac. Stop before that happens again.
function nightshiftGb(): number {
  try {
    const out = execFileSync("ps", ["-axo", "rss,command"], { encoding: "utf8" });
    return out.split("\n").filter((l) => /Nightshift\.app/.test(l)).reduce((s, l) => s + Number(l.trim().split(/\s+/)[0] || 0), 0) / 1048576;
  } catch {
    return 0;
  }
}
const MAX_NIGHTSHIFT_GB = Number(process.env.MAX_NIGHTSHIFT_GB ?? 6);

const evidenceDir = `evidence/runs/${domain.id}`;
mkdirSync(evidenceDir, { recursive: true });
const rows: any[] = [];
for (const c of domain.cases) {
  for (let r = 1; r <= RUNS; r++) {
    const gb = nightshiftGb();
    if (gb > MAX_NIGHTSHIFT_GB) {
      console.error(`Stopping: Nightshift is using ${gb.toFixed(1)} GB (limit ${MAX_NIGHTSHIFT_GB} GB). Restart Nightshift and re-run.`);
      process.exit(3);
    }
    const runId = `${c.id}-r${r}`;
    const zb = await runAudit({ id: c.id, domain: domain.id }, { quiet: true, runId });
    renameSync(zb.traceFile, `${evidenceDir}/${runId}.trace.jsonl`);
    const base = await runBaseline(c.id, domain.id);
    // Every model call, with the Nightshift receipt that proves it happened.
    writeFileSync(`${evidenceDir}/${runId}.calls.json`, JSON.stringify({
      case: c.id, run: r,
      zerobleed: { decision: zb.decision, calls: zb.ledger, evidence: zb.citations, markovian: { chunks: zb.run.chunks.length, status: zb.run.status, reflection: zb.run.reflection } },
      baseline: { decision: base.decision, calls: base.turns, error: base.error },
    }, null, 2));
    const row = {
      case: c.id,
      scenario: c.what,
      run: r,
      zerobleed: {
        decision: zb.decision?.decision,
        value: zb.decision?.[domain.valueKey],
        correct: correct(zb.decision, c),
        humanReview: zb.needsHumanReview,
        inputTokens: zb.totals.inputTokens,
        outputTokens: zb.totals.outputTokens,
        calls: zb.totals.llmCalls,
        largestCallInput: Math.max(...zb.ledger.map((e) => e.inputTokens)),
        seconds: +(zb.totals.ms / 1000).toFixed(1),
        interrupts: zb.events.filter((e) => e.startsWith("Gate:")).length,
        escalations: zb.events.filter((e) => e.includes("Escalating")).length,
        trace: `${evidenceDir}/${runId}.trace.jsonl`,
      },
      baseline: {
        decision: base.decision?.decision,
        value: base.decision?.[domain.valueKey],
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
    console.log(JSON.stringify(row), `nightshift ${nightshiftGb().toFixed(1)} GB`);
  }
}

const n = rows.length;
const side = (k: "zerobleed" | "baseline") => ({
  correct: rows.filter((r) => r[k].correct).length,
  inputTokens: rows.reduce((s, r) => s + r[k].inputTokens, 0),
  outputTokens: rows.reduce((s, r) => s + r[k].outputTokens, 0),
  largestCallInput: Math.max(...rows.map((r) => r[k].largestCallInput)),
  medianSeconds: median(rows.map((r) => r[k].seconds)),
});
const summary = {
  domain: domain.id,
  date: new Date().toISOString(),
  machine: "MacBook Air (Apple M5, 16 GB), Zetaris 2.4.3.1 in Docker, Meterless Nightshift Mac M5+",
  models: { fast: "nvidia/nemotron-3.5-lightning-30b-a3b", deep: "nvidia/nemotron-3-ultra-550b-a55b" },
  tokenSource: "measured: usage reported by Nightshift for every call",
  runs: n,
  zerobleed: side("zerobleed"),
  baseline: side("baseline"),
};
const saved = 1 - summary.zerobleed.inputTokens / Math.max(1, summary.baseline.inputTokens);
const show = (r: any, k: string) => `${r[k].decision ?? "none"} ${r[k].value ?? "-"} (${r[k].correct ? "correct" : "WRONG"})${r[k].error ? ` error: ${String(r[k].error).slice(0, 60)}` : ""}`;

const md = [
  `# ZeroBleed benchmark: ${domain.title}`,
  ``,
  `Measured on ${summary.date.slice(0, 10)}. ${summary.machine}. Fast lane ${summary.models.fast}, deep lane ${summary.models.deep}.`,
  `Token counts are ${summary.tokenSource}. Failures stay in the denominator. ${RUNS} run(s) per case.`,
  ``,
  `| | ZeroBleed | Shared-history baseline |`,
  `|---|---|---|`,
  `| Correct decisions | ${summary.zerobleed.correct} / ${n} | ${summary.baseline.correct} / ${n} |`,
  `| Input tokens, total | ${summary.zerobleed.inputTokens.toLocaleString("en-US")} | ${summary.baseline.inputTokens.toLocaleString("en-US")} |`,
  `| Largest single prompt | ${summary.zerobleed.largestCallInput.toLocaleString("en-US")} | ${summary.baseline.largestCallInput.toLocaleString("en-US")} |`,
  `| Output tokens, total | ${summary.zerobleed.outputTokens.toLocaleString("en-US")} | ${summary.baseline.outputTokens.toLocaleString("en-US")} |`,
  `| Median wall time per case | ${summary.zerobleed.medianSeconds}s | ${summary.baseline.medianSeconds}s |`,
  ``,
  `ZeroBleed used ${(saved * 100).toFixed(1)}% fewer input tokens than the baseline.`,
  ``,
  `## Per run`,
  ``,
  `| Case | Scenario | Expected | ZeroBleed | ZB input tok | Baseline | Base input tok |`,
  `|---|---|---|---|---|---|---|`,
  ...rows.map((r) => {
    const c = domain.cases.find((x) => x.id === r.case)!;
    return `| ${r.case} | ${r.scenario} | ${c.expect} ${c.value} | ${show(r, "zerobleed")} | ${r.zerobleed.inputTokens} | ${show(r, "baseline")} | ${r.baseline.inputTokens} |`;
  }),
  ``,
].join("\n");

mkdirSync("evidence", { recursive: true });
writeFileSync(`evidence/benchmark-${domain.id}.json`, JSON.stringify({ summary, rows }, null, 2));
writeFileSync(`evidence/benchmark-${domain.id}.md`, md);
console.log("\n" + md);
server?.close();
