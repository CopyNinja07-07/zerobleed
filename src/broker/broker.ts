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
import { getDomain, type Domain } from "../domains/index.ts";
import { loadCatalog, project, rowScope, type Catalog, type Table } from "./catalog.ts";
import { dispatch, type MicroContract } from "./contracts.ts";
import { plan as makePlan, type Plan, type PlannedTask } from "./planner.ts";
import { isSampleMode, onFallback } from "../replay.ts";
import { createTracer, type TraceEvent } from "../trace.ts";
import { carryoverFromPrompt, readScratchpad, toolResultFromPrompt, writeScratchpad, type Scratchpad } from "./scratchpad.ts";


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
  id: string; // e.g. SHP-1017 or ALR-2001
  domain?: string; // defaults to procurement
}

export interface AuditResult {
  target: AuditTarget;
  goal: string;
  domain: string;
  decision?: { decision: string; rationale: string; [key: string]: string };
  valueKey: string;
  needsHumanReview: boolean;
  reviewReasons: string[];
  plan: Plan;
  facts: Record<string, string>;
  citations: Citation[];
  ledger: LedgerEntry[];
  events: string[];
  run: MarkovianRun;
  runId: string;
  traceFile: string;
  totals: { inputTokens: number; outputTokens: number; llmCalls: number; ms: number };
}

// Money is shown as $N, anything else as is.
export const showValue = (d: Domain, v: string | undefined) => (d.valueKey.endsWith("_usd") ? `$${v ?? "-"}` : (v ?? "-"));

const AGENT: Record<string, string> = { PLAN: "Planner", EXTRACT: "Extractor", CRITIQUE: "Critic", DECIDE: "Strategist", REFLECT: "Reviewer" };
const agentFor = (task: string) => AGENT[task] ?? AGENT[task.split("_")[1] ?? ""] ?? task;

// Non-model events, classified for the trace.
function traceOf(e: string): TraceEvent {
  const [head, ...rest] = e.split(": ");
  const body = rest.join(": ");
  if (head === "Zetaris") return { agent_name: "Zetaris", action: "scoped_query", output_summary: body, status: "success" };
  if (head === "Gate") return { agent_name: "Broker", action: "interrupt_gate", output_summary: body, status: body.startsWith("DENIED") ? "denied" : "success" };
  if (head === "Guard") return { agent_name: "Broker", action: "consistency_guard", output_summary: body, status: "escalated" };
  if (head === "Fallback") return { agent_name: "Broker", action: "service_fallback", output_summary: body, status: "fallback" };
  if (head === "Broker") return { agent_name: "Broker", action: "least_privilege", output_summary: body, status: "success" };
  return { agent_name: "Broker", action: "note", output_summary: e, status: "success" };
}

