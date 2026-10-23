// Data plane client: Zetaris over its REST API. One SQL statement per call,
// API key as a bearer token, plus X-Org-ID and a fresh UUID X-Request-ID.
import { randomUUID } from "node:crypto";
import { env } from "./env.ts";
import { withReplay } from "./replay.ts";

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
}

export async function runSql(sql: string): Promise<SqlResult> {
  const statement = sql.trim().replace(/;$/, "");
  return withReplay("zetaris", statement, () => runSqlLive(statement));
}

async function runSqlLive(statement: string): Promise<SqlResult> {
  const res = await fetch(env("ZETARIS_REST_URL").replace(/\/$/, "") + "/sql-editor/sqls/run", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env("ZETARIS_API_KEY"),
      "X-Org-ID": env("ZETARIS_ORG_ID", "1"),
      "X-Request-ID": randomUUID(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ queryId: randomUUID(), sql: statement, source: "SqlEditor", limit: 1000 }),
    signal: AbortSignal.timeout(60_000), // bounded: a Zetaris query never hangs a run
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zetaris ${res.status}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text);
  const columns: string[] = (body.columns ?? body.schema ?? body.headers ?? []).map((c: any) => (typeof c === "string" ? c : c.name ?? c.columnName));
  return { columns, rows: body.data ?? [] };
}

// Rows as objects, keyed by column name.
export async function query(sql: string): Promise<Record<string, unknown>[]> {
  const { columns, rows } = await runSql(sql);
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}
