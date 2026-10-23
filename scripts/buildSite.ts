// Builds site/: the ZeroBleed Auditor as a static page for GitHub Pages.
// Each case is replayed from recorded live responses (SAMPLE_MODE), and the
// shared-history comparison comes from the verified benchmark run in
// evidence/runs/. Nothing here calls a model. Usage: npm run build:site
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runAudit, showValue } from "../src/broker/broker.ts";
import { DOMAINS } from "../src/domains/index.ts";
import { isSampleMode } from "../src/replay.ts";
import { query } from "../src/zetaris.ts";

if (!isSampleMode()) throw new Error("run with SAMPLE_MODE=true (npm run build:site does this)");
mkdirSync("site/data", { recursive: true });

// The dashboard, switched into replay mode.
const html = readFileSync("web/index.html", "utf8").replace("<script>", "<script>window.ZB_STATIC = true;</script>\n<script>");
writeFileSync("site/index.html", html);
writeFileSync("site/.nojekyll", "");
if (existsSync("docs/screenshots/dashboard-ALR-2004.png")) copyFileSync("docs/screenshots/dashboard-ALR-2004.png", "site/preview.png");

const targets: Record<string, { id: string; title: string; detail: string }[]> = {
  procurement: (await query("SELECT shipment_id, vendor_id, hub_region, delay_days, breach_date FROM zerobleed.shipments WHERE delay_days > 5 ORDER BY delay_days DESC")).map((r) => ({
    id: String(r.shipment_id), title: `${r.shipment_id} · ${r.vendor_id}`, detail: `${r.delay_days} days late, ${r.hub_region}, ${r.breach_date ?? ""}`,
  })),
  incident: (await query("SELECT alert_id, service, severity, alert_time, metric FROM incidents.alerts ORDER BY alert_id")).map((r) => ({
    id: String(r.alert_id), title: `${r.alert_id} · ${r.service}`, detail: `${r.severity}, ${r.metric}, ${String(r.alert_time).slice(11, 16)} UTC`,
  })),
};

for (const d of Object.values(DOMAINS)) {
  // Only cases we can replay are listed.
  targets[d.id] = targets[d.id].filter((t) => d.cases.some((c) => c.id === t.id));
  writeFileSync(`site/data/targets-${d.id}.json`, JSON.stringify(targets[d.id]));
  for (const c of d.cases) {
    const events: string[] = [];
    const r = await runAudit({ id: c.id, domain: d.id }, { quiet: true, runId: `site-${c.id}`, onEvent: (e) => events.push(e) });
    const evidence = `evidence/runs/${d.id}/${c.id}-r1.calls.json`;
    let baseline;
    if (existsSync(evidence)) {
      const b = JSON.parse(readFileSync(evidence, "utf8")).baseline;
      const sum = (k: string) => b.calls.reduce((s: number, t: Record<string, number>) => s + (t[k] ?? 0), 0);
      baseline = { decision: b.decision, totals: { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), llmCalls: b.calls.length, ms: sum("ms") } };
    }
    writeFileSync(`site/data/run-${c.id}.json`, JSON.stringify({
      events,
      baseline,
      result: {
        decision: r.decision,
        valueKey: r.valueKey,
        valueText: showValue(d, r.decision?.[r.valueKey]),
        needsHumanReview: r.needsHumanReview,
        reviewReasons: r.reviewReasons,
        citations: r.citations,
        ledger: r.ledger,
        totals: r.totals,
        chunks: r.run.chunks.map((ch) => ({ id: ch.id, carryover: ch.carryover, content: ch.content, tool: ch.toolCall })),
        reflection: r.run.reflection,
      },
    }));
    console.log(`site/data/run-${c.id}.json: ${r.decision?.decision} (${events.length} steps)`);
  }
}
console.log("built site/ (open site/index.html through a local server, or publish with GitHub Pages)");
