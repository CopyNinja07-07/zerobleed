// The schema catalog: table and column NAMES only, read from Zetaris with
// DESCRIBE. This is all the planner ever sees of the data (zero raw rows).
// It also defines the closed enum of names a worker may ask for.
import type { Domain, Projection } from "../domains/types.ts";
import { runSql, query } from "../zetaris.ts";

export type Table = string;

export interface Catalog {
  domain: Domain;
  tables: Record<Table, string[]>;
  enum: string[]; // "table.column", the only names a worker may request
}

const cached = new Map<string, Catalog>();

export async function loadCatalog(domain: Domain): Promise<Catalog> {
  const hit = cached.get(domain.id);
  if (hit) return hit;
  const tables: Record<Table, string[]> = {};
  for (const t of domain.tables) {
    const { rows } = await runSql(`DESCRIBE ${domain.container}.${t}`);
    tables[t] = rows.map((r) => String(r[0])).filter((c) => c && !c.startsWith("#"));
  }
  const catalog = { domain, tables, enum: domain.tables.flatMap((t) => tables[t].map((c) => `${t}.${c}`)) };
  cached.set(domain.id, catalog);
  return catalog;
}

export function catalogText(c: Catalog): string {
  return c.domain.tables.map((t) => `${t}[${c.tables[t].join(", ")}]`).join("; ");
}

// Plain-words description of which row a fetched cell came from, so a worker
// knows the cell already answers "on the breach_date in this region".
export function rowScope(c: Catalog, table: Table, facts: Record<string, string>): string | undefined {
  const key = c.domain.keys[table]?.(facts);
  return key ? Object.entries(key).map(([k, v]) => `${k} ${v}`).join(", ") : undefined;
}

const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;

export type { Projection };

// Scoped cell projection: only the authorised columns, only the keyed row.
// The key comes from deterministic code (the domain), never from a model.
export async function project(table: Table, columns: string[], facts: Record<string, string>, catalog: Catalog): Promise<Projection> {
  if (!catalog.tables[table]) throw new Error(`UnauthorizedSchemaRequest: ${table} is not in the catalog`);
  for (const c of columns) {
    if (!catalog.tables[table].includes(c)) throw new Error(`UnauthorizedSchemaRequest: ${table}.${c} is not in the catalog`);
  }
  const key = catalog.domain.keys[table](facts);
  if (!key) throw new Error(`cannot locate a ${table} row yet: missing key facts`);
  const where = Object.entries(key).map(([k, v]) => `${k} = ${quote(v)}`).join(" AND ");
  const sql = `SELECT ${columns.join(", ")} FROM ${catalog.domain.container}.${table} WHERE ${where}`;
  const rows = await query(sql);
  if (rows.length !== 1) throw new Error(`expected exactly 1 ${table} row for ${where}, got ${rows.length}`);
  const values = Object.fromEntries(columns.map((c) => [c, String(rows[0][c])]));
  return { values, sql };
}
