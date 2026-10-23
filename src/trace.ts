// Run traces, as the Technical Execution Guide recommends: one readable line
// per event on stdout, and one JSON object per line in logs/trace-<run_id>.jsonl.
// Only summaries are logged; secrets never pass through here.
import { appendFileSync, mkdirSync } from "node:fs";

export interface TraceEvent {
  agent_name: string; // Planner, Extractor, Critic, Strategist, Reviewer, Broker, Markovian engine, Zetaris
  action: string;
  input_summary?: string;
  output_summary?: string;
  target_agent?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  retry_count?: number;
  status: "success" | "paused" | "escalated" | "fallback" | "denied" | "error";
}

export interface Tracer {
  runId: string;
  file: string;
  event(e: TraceEvent): void;
}

export function createTracer(runId: string, opts: { quiet?: boolean } = {}): Tracer {
  mkdirSync("logs", { recursive: true });
  const file = `logs/trace-${runId}.jsonl`;
  return {
    runId,
    file,
    event(e) {
      appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), run_id: runId, ...e }) + "\n");
      if (!opts.quiet) {
        const model = e.model ? ` (model: ${e.model})` : "";
        console.log(`[INFO] run_id=${runId} ${e.agent_name} ${e.action}: ${e.output_summary ?? e.input_summary ?? ""}${model}`);
      }
    },
  };
}
