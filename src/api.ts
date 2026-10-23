// Programmatic entry point for judges: POST /run takes JSON and returns JSON.
//
//   curl -X POST http://localhost:8000/run -H "Content-Type: application/json" \
//        -d @input_examples/example_1.json
//
// Errors come back as structured JSON, never as a silent crash.
import type { IncomingMessage, ServerResponse } from "node:http";
import { runAudit } from "./broker/broker.ts";
import { runBaseline } from "./baseline.ts";
import { withSampleMode } from "./replay.ts";
import { DOMAINS } from "./domains/index.ts";

export interface RunRequest {
  run_id?: string;
  // One target id: shipment_id (procurement), alert_id (incident), or id plus domain.
  input: { shipment_id?: string; alert_id?: string; id?: string; domain?: string };
  options?: { sample_mode?: boolean; compare_baseline?: boolean };
}

export const AGENTS = [
  { name: "Planner", model: "Nemotron 3 Ultra", role: "Plans the audit from Zetaris column names only (no rows)" },
  { name: "Broker", model: "plain code", role: "Writes need-to-know micro-contracts, gates every request for a missing fact, cross-checks the critic" },
  { name: "Extractor", model: "Nemotron 3.5 Lightning", role: "Normalises the delivery facts for one shipment" },
  { name: "Critic", model: "Nemotron 3.5 Lightning, escalates to Ultra", role: "Applies the contract clause; asks for a missing fact instead of guessing" },
  { name: "Strategist", model: "Nemotron 3 Ultra", role: "Decides ENFORCE, WAIVE or NO_BREACH from verified facts only" },
  { name: "Reviewer", model: "Nemotron 3.5 Lightning", role: "Markovian reflection pass: ratifies or questions the decision" },
];

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

export async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  let body: RunRequest | undefined;
  const send = (code: number, payload: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(payload, null, 2));
  };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return send(400, { status: "error", error: { type: "BadRequest", message: "Body must be JSON", recoverable: true } });
  }
  const id = body?.input?.shipment_id ?? body?.input?.alert_id ?? body?.input?.id ?? "";
  const domain = Object.values(DOMAINS).find((d) => d.targetPattern.test(id));
  if (!domain || (body?.input?.domain && body.input.domain !== domain.id)) {
    return send(400, { status: "error", error: { type: "BadRequest", message: "input needs shipment_id like SHP-1017 or alert_id like ALR-2001", recoverable: true } });
  }
  const run_id = body!.run_id && /^[\w-]{1,64}$/.test(body!.run_id) ? body!.run_id : `${id}-${started}`;
  try {
    const result = await withSampleMode(body!.options?.sample_mode, () => runAudit({ id, domain: domain.id }, { runId: run_id, historyDir: ".zerobleed" }));
    const baseline = body!.options?.compare_baseline ? await withSampleMode(body!.options?.sample_mode, () => runBaseline(id, domain.id)) : undefined;
    send(200, {
      run_id,
      status: result.decision && !result.needsHumanReview ? "success" : "needs_review",
      domain: domain.id,
      output: {
        decision: result.decision?.decision,
        [domain.valueKey]: result.decision?.[domain.valueKey],
        rationale: result.decision?.rationale,
        needs_human_review: result.needsHumanReview,
        review_reasons: result.reviewReasons,
        independent_check: result.run.reflection,
        evidence: result.citations,
        steps: result.events,
      },
      agents: AGENTS,
      models: result.ledger.map((e) => ({ step: e.task, model: e.model, input_tokens: e.inputTokens, output_tokens: e.outputTokens, nightshift_receipt: e.receiptId })),
      markovian: {
        chunks: result.run.chunks.length,
        status: result.run.status,
        largest_carryover_chars: Math.max(...result.run.chunks.map((c) => c.carryover.length)),
      },
      tokens: { input: result.totals.inputTokens, output: result.totals.outputTokens, calls: result.totals.llmCalls },
      baseline: baseline && { decision: baseline.decision, tokens: { input: baseline.totals.inputTokens, output: baseline.totals.outputTokens } },
      trace_id: `trace-${run_id}`,
      log_file: result.traceFile,
      execution_time_seconds: +((Date.now() - started) / 1000).toFixed(1),
    });
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    send(502, {
      run_id,
      status: "error",
      error: { type: /SAMPLE_MODE/.test(message) ? "NoRecording" : "UpstreamError", message, recoverable: true },
      trace_id: `trace-${run_id}`,
      execution_time_seconds: +((Date.now() - started) / 1000).toFixed(1),
    });
  }
}
