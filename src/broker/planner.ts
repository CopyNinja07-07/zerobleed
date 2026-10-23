// Tier 1 planning from the schema catalog alone. The strategist sees the goal
// and table/column names (never a row) and returns the task list with the
// columns each task may see. The broker validates the plan against the
// catalog and falls back to a known-good plan if it is unusable.
import type { PlannedTask, TaskType } from "../domains/types.ts";
import { chat, type ChatResult } from "../llm.ts";
import { type Catalog, catalogText } from "./catalog.ts";

export type { PlannedTask };

export interface Plan {
  tasks: PlannedTask[];
  source: "planner" | "fallback";
  note?: string;
}

export async function plan(goal: string, catalog: Catalog): Promise<{ plan: Plan; call?: ChatResult; prompt: string }> {
  const domain = catalog.domain;
  const prompt = `Goal: ${goal}\nCatalog: ${catalogText(catalog)}`;
  const fallback = (note: string) => ({ tasks: domain.fallbackPlan, source: "fallback" as const, note });
  let call: ChatResult | undefined;
  try {
    call = await chat("deep", domain.plannerSystem, prompt, { maxTokens: 600 });
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
    for (const t of tasks) {
      const need = domain.requiredColumns[t.type];
      if (need && !t.columns.includes(need)) problems.push(`${t.type} lacks ${need}`);
    }
    if (tasks[2]) tasks[2].columns = []; // DECIDE works from verified facts only
    // Least privilege: a task is pre-loaded only from its home silo. Any
    // cross-silo fact must be requested through the interrupt gate, so every
    // cross-silo read is individually authorised and logged.
    const dropped: string[] = [];
    for (const t of tasks) {
      const homes = ([] as string[]).concat(domain.homeTable[t.type]).filter(Boolean);
      const atHome = (c: string) => homes.some((h) => c.startsWith(`${h}.`));
      dropped.push(...t.columns.filter((c) => !atHome(c)));
      t.columns = t.columns.filter(atHome);
    }
    if (problems.length) return { plan: fallback(problems.join("; ")), call, prompt };
    const note = dropped.length ? `least privilege removed ${dropped.join(", ")}` : undefined;
    return { plan: { tasks, source: "planner", note }, call, prompt };
  } catch (err) {
    return { plan: fallback((err as Error).message.slice(0, 200)), call, prompt };
  }
}
