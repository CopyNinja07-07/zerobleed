// N = 400 benchmark runner (docs/BENCHMARK_PROTOCOL.md). Runs every selected
// framework on every selected case and appends one JSON line per run to
// evidence/bench/<domain>.jsonl. Resumable: a (case, framework, run) already
// in the file is skipped, so a stopped batch just continues.
//
// Usage: npm run bench -- --domain procurement-bench --frameworks zerobleed,shared --limit 10
//   --domain      procurement-bench | incident-bench
//   --frameworks  zerobleed, zerobleed-batch, shared, summary, guard, dual, react (comma list)
//   --limit N     at most N cases this batch (cases are interleaved across splits)
//   --splits a,b  only these splits (breach, waiver, below, injection / adversary, config, hardware, chameleon)
//   --runs N      repeats per case (default 1)
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { runAudit } from "../src/broker/broker.ts";
import { attackSucceeded, type BenchCase } from "../src/bench/domains.ts";
import { runFramework, type Framework } from "../src/bench/baselines.ts";
import { startDataServer } from "../src/dataServer.ts";
import { getDomain } from "../src/domains/index.ts";
import { STRICT_LIVE } from "../src/replay.ts";

// Every call must be live: no recordings used or written. npm run bench sets STRICT_LIVE=true.
if (!STRICT_LIVE) throw new Error("benchmark runs must be strict live: use npm run bench (sets STRICT_LIVE=true)");

const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const domain = getDomain(arg("domain", "procurement-bench"));
const cases = domain.cases as BenchCase[];
if (!cases.length) throw new Error(`no cases for ${domain.id}: run npm run bench:data first`);
const FRAMEWORKS = arg("frameworks", "zerobleed,shared")!.split(",");
const LIMIT = Number(arg("limit", "100000"));
const RUNS = Number(arg("runs", "1"));
const SPLITS = arg("splits")?.split(",");
const KNOWN = ["zerobleed", "zerobleed-batch", "shared", "summary", "guard", "dual", "react"];
for (const f of FRAMEWORKS) if (!KNOWN.includes(f)) throw new Error(`unknown framework ${f} (known: ${KNOWN.join(", ")})`);

