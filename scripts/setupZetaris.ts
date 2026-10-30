// Registers a domain's data silos in Zetaris (npm run setup:zetaris -- incident): one Lightning database per silo,
// a REST table per endpoint, and a flat SchemaStore view per table in the
// `zerobleed` container. Safe to re-run: "already exists" errors are skipped.
// The data server (npm run data) must be running while Zetaris reads the APIs.
import { runSql } from "../src/zetaris.ts";

const HOST = process.env.DATA_HOST ?? "http://host.docker.internal:8787";

const DOMAIN = process.argv[2] ?? "procurement";

interface Silo { db: string; describe: string; table: string; path: string; view: string; columns: string[] }

// The demo domains and the N = 400 benchmark planes use the same silo layout;
// the benchmark gets its own databases, tables, endpoints and container.
function layout(container: string, db: string, table: string, path: string) {
  return {
    procurement: {
      container,
      silos: [
        { db: `${db}ERP`, describe: "ERP delivery logs, silo A", table: `${table}shipments_raw`, path: `${path}/erp/shipments`, view: "shipments",
          columns: ["shipment_id", "vendor_id", "hub_region", "promised_date", "breach_date", "delay_days", "units", "carrier"] },
        { db: `${db}LEGAL`, describe: "Supplier SLA contracts, silo B", table: `${table}contracts_raw`, path: `${path}/legal/contracts`, view: "contracts",
          columns: ["contract_id", "vendor_id", "vendor_name", "clause_id", "penalty_pct", "penalty_usd", "threshold_days", "clause_text"] },
        { db: `${db}WEATHER`, describe: "Regional weather and force majeure logs, silo C", table: `${table}force_majeure_raw`, path: `${path}/weather/force_majeure`, view: "force_majeure",
          columns: ["log_date", "hub_region", "wind_knots", "waiver_declared", "event"] },
      ],
      derived: [] as string[],
    },
    incident: {
      container,
      silos: [
        { db: `${db}CLOUDTRAIL`, describe: "AWS CloudTrail events", table: `${table}cloudtrail_raw`, path: `${path}/aws/cloudtrail`, view: "cloudtrail",
          columns: ["event_id", "ts", "event_time", "principal", "principal_type", "action", "resource", "source_ip", "result"] },
        { db: `${db}VPC`, describe: "VPC flow logs", table: `${table}vpc_flows_raw`, path: `${path}/aws/vpc_flows`, view: "vpc_flows",
          columns: ["flow_id", "ts", "flow_time", "src_ip", "dst_ip", "dst_owner", "dst_port", "bytes_out", "action"] },
        { db: `${db}K8S`, describe: "Kubernetes cluster events", table: `${table}k8s_events_raw`, path: `${path}/k8s/events`, view: "k8s_events",
          columns: ["event_id", "ts", "event_time", "namespace", "object", "reason", "node", "message"] },
        { db: `${db}DATADOG`, describe: "Datadog alerts", table: `${table}alerts_raw`, path: `${path}/datadog/alerts`, view: "alerts",
          columns: ["alert_id", "ts", "alert_time", "service", "severity", "metric", "value", "summary"] },
        { db: `${db}RUNBOOKS`, describe: "SRE triage runbooks", table: `${table}runbooks_raw`, path: `${path}/sre/runbooks`, view: "runbooks",
          columns: ["service", "runbook_id", "owner_team", "policy_id", "triage_policy"] },
      ],
      // Zetaris computes the per-alert signals from the raw logs. Workers only ever see these.
      derived: [
        `CREATE OR REPLACE SCHEMASTORE VIEW sig_iam WITH CONTAINER ${container} AS
SELECT a.alert_id, COUNT(c.event_id) AS non_admin_iam_escalations_60m, MAX(c.principal) AS escalating_principal_60m
FROM ${container}.alerts a LEFT JOIN ${container}.cloudtrail c
  ON c.ts BETWEEN a.ts - 3600 AND a.ts AND c.principal_type <> 'admin'
  AND c.action IN ('AttachRolePolicy', 'PutRolePolicy', 'CreateAccessKey', 'UpdateAssumeRolePolicy', 'AttachUserPolicy')
GROUP BY a.alert_id`,
        `CREATE OR REPLACE SCHEMASTORE VIEW sig_egress WITH CONTAINER ${container} AS
SELECT a.alert_id, ROUND(COALESCE(SUM(f.bytes_out), 0) / 1000000000, 2) AS egress_gb_outside_allowlist_60m, MAX(f.dst_ip) AS egress_destination_outside_allowlist_60m
FROM ${container}.alerts a LEFT JOIN ${container}.vpc_flows f
  ON f.ts BETWEEN a.ts - 3600 AND a.ts AND f.dst_owner = 'unknown'
GROUP BY a.alert_id`,
        `CREATE OR REPLACE SCHEMASTORE VIEW sig_k8s WITH CONTAINER ${container} AS
SELECT a.alert_id,
  SUM(CASE WHEN k.reason IN ('ConfigMapUpdated', 'ScalingReplicaSet', 'DeploymentRollout') THEN 1 ELSE 0 END) AS config_changes_30m,
  SUM(CASE WHEN k.reason = 'NodeNotReady' THEN 1 ELSE 0 END) AS nodes_not_ready_30m
FROM ${container}.alerts a LEFT JOIN ${container}.k8s_events k
  ON k.ts BETWEEN a.ts - 1800 AND a.ts AND k.reason IN ('ConfigMapUpdated', 'ScalingReplicaSet', 'DeploymentRollout', 'NodeNotReady')
GROUP BY a.alert_id`,
        `CREATE OR REPLACE SCHEMASTORE VIEW alert_signals WITH CONTAINER ${container} AS
SELECT i.alert_id, i.non_admin_iam_escalations_60m, i.escalating_principal_60m, e.egress_gb_outside_allowlist_60m, e.egress_destination_outside_allowlist_60m, k.config_changes_30m, k.nodes_not_ready_30m
FROM ${container}.sig_iam i JOIN ${container}.sig_egress e ON i.alert_id = e.alert_id JOIN ${container}.sig_k8s k ON i.alert_id = k.alert_id`,
      ],
    },
  };
}

