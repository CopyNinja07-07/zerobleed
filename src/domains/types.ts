// A domain is everything the broker needs to know about one kind of decision:
// which Zetaris tables exist, how to find the one row a fact lives in, what each
// micro-contract asks, and how code cross-checks the critic. The broker, the
// Markovian chain, the gate and the scratchpad are the same for every domain.
import type { Lane } from "../llm.ts";

export type TaskType = "EXTRACT" | "CRITIQUE" | "DECIDE";

export interface TaskSpec {
  lane: Lane;
  think: boolean;
  instruction: string;
  outputs: string[];
}

export interface PlannedTask {
  id: string; // e.g. T1_EXTRACT
  type: TaskType;
  columns: string[]; // "table.column" the task may see from Zetaris
}

export interface Projection {
  values: Record<string, string>;
  sql: string;
}

export interface GuardContext {
  project(table: string, columns: string[], facts: Record<string, string>): Promise<Projection>;
  cite(fact: string, value: string, sql: string): void;
}

export interface BenchmarkCase {
  id: string;
  expect: string;
  value: string; // expected value of `valueKey`, compared as text (numbers rounded)
  what: string;
}

export interface Domain {
  id: string;
  title: string;
  container: string; // Zetaris SchemaStore container
  tables: string[]; // only these are in the catalog the planner and workers see
  keys: Record<string, (facts: Record<string, string>) => Record<string, string> | undefined>;
  targetKey: string; // e.g. shipment_id
  targetPattern: RegExp;
  goal(id: string): string;
  plannerSystem: string;
  fallbackPlan: PlannedTask[];
  homeTable: Record<TaskType, string | string[]>; // tables a step may be pre-loaded from; anything else must be requested
  requiredColumns: Partial<Record<TaskType, string>>;
  taskSpecs: Record<TaskType, TaskSpec>;
  critiqueFacts: string[]; // verified facts every critic receives
  extractContext: string[]; // EXTRACT outputs that become row keys for later steps
  valueKey: string; // the decision's main value: penalty_usd, recommended_action, ...
  maxRetries: number; // interrupts allowed per step
  qualifiedExtras?: boolean; // fetched cells keep their table prefix, so a worker sees which name it already has
  guard(facts: Record<string, string>, outputs: Record<string, string>, ctx: GuardContext): Promise<string | undefined>;
  cases: BenchmarkCase[];
}
