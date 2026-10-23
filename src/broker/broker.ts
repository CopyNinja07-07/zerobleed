// The ZeroBleed Context Broker, running as a Markovian chain.
//
// Each Markovian chunk is one step of the audit: chunk 1 plans from the schema,
// then one chunk per micro-contract. The engine's carryover IS the distilled
// fact scratchpad, so no step ever sees the history of earlier steps. When a
// worker needs a fact it was not given, its chunk ends with a NEEDS_TOOL pause;
// the broker checks the request against the catalog enum, fetches that single
// cell from Zetaris, and the engine injects it into the next chunk.
import { Markovian, type MarkovianRun } from "../engines/markovian/index.ts";
import type { ChatResult, Lane } from "../llm.ts";
import { chat } from "../llm.ts";
import { loadCatalog, project, rowScope, type Catalog, type Table } from "./catalog.ts";
import { dispatch, TASK_SPECS, type MicroContract } from "./contracts.ts";
import { plan as makePlan, type Plan, type PlannedTask } from "./planner.ts";
import { carryoverFromPrompt, readScratchpad, toolResultFromPrompt, writeScratchpad, type Scratchpad } from "./scratchpad.ts";

export const MAX_RETRIES = 2; // Rmax: interrupts allowed per task

export interface LedgerEntry {
  step: number;
  task: string;
  lane: Lane | "zetaris";
  model: string;
  inputTokens: number;
  outputTokens: number;
  promptChars: number;
  ms: number;
  receiptId?: string;
  outcome: string;
}

export interface Citation {
  fact: string;
  value: string;
  sql: string;
}

export interface AuditTarget {
  shipment_id: string;
}

export interface AuditResult {
  target: AuditTarget;
  goal: string;
  decision?: { decision: string; penalty_usd: string; rationale: string };
  needsHumanReview: boolean;
  reviewReasons: string[];
  plan: Plan;
  facts: Record<string, string>;
  citations: Citation[];
  ledger: LedgerEntry[];
  events: string[];
  run: MarkovianRun;
  totals: { inputTokens: number; outputTokens: number; llmCalls: number; ms: number };
}

const contractText = (k: MicroContract) => JSON.stringify(k);

