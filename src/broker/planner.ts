// Tier 1 planning from the schema catalog alone. The strategist sees the goal
// and table/column names (never a row) and returns the task list with the
// columns each task may see. The broker validates the plan against the
// catalog and falls back to a known-good plan if it is unusable.
import { chat, type ChatResult } from "../llm.ts";
import { type Catalog, catalogText } from "./catalog.ts";
import type { TaskType } from "./contracts.ts";

export interface PlannedTask {
  id: string; // e.g. T1_EXTRACT
  type: TaskType;
  columns: string[]; // "table.column" the task may see from Zetaris
}

export interface Plan {
  tasks: PlannedTask[];
  source: "planner" | "fallback";
  note?: string;
}

const PLANNER_SYSTEM =
  "You plan audits for a context broker. You see only table and column names, never data. " +
  "Reply with one JSON object: {\"tasks\": [{\"type\": \"EXTRACT\"|\"CRITIQUE\"|\"DECIDE\", \"columns\": [\"table.column\", ...]}]}. " +
  "Use exactly three tasks in this order: EXTRACT (read the delivery facts), CRITIQUE (check the contract clause), DECIDE (final decision, columns []). " +
  "Give each task the fewest columns it needs. Use only names from the catalog.";

const HOME_TABLE: Record<TaskType, string> = { EXTRACT: "shipments", CRITIQUE: "contracts", DECIDE: "" };

export const FALLBACK_PLAN: PlannedTask[] = [
  { id: "T1_EXTRACT", type: "EXTRACT", columns: ["shipments.delay_days", "shipments.breach_date", "shipments.hub_region", "shipments.vendor_id"] },
  { id: "T2_CRITIQUE", type: "CRITIQUE", columns: ["contracts.clause_text"] },
  { id: "T3_DECIDE", type: "DECIDE", columns: [] },
];

export async function plan(goal: string, catalog: Catalog): Promise<{ plan: Plan; call?: ChatResult; prompt: string }> {
  const prompt = `Goal: ${goal}\nCatalog: ${catalogText(catalog)}`;
  let call: ChatResult | undefined;
  try {
    call = await chat("deep", PLANNER_SYSTEM, prompt, { maxTokens: 600 });
    const obj = JSON.parse(call.text.slice(call.text.indexOf("{"), call.text.lastIndexOf("}") + 1));
    const order: TaskType[] = ["EXTRACT", "CRITIQUE", "DECIDE"];
    const tasks: PlannedTask[] = (obj.tasks ?? []).map((t: { type: TaskType; columns?: string[] }, i: number) => ({
      id: `T${i + 1}_${t.type}`,
      type: t.type,
      columns: (t.columns ?? []).map(String),
    }));
    const problems: string[] = [];
    if (tasks.length !== 3 || tasks.some((t, i) => t.type !== order[i])) problems.push("tasks not EXTRACT, CRITIQUE, DECIDE");
    for (const t of tasks) for (const c of t.columns) if (!catalog.enum.includes(c)) problems.push(`unknown column ${c}`);
    if (tasks[0] && !tasks[0].columns.includes("shipments.delay_days")) problems.push("EXTRACT lacks shipments.delay_days");
    if (tasks[1] && !tasks[1].columns.includes("contracts.clause_text")) problems.push("CRITIQUE lacks contracts.clause_text");
    if (tasks[2]) tasks[2].columns = []; // DECIDE works from verified facts only
    // Least privilege: a task is pre-loaded only from its home silo. Any
    // cross-silo fact must be requested through the interrupt gate, so every
    // cross-silo read is individually authorised and logged.
    const dropped: string[] = [];
    for (const t of tasks) {
      const home = HOME_TABLE[t.type];
      dropped.push(...t.columns.filter((c) => !c.startsWith(`${home}.`)));
      t.columns = t.columns.filter((c) => c.startsWith(`${home}.`));
    }
    if (problems.length) return { plan: { tasks: FALLBACK_PLAN, source: "fallback", note: problems.join("; ") }, call, prompt };
    const note = dropped.length ? `least privilege removed ${dropped.join(", ")}` : undefined;
    return { plan: { tasks, source: "planner", note }, call, prompt };
  } catch (err) {
    return { plan: { tasks: FALLBACK_PLAN, source: "fallback", note: (err as Error).message.slice(0, 200) }, call, prompt };
  }
}