const SILOS: Record<string, Silos> = {
  procurement: layout("zerobleed", "ZB_", "zb_", "").procurement,
  incident: layout("incidents", "ZB_", "zb_", "").incident,
  "procurement-bench": layout("zb_bench", "ZBB_", "zbb_", "/bench").procurement,
  "incident-bench": layout("inc_bench", "ZBB_", "zbb_", "/bench").incident,
};
interface Silos { container: string; silos: Silo[]; derived: string[] }

const { container, silos, derived } = SILOS[DOMAIN];
const statements: string[] = [`CREATE SCHEMASTORE CONTAINER ${container}`];
for (const s of silos) {
  statements.push(`CREATE LIGHTNING DATABASE ${s.db} DESCRIBE BY "${s.describe}"`);
  statements.push(
    `CREATE LIGHTNING REST TABLE ${s.table} FROM ${s.db} REQUEST(\n` +
      `  endpoint "${HOST}${s.path}",\n  method "get",\n  response_type "json",\n  http_encoding "URLENCODED"\n) HEADER (\n) BODY ()`
  );
  statements.push(
    `CREATE OR REPLACE SCHEMASTORE VIEW ${s.view} WITH CONTAINER ${container} AS\n` +
      `SELECT ${s.columns.map((c) => `r.${c} AS ${c}`).join(", ")}\n` +
      `FROM ${s.db}.${s.table} LATERAL VIEW explode(records) AS r`
  );
}

statements.push(...derived);

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
  const { rows } = await runSql(`SELECT COUNT(*) FROM ${container}.${s.view}`);
  console.log(`${container}.${s.view}: ${rows[0]?.[0]} rows`);
}
