// The distilled fact scratchpad IS the Markovian carryover. It is written in the
// engine's canonical state block, so everything needed to continue the audit
// travels between chunks in a few hundred characters:
//
//   COMPLETED: tasks done
//   REMAINING: tasks left, in order
//   DECISIONS: verified facts, key=value
//   CONTEXT:   audit target and any pending request
export interface Scratchpad {
  completed: string[];
  remaining: string[];
  facts: Record<string, string>;
  context: Record<string, string>;
}

const kv = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("; ");

export function writeScratchpad(s: Scratchpad): string {
  return [
    `COMPLETED: ${s.completed.join(", ") || "none"}`,
    `REMAINING: ${s.remaining.join(", ") || "none"}`,
    `DECISIONS: ${kv(s.facts) || "none"}`,
    `CONTEXT: ${kv(s.context) || "none"}`,
  ].join("\n");
}

function parseKv(line: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!line || line.trim() === "none") return out;
  for (const part of line.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function readScratchpad(block: string): Scratchpad {
  const field = (label: string) => block.match(new RegExp(`^${label}:\\s*(.*)$`, "m"))?.[1]?.trim();
  const list = (v?: string) => (!v || v === "none" ? [] : v.split(",").map((x) => x.trim()).filter(Boolean));
  return {
    completed: list(field("COMPLETED")),
    remaining: list(field("REMAINING")),
    facts: parseKv(field("DECISIONS")),
    context: parseKv(field("CONTEXT")),
  };
}

// The engine hands the generator a prompt; the carryover sits in its [CARRYOVER STATE] block.
export function carryoverFromPrompt(prompt: string): string {
  return prompt.match(/\[CARRYOVER STATE\]\n([\s\S]*?)(?:\n\n|$)/)?.[1]?.trim() ?? "";
}

export function toolResultFromPrompt(prompt: string): string | undefined {
  return prompt.match(/\[TOOL_RESULT\]\n([^\n]*)/)?.[1]?.trim();
}
