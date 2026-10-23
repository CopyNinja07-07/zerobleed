// The schema catalog: table and column NAMES only, read from Zetaris with
// DESCRIBE. This is all the planner ever sees of the data (zero raw rows).
// It also defines the closed enum of names a worker may ask for.
import { runSql, query } from "../zetaris.ts";

export const CONTAINER = "zerobleed";
export const TABLES = ["shipments", "contracts", "force_majeure"] as const;
export type Table = (typeof TABLES)[number];

export interface Catalog {
  tables: Record<Table, string[]>;
  enum: string[]; // "table.column", the only names a worker may request
}

let cached: Catalog | undefined;

export async function loadCatalog(): Promise<Catalog> {
  if (cached) return cached;
  const tables = {} as Record<Table, string[]>;
  for (const t of TABLES) {
    const { rows } = await runSql(`DESCRIBE ${CONTAINER}.${t}`);
    tables[t] = rows.map((r) => String(r[0])).filter((c) => c && !c.startsWith("#"));
  }
  cached = { tables, enum: TABLES.flatMap((t) => tables[t].map((c) => `${t}.${c}`)) };
  return cached;
}

export function catalogText(c: Catalog): string {
  return TABLES.map((t) => `${t}[${c.tables[t].join(", ")}]`).join("; ");
}

// How the broker finds the ONE row a fact lives in. Deterministic code, not AI:
// each table is keyed by facts the scratchpad already holds.
const KEYS: Record<Table, (facts: Record<string, string>) => Record<string, string> | undefined> = {
  shipments: (f) => (f.shipment_id ? { shipment_id: f.shipment_id } : undefined),
  contracts: (f) => (f.vendor_id ? { vendor_id: f.vendor_id } : undefined),
  force_majeure: (f) => (f.breach_date && f.hub_region ? { log_date: f.breach_date, hub_region: f.hub_region } : undefined),
};

// Plain-words description of which row a fetched cell came from, so a worker
// knows the cell already answers "on the breach_date in this region".
export function rowScope(table: Table, facts: Record<string, string>): string | undefined {
  const key = KEYS[table](facts);
  return key ? Object.entries(key).map(([k, v]) => `${k} ${v}`).join(", ") : undefined;
}

const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;

export interface Projection {
  values: Record<string, string>;
  sql: string; // provenance: the exact query that produced the values
}

// Scoped cell projection: only the authorised columns, only the keyed row.
export async function project(table: Table, columns: string[], facts: Record<string, string>, catalog: Catalog): Promise<Projection> {
  for (const c of columns) {
    if (!catalog.tables[table].includes(c)) throw new Error(`UnauthorizedSchemaRequest: ${table}.${c} is not in the catalog`);
  }
  const key = KEYS[table](facts);
  if (!key) throw new Error(`cannot locate a ${table} row yet: missing key facts`);
  const where = Object.entries(key).map(([k, v]) => `${k} = ${quote(v)}`).join(" AND ");
  const sql = `SELECT ${columns.join(", ")} FROM ${CONTAINER}.${table} WHERE ${where}`;
  const rows = await query(sql);
  if (rows.length !== 1) throw new Error(`expected exactly 1 ${table} row for ${where}, got ${rows.length}`);
  const values = Object.fromEntries(columns.map((c) => [c, String(rows[0][c])]));
  return { values, sql };
}