const server = await startDataServer().catch(() => undefined);
const outDir = "evidence/bench";
const traceDir = `${outDir}/traces/${domain.id}`;
mkdirSync(traceDir, { recursive: true });
const outFile = `${outDir}/${domain.id}.jsonl`;
const done = new Set(
  existsSync(outFile) ? readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.case}|${r.framework}|${r.run}`; }) : []
);

// Interleave the splits so any prefix of the order is balanced.
const bySplit = new Map<string, BenchCase[]>();
for (const c of cases) if (!SPLITS || SPLITS.includes(c.split)) bySplit.set(c.split, [...(bySplit.get(c.split) ?? []), c]);
const order: BenchCase[] = [];
for (let i = 0; order.length < [...bySplit.values()].reduce((s, x) => s + x.length, 0); i++) for (const xs of bySplit.values()) if (xs[i]) order.push(xs[i]);

const norm = (v: unknown) => {
  const s = String(v ?? "").trim().toUpperCase().replace(/[$,]/g, "");
  return /^-?\d+(\.\d+)?$/.test(s) ? String(Math.round(Number(s))) : s;
};
const correct = (d: Record<string, string> | undefined, c: BenchCase) => !!d && norm(d.decision) === c.expect && norm(d[domain.valueKey]) === norm(c.value);

// Nightshift once held 50 GB on this 16 GB Mac. Stop before that happens again.
function nightshiftGb(): number {
  try {
    const out = execFileSync("ps", ["-axo", "rss,command"], { encoding: "utf8" });
    return out.split("\n").filter((l) => /Nightshift\.app/.test(l)).reduce((s, l) => s + Number(l.trim().split(/\s+/)[0] || 0), 0) / 1048576;
  } catch {
    return 0;
  }
}
const MAX_NIGHTSHIFT_GB = Number(process.env.MAX_NIGHTSHIFT_GB ?? 6);

const INFRA = /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|ETIMEDOUT|aborted due to timeout|Zetaris 5\d\d|Nightshift (429|5\d\d)|Connection refused/i;
let ran = 0, picked = 0, infraFailures = 0;
for (const c of order) {
  if (picked >= LIMIT) break;
  const todo = FRAMEWORKS.flatMap((f) => Array.from({ length: RUNS }, (_, i) => [f, i + 1] as const)).filter(([f, r]) => !done.has(`${c.id}|${f}|${r}`));
  if (!todo.length) continue;
  picked++;
  for (const [f, r] of todo) {
    const gb = nightshiftGb();
    if (gb > MAX_NIGHTSHIFT_GB) {
      console.error(`Stopping: Nightshift is using ${gb.toFixed(1)} GB (limit ${MAX_NIGHTSHIFT_GB} GB). Restart Nightshift and re-run; finished runs are kept.`);
      process.exit(3);
    }
    const base = { case: c.id, split: c.split, adversarial: c.adversarial, attack: c.attack?.template, framework: f, run: r, expect: c.expect, value: c.value, at: new Date().toISOString() };
    let row: Record<string, unknown>;
    if (f === "zerobleed" || f === "zerobleed-batch") {
      const runId = `${c.id}-${f}-r${r}`;
      try {
        const zb = await runAudit({ id: c.id, domain: domain.id }, { quiet: true, runId, speculative: f === "zerobleed-batch" });
        renameSync(zb.traceFile, `${traceDir}/${runId}.trace.jsonl`);
        const requests = zb.events.filter((e) => e.startsWith("Gate:"));
        row = {
          ...base,
          decision: zb.decision?.decision, valueOut: zb.decision?.[domain.valueKey],
          correct: correct(zb.decision, c), attackSuccess: c.adversarial ? attackSucceeded(domain.id, zb.decision) : undefined,
          humanReview: zb.needsHumanReview, reviewReasons: zb.reviewReasons,
          inputTokens: zb.totals.inputTokens, outputTokens: zb.totals.outputTokens, calls: zb.totals.llmCalls,
          deepInputTokens: zb.ledger.filter((e) => e.lane === "deep").reduce((s, e) => s + e.inputTokens, 0),
          peakInput: Math.max(0, ...zb.ledger.map((e) => e.inputTokens)),
          seconds: +(zb.totals.ms / 1000).toFixed(2),
          modelRequests: requests.length, deniedRequests: requests.filter((e) => e.includes("DENIED")).length,
          planSource: zb.plan?.source,
          ledger: zb.ledger.map((e) => ({ task: e.task, lane: e.lane, model: e.model, in: e.inputTokens, out: e.outputTokens, ms: e.ms, receipt: e.receiptId, outcome: e.outcome })),
          trace: `${traceDir}/${runId}.trace.jsonl`,
        };
      } catch (err) {
        row = { ...base, correct: false, attackSuccess: c.adversarial ? false : undefined, error: (err as Error).message.slice(0, 300), inputTokens: 0, outputTokens: 0, calls: 0, peakInput: 0, seconds: 0 };
      }
    } else {
      const res = await runFramework(f as Framework, domain.id, c.id);
      row = {
        ...base,
        decision: res.decision?.decision, valueOut: res.decision?.[domain.valueKey],
        correct: correct(res.decision, c), attackSuccess: c.adversarial ? attackSucceeded(domain.id, res.decision) : undefined,
        blocked: res.blocked, error: res.error,
        inputTokens: res.totals.inputTokens, outputTokens: res.totals.outputTokens, calls: res.totals.llmCalls,
        deepInputTokens: res.turns.filter((t) => t.lane === "deep").reduce((s, t) => s + t.inputTokens, 0),
        peakInput: Math.max(0, ...res.turns.map((t) => t.inputTokens)),
        seconds: +(res.totals.ms / 1000).toFixed(2),
        modelRequests: res.reads?.length, deniedRequests: res.reads ? res.reads.filter((x) => x.outOfScope > 0).length : undefined,
        reads: res.reads,
        ledger: res.turns.map((t) => ({ task: t.turn, lane: t.lane, model: t.model, in: t.inputTokens, out: t.outputTokens, ms: t.ms, receipt: t.receiptId })),
      };
    }
    // An outage (Zetaris or Nightshift unreachable, gateway errors, rate limits)
    // is not a result: leave the run unrecorded so the next pass retries it.
    const why = [row.error, ...((row.reviewReasons as string[] | undefined) ?? [])].filter(Boolean).join(" ");
    if (INFRA.test(why)) {
      infraFailures++;
      console.log(`${c.id} ${f}: infrastructure error, not recorded, will retry: ${why.slice(0, 120)}`);
      if (infraFailures >= 5) {
        console.error("Stopping: 5 infrastructure errors in this batch. Check Zetaris, Nightshift and the data server, then re-run.");
        process.exit(4);
      }
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    appendFileSync(outFile, JSON.stringify(row) + "\n");
    ran++;
    console.log(`${c.id} ${c.split.padEnd(9)} ${f.padEnd(15)} ${row.correct ? "correct" : "WRONG  "} ${String(row.decision ?? row.error ?? "-").slice(0, 40).padEnd(40)} ${String(row.inputTokens).padStart(7)} tok ${String(row.seconds).padStart(6)}s  nightshift ${nightshiftGb().toFixed(1)} GB`);
  }
}
console.log(`\n${ran} run(s) added to ${outFile}. Make the tables with: npm run bench:report`);
server?.close();
