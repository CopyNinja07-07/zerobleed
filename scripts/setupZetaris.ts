// Registers the three data silos in Zetaris: one Lightning database per silo,
// a REST table per endpoint, and a flat SchemaStore view per table in the
// `zerobleed` container. Safe to re-run: "already exists" errors are skipped.
// The data server (npm run data) must be running while Zetaris reads the APIs.
import { runSql } from "../src/zetaris.ts";

const HOST = process.env.DATA_HOST ?? "http://host.docker.internal:8787";

const silos = [
  {
    db: "ZB_ERP",
    describe: "ERP delivery logs, silo A",
    table: "zb_shipments_raw",
    path: "/erp/shipments",
    view: "shipments",
    columns: ["shipment_id", "vendor_id", "hub_region", "promised_date", "breach_date", "delay_days", "units", "carrier"],
  },
  {
    db: "ZB_LEGAL",
    describe: "Supplier SLA contracts, silo B",
    table: "zb_contracts_raw",
    path: "/legal/contracts",
    view: "contracts",
    columns: ["contract_id", "vendor_id", "vendor_name", "clause_id", "penalty_pct", "penalty_usd", "threshold_days", "clause_text"],
  },
  {
    db: "ZB_WEATHER",
    describe: "Regional weather and force majeure logs, silo C",
    table: "zb_force_majeure_raw",
    path: "/weather/force_majeure",
    view: "force_majeure",
    columns: ["log_date", "hub_region", "wind_knots", "waiver_declared", "event"],
  },
];

const statements: string[] = [`CREATE SCHEMASTORE CONTAINER zerobleed`];
for (const s of silos) {
  statements.push(`CREATE LIGHTNING DATABASE ${s.db} DESCRIBE BY "${s.describe}"`);
  statements.push(
    `CREATE LIGHTNING REST TABLE ${s.table} FROM ${s.db} REQUEST(\n` +
      `  endpoint "${HOST}${s.path}",\n  method "get",\n  response_type "json",\n  http_encoding "URLENCODED"\n) HEADER (\n) BODY ()`
  );
  statements.push(
    `CREATE OR REPLACE SCHEMASTORE VIEW ${s.view} WITH CONTAINER zerobleed AS\n` +
      `SELECT ${s.columns.map((c) => `r.${c} AS ${c}`).join(", ")}\n` +
      `FROM ${s.db}.${s.table} LATERAL VIEW explode(records) AS r`
  );
}

for (const sql of statements) {
  const label = sql.split("\n")[0].slice(0, 90);
  try {
    await runSql(sql);
    console.log(`ok       ${label}`);
  } catch (err) {
    const msg = (err as Error).message;
    if (/already exist/i.test(msg)) console.log(`exists   ${label}`);
    else {
      console.log(`FAILED   ${label}\n         ${msg}`);
      process.exitCode = 1;
      break;
    }
  }
}

if (!process.exitCode) for (const s of silos) {
  const { rows } = await runSql(`SELECT COUNT(*) FROM zerobleed.${s.view}`);
  console.log(`zerobleed.${s.view}: ${rows[0]?.[0]} rows`);
}