export async function runAudit(
  target: AuditTarget,
  opts: { onEvent?: (e: string) => void; historyDir?: string; runId?: string; quiet?: boolean } = {}
): Promise<AuditResult> {
  const started = Date.now();
  const domain: Domain = getDomain(target.domain);
  const MAX_RETRIES = domain.maxRetries; // Rmax: interrupts allowed per task
  const tracer = createTracer(opts.runId ?? `${target.id}-${started}`, { quiet: opts.quiet });
  tracer.event({ agent_name: "Broker", action: "start_run", input_summary: `${domain.id} ${target.id}${isSampleMode() ? " (SAMPLE_MODE)" : ""}`, status: "success" });
  const catalog: Catalog = await loadCatalog(domain);
  const goal = domain.goal(target.id);
  const ledger: LedgerEntry[] = [];
  const citations: Citation[] = [];
  const events: string[] = [];
  const reviewReasons: string[] = [];
  let decision: AuditResult["decision"];
  let thePlan: Plan | undefined;
  let step = 0;

  const log = (e: string, traced = false) => {
    events.push(e);
    opts.onEvent?.(e);
    if (!traced) tracer.event(traceOf(e));
  };
  const stopFallbackLog = onFallback((m) => log(`Fallback: ${m}`));
  const book = (task: string, lane: Lane, call: ChatResult, promptChars: number, outcome: string) => {
    ledger.push({ step, task, lane, model: call.model, inputTokens: call.usage.input_tokens, outputTokens: call.usage.output_tokens, promptChars, ms: call.ms, receiptId: call.receiptId, outcome });
    tracer.event({
      agent_name: agentFor(task),
      action: task === "PLAN" ? "plan_from_schema" : task === "REFLECT" ? "reflection_pass" : `micro_contract ${task}`,
      input_summary: `${promptChars} chars via Nightshift`,
      output_summary: outcome,
      model: call.model,
      input_tokens: call.usage.input_tokens,
      output_tokens: call.usage.output_tokens,
      status: outcome === "INSUFFICIENT_CONTEXT" ? "paused" : outcome === "REJECTED" ? "error" : "success",
    });
  };
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
      const name = domain.qualifiedExtras ? extra : c;
      inputs[name] = pad.facts[c];
      const scope = rowScope(catalog, t, { ...pad.facts, ...pad.context });
      if (scope) inputs[`${name}_row`] = `${t} row for ${scope}`;
    }
    // The critic checks the rule against the verified facts from earlier steps.
    if (task.type === "CRITIQUE") {
      for (const f of domain.critiqueFacts) if (pad.facts[f] !== undefined) inputs[f] = pad.facts[f];
    }
    if (task.type === "DECIDE") Object.assign(inputs, pad.facts);
    return inputs;
  }

  // Deterministic cross-check of the critic, using structured columns the
  // broker reads itself. A mismatch lowers confidence: escalate, then flag.
  const guardCritique = (pad: Scratchpad, outputs: Record<string, string>) =>
    domain.guard({ ...pad.facts, ...pad.context }, outputs, {
      project: (table, columns, facts) => project(table, columns, facts, catalog),
      cite,
    });

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
      log(`Reflection: ${call.text.slice(0, 120)}`, true);
      if (/^REFINE/i.test(call.text.trim())) reviewReasons.push(`reflection: ${call.text.slice(0, 160)}`);
      return { text: call.text, metadata: usage() };
    }

    const carry = carryoverFromPrompt(prompt);
    // Chunk 1: plan from the schema catalog only.
    if (!carry) {
      const { plan: p, call, prompt: planPrompt } = await makePlan(goal, catalog);
      thePlan = p;
      if (call) book("PLAN", "deep", call, planPrompt.length, p.source);
      log(p.source === "planner" ? `Planner (Nemotron Ultra, schema only): ${p.tasks.map((t) => `${t.id}[${t.columns.length} cols]`).join(" -> ")}` : `Planner output unusable (${p.note}); using the fallback plan`, p.source === "planner");
      if (p.source === "planner" && p.note) log(`Broker: ${p.note}`);
      const pad: Scratchpad = { completed: ["PLAN"], remaining: p.tasks.map((t) => t.id), facts: {}, context: { [domain.targetKey]: target.id } };
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
      decision = { decision: "HUMAN_REVIEW", [domain.valueKey]: "pending", rationale: `Not decided automatically: ${unresolved.join(", ")} could not be verified.` };
      pad.remaining.shift();
      pad.completed.push(`${task.id}(skipped)`);
      log(`Decision withheld: ${unresolved.join(", ")} unverified, routed to a human reviewer`);
      return { text: `${decision.rationale}\n[TASK_COMPLETE]\n\n[STATE_CHECKPOINT]\n${writeScratchpad(pad)}`, metadata: usage() };
    }

    const spec = domain.taskSpecs[task.type];
    const inputs = await buildInputs(task, pad);
    const k: MicroContract = {
      task: task.id,
      instruction: spec.instruction,
      inputs,
      allowed_outputs: spec.outputs,
      may_request: catalog.enum.filter((n) => inputs[n.split(".")[1]] === undefined && inputs[n] === undefined),
    };
    let lane: Lane = pad.context[`escalate_${task.id}`] ? "deep" : spec.lane;
    let { reply, call, payload } = await dispatch(k, lane, spec.think);
    book(task.id, lane, call, payload.length, reply.status);
    log(`${task.id} on ${lane === "fast" ? "Nemotron Lightning" : "Nemotron Ultra"} (${call.usage.input_tokens} tokens in): ${reply.status}${reply.status === "INSUFFICIENT_CONTEXT" ? ` -> needs ${reply.missing}` : ""}${reply.status === "REJECTED" ? ` (${reply.reason})` : ""}`, true);

    // A rejected reply (bad JSON, keys outside Y, name outside C) gets one retry on the deep lane.
    if (reply.status === "REJECTED") {
      const thinkAgain = lane === "fast";
      lane = "deep";
      ({ reply, call, payload } = await dispatch(k, lane, thinkAgain));
      book(task.id, lane, call, payload.length, reply.status);
      log(`${task.id} retried on Nemotron Ultra: ${reply.status}`, true);
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
      decision = { ...reply.outputs, decision: reply.outputs.decision, rationale: reply.outputs.rationale };
      pad.remaining.shift();
      pad.completed.push(task.id);
      pad.facts.decision = reply.outputs.decision;
      pad.facts[`final_${domain.valueKey}`] = reply.outputs[domain.valueKey];
      log(`Decision: ${decision.decision} (${showValue(domain, decision[domain.valueKey])})`, true);
      return { text: `Decision: ${decision.decision}. ${decision.rationale}\n[TASK_COMPLETE]\n\n[STATE_CHECKPOINT]\n${writeScratchpad(pad)}`, metadata: usage() };
    }
    Object.assign(pad.facts, reply.outputs);
    if (task.type === "EXTRACT") for (const k of domain.extractContext) pad.context[k] = reply.outputs[k];
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
      if (!prompt.startsWith("Reflect on this completed run.")) {
        const pauses = /\[NEEDS_TOOL /.test(out.text);
        tracer.event({
          agent_name: "Markovian engine",
          action: `chunk ${step}`,
          input_summary: `carryover in: ${carryoverFromPrompt(prompt).length} chars`,
          output_summary: pauses ? "NEEDS_TOOL pause" : /\[TASK_COMPLETE\]/.test(out.text) ? "TASK_COMPLETE" : `state out: ${lastCarry.trim().length} chars`,
          status: pauses ? "paused" : "success",
        });
      }
      return out;
    },
    onTool,
  });

  stopFallbackLog();
  const finalPad = readScratchpad(lastCarry);
  tracer.event({
    agent_name: "Strategist",
    action: "final_synthesis",
    output_summary: decision ? `${decision.decision} ${showValue(domain, decision[domain.valueKey])}${reviewReasons.length ? " (needs human review)" : ""}` : "no decision",
    status: decision ? "success" : "error",
  });
  tracer.event({ agent_name: "Broker", action: "end_run", output_summary: `completed in ${((Date.now() - started) / 1000).toFixed(1)} seconds`, status: "success" });
  if (run.status !== "completed") reviewReasons.push(`Markovian run ended as ${run.status}${run.error ? `: ${run.error}` : ""}`);
  if (!decision) reviewReasons.push("no decision was produced");
  return {
    target,
    domain: domain.id,
    goal,
    decision,
    valueKey: domain.valueKey,
    needsHumanReview: reviewReasons.length > 0,
    reviewReasons,
    plan: thePlan!,
    facts: finalPad.facts,
    citations,
    ledger,
    events,
    run,
    traceFile: tracer.file,
    runId: tracer.runId,
    totals: {
      inputTokens: ledger.reduce((s, e) => s + e.inputTokens, 0),
      outputTokens: ledger.reduce((s, e) => s + e.outputTokens, 0),
      llmCalls: ledger.length,
      ms: Date.now() - started,
    },
  };
}