export async function runAudit(target: AuditTarget, opts: { onEvent?: (e: string) => void; historyDir?: string } = {}): Promise<AuditResult> {
  const started = Date.now();
  const catalog: Catalog = await loadCatalog();
  const goal = `Audit shipment ${target.shipment_id} for an SLA delivery breach and decide if the contract penalty is enforceable.`;
  const ledger: LedgerEntry[] = [];
  const citations: Citation[] = [];
  const events: string[] = [];
  const reviewReasons: string[] = [];
  let decision: AuditResult["decision"];
  let thePlan: Plan | undefined;
  let step = 0;

  const log = (e: string) => {
    events.push(e);
    opts.onEvent?.(e);
  };
  const book = (task: string, lane: Lane, call: ChatResult, promptChars: number, outcome: string) =>
    ledger.push({ step, task, lane, model: call.model, inputTokens: call.usage.input_tokens, outputTokens: call.usage.output_tokens, promptChars, ms: call.ms, receiptId: call.receiptId, outcome });
  const cite = (fact: string, value: string, sql: string) => citations.push({ fact, value, sql });

  // Builds X for a task: planned columns fetched from Zetaris, plus any facts
  // the scratchpad already verified, plus cells injected after an interrupt.
  async function buildInputs(task: PlannedTask, pad: Scratchpad): Promise<Record<string, string>> {
    const inputs: Record<string, string> = {};
    const byTable = new Map<Table, string[]>();
    for (const qc of task.columns) {
      const [t, c] = qc.split(".") as [Table, string];
      if (pad.facts[c] !== undefined) inputs[c] = pad.facts[c];
      else byTable.set(t, [...(byTable.get(t) ?? []), c]);
    }
    for (const [t, cols] of byTable) {
      const p = await project(t, cols, { ...pad.facts, ...pad.context }, catalog);
      Object.assign(inputs, p.values);
      for (const [c, v] of Object.entries(p.values)) cite(`${t}.${c}`, v, p.sql);
      log(`Zetaris: fetched ${cols.length} cell(s) from ${t} for ${task.id}`);
    }
    for (const extra of (pad.context.extra ?? "").split(",").filter(Boolean)) {
      const [t, c] = extra.split(".") as [Table, string];
      if (pad.facts[c] === undefined) continue;
      inputs[c] = pad.facts[c];
      const scope = rowScope(t, { ...pad.facts, ...pad.context });
      if (scope) inputs[`${c}_row`] = `${t} row for ${scope}`;
    }
    // The critic checks the clause against the verified delivery facts.
    if (task.type === "CRITIQUE") {
      for (const f of ["delay_days", "breach_date", "hub_region"]) if (pad.facts[f] !== undefined) inputs[f] = pad.facts[f];
    }
    if (task.type === "DECIDE") Object.assign(inputs, pad.facts);
    return inputs;
  }

  // Deterministic cross-check of the critic, using structured columns the
  // broker reads itself. A mismatch lowers confidence: escalate, then flag.
  async function guardCritique(pad: Scratchpad, outputs: Record<string, string>): Promise<string | undefined> {
    const p = await project("contracts", ["threshold_days", "penalty_usd"], { ...pad.facts, ...pad.context }, catalog);
    for (const [c, v] of Object.entries(p.values)) cite(`contracts.${c}`, v, p.sql);
    let waiver = pad.facts.waiver_declared;
    if (waiver === undefined) {
      const w = await project("force_majeure", ["waiver_declared"], { ...pad.facts, ...pad.context }, catalog);
      waiver = w.values.waiver_declared;
      cite("force_majeure.waiver_declared", waiver, w.sql);
    }
    const shouldApply = Number(pad.facts.delay_days) > Number(p.values.threshold_days) && waiver !== "true";
    const said = /^true$/i.test(outputs.penalty_applicable);
    if (said !== shouldApply) return `critic said penalty_applicable=${said}, structured data implies ${shouldApply}`;
    if (said && Number(outputs.penalty_usd) !== Number(p.values.penalty_usd)) return `critic said penalty_usd=${outputs.penalty_usd}, contract says ${p.values.penalty_usd}`;
    return undefined;
  }

  // One Markovian chunk = one broker step. Returns text in the engine's marker protocol.
  async function generator(prompt: string): Promise<{ text: string; metadata?: unknown }> {
    step += 1;
    const usageBefore = ledger.length;
    const usage = () => {
      const mine = ledger.slice(usageBefore);
      return { usage: { input_tokens: mine.reduce((s, e) => s + e.inputTokens, 0), output_tokens: mine.reduce((s, e) => s + e.outputTokens, 0) } };
    };

    // Reflection pass (engine calls it after completion): an independent critic ratifies.
    if (prompt.startsWith("Reflect on this completed run.")) {
      const state = prompt.match(/Final state: ([\s\S]*?)\nOutput \(truncated\)/)?.[1] ?? "";
      const call = await chat("fast", "You are an audit reviewer. Reply in one short line starting with RATIFY or REFINE.", `Check this decision against the verified facts.\n${state}`);
      book("REFLECT", "fast", call, state.length, call.text.slice(0, 80));
      log(`Reflection: ${call.text.slice(0, 120)}`);
      if (/^REFINE/i.test(call.text.trim())) reviewReasons.push(`reflection: ${call.text.slice(0, 160)}`);
      return { text: call.text, metadata: usage() };
    }

    const carry = carryoverFromPrompt(prompt);
    // Chunk 1: plan from the schema catalog only.
    if (!carry) {
      const { plan: p, call, prompt: planPrompt } = await makePlan(goal, catalog);
      thePlan = p;
      if (call) book("PLAN", "deep", call, planPrompt.length, p.source);
      log(p.source === "planner" ? `Planner (Nemotron Ultra, schema only): ${p.tasks.map((t) => `${t.id}[${t.columns.length} cols]`).join(" -> ")}` : `Planner output unusable (${p.note}); using the fallback plan`);
      if (p.source === "planner" && p.note) log(`Broker: ${p.note}`);
      const pad: Scratchpad = { completed: ["PLAN"], remaining: p.tasks.map((t) => t.id), facts: {}, context: { shipment_id: target.shipment_id } };
      return { text: `Planned ${p.tasks.length} micro-contracts from a ${catalog.enum.length}-column catalog.\n[STATE_CHECKPOINT]\n${writeScratchpad(pad)}`, metadata: usage() };
    }

    const pad = readScratchpad(carry);
    const tool = toolResultFromPrompt(prompt);
    if (tool) {
      // "zetaris_cell(force_majeure.waiver_declared) = false"
      const m = tool.match(/^zetaris_cell\(([\w.]+)\) = (.*)$/);
      if (m && !m[2].startsWith("DENIED")) {
        pad.facts[m[1].split(".")[1]] = m[2];
        pad.context.extra = [...(pad.context.extra ?? "").split(",").filter(Boolean), m[1]].join(",");
      }
    }
    const task = thePlan!.tasks.find((t) => t.id === pad.remaining[0]);
    if (!task) return { text: `Nothing left to do.\n[TASK_COMPLETE]`, metadata: usage() };

    // Branch on confidence: never let the strategist decide on an unverified step.
    const unresolved = pad.completed.filter((c) => c.includes("("));
    if (task.type === "DECIDE" && unresolved.length) {
      decision = { decision: "HUMAN_REVIEW", penalty_usd: "pending", rationale: `Not decided automatically: ${unresolved.join(", ")} could not be verified.` };
      pad.remaining.shift();
      pad.completed.push(`${task.id}(skipped)`);
      log(`Decision withheld: ${unresolved.join(", ")} unverified, routed to a human reviewer`);
      return { text: `${decision.rationale}\n[TASK_COMPLETE]\n\n[STATE_CHECKPOINT]\n${writeScratchpad(pad)}`, metadata: usage() };
    }

    const spec = TASK_SPECS[task.type];
    const inputs = await buildInputs(task, pad);
    const k: MicroContract = {
      task: task.id,
      instruction: spec.instruction,
      inputs,
      allowed_outputs: spec.outputs,
      may_request: catalog.enum.filter((n) => inputs[n.split(".")[1]] === undefined),
    };
    let lane: Lane = pad.context[`escalate_${task.id}`] ? "deep" : spec.lane;
    let { reply, call, payload } = await dispatch(k, lane, spec.think);
    book(task.id, lane, call, payload.length, reply.status);
    log(`${task.id} on ${lane === "fast" ? "Nemotron Lightning" : "Nemotron Ultra"} (${call.usage.input_tokens} tokens in): ${reply.status}${reply.status === "INSUFFICIENT_CONTEXT" ? ` -> needs ${reply.missing}` : ""}${reply.status === "REJECTED" ? ` (${reply.reason})` : ""}`);

    // A rejected reply (bad JSON, keys outside Y, name outside C) gets one retry on the deep lane.
    if (reply.status === "REJECTED" && lane === "fast") {
      lane = "deep";
      ({ reply, call, payload } = await dispatch(k, lane, true));
      book(task.id, lane, call, payload.length, reply.status);
      log(`${task.id} retried on Nemotron Ultra: ${reply.status}`);
    }

    if (reply.status === "INSUFFICIENT_CONTEXT") {
      const tries = Number(pad.context[`retries_${task.id}`] ?? 0) + 1;
      if (tries > MAX_RETRIES) {
        reviewReasons.push(`${task.id} still lacked context after ${MAX_RETRIES} fetches`);
        pad.remaining.shift();
        pad.completed.push(`${task.id}(unresolved)`);
        return { text: `${task.id} gave up after ${MAX_RETRIES} fetches.\n[STATE_CHECKPOINT]\n${writeScratchpad(pad)}`, metadata: usage() };
      }
      pad.context[`retries_${task.id}`] = String(tries);
      pad.context.pending = reply.missing;
      return {
        text: `${task.id} paused: needs ${reply.missing}.\n[NEEDS_TOOL tool="zetaris_cell" input="${reply.missing}"]\n[STATE_CHECKPOINT]\n${writeScratchpad(pad)}`,
        metadata: usage(),
      };
    }
    delete pad.context.pending;

    if (reply.status === "REJECTED") {
      reviewReasons.push(`${task.id} reply rejected twice: ${reply.reason}`);
      pad.remaining.shift();
      pad.completed.push(`${task.id}(rejected)`);
      return { text: `${task.id} rejected.\n[STATE_CHECKPOINT]\n${writeScratchpad(pad)}`, metadata: usage() };
    }

    // VERIFIED
    if (task.type === "CRITIQUE") {
      const problem = await guardCritique(pad, reply.outputs);
      if (problem && !pad.context[`escalate_${task.id}`]) {
        log(`Guard: ${problem}. Escalating ${task.id} to Nemotron Ultra`);
        pad.context[`escalate_${task.id}`] = "1";
        return { text: `${task.id} failed the consistency guard; re-running on the deep lane.\n[STATE_CHECKPOINT]\n${writeScratchpad(pad)}`, metadata: usage() };
      }
      if (problem) {
        reviewReasons.push(`guard: ${problem}`);
        log(`Guard: ${problem}. Flagged for human review`);
      }
    }
    if (task.type === "DECIDE") {
      decision = { decision: reply.outputs.decision, penalty_usd: reply.outputs.penalty_usd, rationale: reply.outputs.rationale };
      pad.remaining.shift();
      pad.completed.push(task.id);
      pad.facts.decision = reply.outputs.decision;
      pad.facts.final_penalty_usd = reply.outputs.penalty_usd;
      log(`Decision: ${decision.decision} ($${decision.penalty_usd})`);
      return { text: `Decision: ${decision.decision}. ${decision.rationale}\n[TASK_COMPLETE]\n\n[STATE_CHECKPOINT]\n${writeScratchpad(pad)}`, metadata: usage() };
    }
    Object.assign(pad.facts, reply.outputs);
    if (task.type === "EXTRACT") pad.context.vendor_id = reply.outputs.vendor_id;
    pad.remaining.shift();
    pad.completed.push(task.id);
    return { text: `${task.id} verified: ${Object.entries(reply.outputs).map(([a, b]) => `${a}=${b}`).join(", ")}\n[STATE_CHECKPOINT]\n${writeScratchpad(pad)}`, metadata: usage() };
  }

  // The NEEDS_TOOL handler: the security gate, then a single-cell fetch.
  async function onTool(callReq: { tool: string; input: string }): Promise<string> {
    if (callReq.tool !== "zetaris_cell" || !catalog.enum.includes(callReq.input)) {
      reviewReasons.push(`denied tool request ${callReq.tool}(${callReq.input})`);
      log(`Gate: DENIED ${callReq.tool}(${callReq.input})`);
      return "DENIED: not in catalog";
    }
    const pad = readScratchpad(lastCarry);
    const [t, c] = callReq.input.split(".") as [Table, string];
    const p = await project(t, [c], { ...pad.facts, ...pad.context }, catalog);
    cite(callReq.input, p.values[c], p.sql);
    log(`Gate: ${callReq.input} is in the catalog. Zetaris returned 1 cell: ${p.values[c]}`);
    return p.values[c];
  }

  // onTool runs after the chunk that paused; the latest state block comes from that chunk.
  let lastCarry = "";
  const engine = new Markovian({ chunkConfig: { chunkSize: 2000, maxChunks: 10, carryoverTokens: 256 }, historyDir: opts.historyDir });
  const run = await engine.run({
    goal,
    mode: "ARCHITECT",
    generator: async (prompt) => {
      const out = await generator(prompt);
      lastCarry = out.text.split("[STATE_CHECKPOINT]").pop() ?? "";
      return out;
    },
    onTool,
  });

  const finalPad = readScratchpad(lastCarry);
  if (run.status !== "completed") reviewReasons.push(`Markovian run ended as ${run.status}${run.error ? `: ${run.error}` : ""}`);
  if (!decision) reviewReasons.push("no decision was produced");
  return {
    target,
    goal,
    decision,
    needsHumanReview: reviewReasons.length > 0,
    reviewReasons,
    plan: thePlan!,
    facts: finalPad.facts,
    citations,
    ledger,
    events,
    run,
    totals: {
      inputTokens: ledger.reduce((s, e) => s + e.inputTokens, 0),
      outputTokens: ledger.reduce((s, e) => s + e.outputTokens, 0),
      llmCalls: ledger.length,
      ms: Date.now() - started,
    },
  };
}
