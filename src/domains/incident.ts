// Domain 2: production incident triage. Is an outage a configuration error,
// a hardware failure, or an active adversary exfiltrating data?
//
// Thousands of raw CloudTrail, VPC flow and Kubernetes rows stay in Zetaris.
// Zetaris SQL turns them into per-alert signals (the `alert_signals` view);
// the catalog exposes only alerts, runbooks and those signals, so a worker can
// ask for "egress_gb_outside_allowlist_60m" but never sees a raw log line.
import type { Domain } from "./types.ts";

const CLASSES = ["ACTIVE_ADVERSARY", "CONFIG_ERROR", "HARDWARE_FAILURE", "UNKNOWN"];

export const incident: Domain = {
  id: "incident",
  title: "Incident triage",
  container: "incidents",
  tables: ["alerts", "runbooks", "alert_signals"],
  keys: {
    alerts: (f) => (f.alert_id ? { alert_id: f.alert_id } : undefined),
    runbooks: (f) => (f.service ? { service: f.service } : undefined),
    alert_signals: (f) => (f.alert_id ? { alert_id: f.alert_id } : undefined),
  },
  targetKey: "alert_id",
  targetPattern: /^ALR-\d{4}$/,
  goal: (id) => `Triage alert ${id}: decide whether the outage is a configuration error, a hardware failure or an active adversary, and recommend the response.`,
  plannerSystem:
    "You plan incident triage for a context broker. You see only table and column names, never data. " +
    "Reply with one JSON object: {\"tasks\": [{\"type\": \"EXTRACT\"|\"CRITIQUE\"|\"DECIDE\", \"columns\": [\"table.column\", ...]}]}. " +
    "Use exactly three tasks in this order: EXTRACT (read the alert), CRITIQUE (apply the service's triage runbook), DECIDE (final decision, columns []). " +
    "Give each task the fewest columns it needs. Use only names from the catalog.",
  fallbackPlan: [
    { id: "T1_EXTRACT", type: "EXTRACT", columns: ["alerts.service", "alerts.alert_time", "alerts.severity", "alerts.summary"] },
    { id: "T2_CRITIQUE", type: "CRITIQUE", columns: ["runbooks.triage_policy"] },
    { id: "T3_DECIDE", type: "DECIDE", columns: [] },
  ],
  // The critic may be pre-loaded with the Zetaris-computed signals: they are
  // aggregates, never raw rows. Raw log tables are not in the catalog at all.
  homeTable: { EXTRACT: "alerts", CRITIQUE: ["runbooks", "alert_signals"], DECIDE: "" },
  requiredColumns: { EXTRACT: "alerts.service", CRITIQUE: "runbooks.triage_policy" },
  taskSpecs: {
    EXTRACT: {
      lane: "fast",
      think: false,
      instruction: "Normalise this one alert record: confirm the service name, alert_time in ISO 8601 UTC, and severity.",
      outputs: ["service", "alert_time", "severity"],
    },
    CRITIQUE: {
      lane: "fast",
      think: false,
      instruction:
        `Classify this incident by applying triage_policy exactly, checking its rules in the stated order. Every condition must be shown by a measured value in inputs; if one is missing, request it. classification is one of ${CLASSES.join(", ")}.`,
      outputs: ["classification", "rule_applied"],
    },
    DECIDE: {
      lane: "deep",
      think: false,
      instruction:
        `Issue the final triage decision from these verified facts only. decision is one of ${CLASSES.join(", ")}; recommended_action is CONTAIN_AND_ROTATE_CREDENTIALS, ROLLBACK_CHANGE, REPLACE_NODE or INVESTIGATE. Give a one-sentence rationale citing the facts.`,
      outputs: ["decision", "recommended_action", "rationale"],
    },
  },
  critiqueFacts: ["service", "alert_time"],
  extractContext: ["service"],
  valueKey: "recommended_action",
  maxRetries: 5,
  qualifiedExtras: true,
  // Code applies policy TR-7 to the Zetaris-computed signals and compares.
  async guard(facts, outputs, { project, cite }) {
    const cols = ["non_admin_iam_escalations_60m", "egress_gb_outside_allowlist_60m", "config_changes_30m", "nodes_not_ready_30m"];
    const p = await project("alert_signals", cols, facts);
    for (const [c, v] of Object.entries(p.values)) cite(`alert_signals.${c}`, v, p.sql);
    const s = Object.fromEntries(cols.map((c) => [c, Number(p.values[c])]));
    const expected =
      s.non_admin_iam_escalations_60m > 0 && s.egress_gb_outside_allowlist_60m > 1 ? "ACTIVE_ADVERSARY"
      : s.config_changes_30m > 0 ? "CONFIG_ERROR"
      : s.nodes_not_ready_30m > 0 ? "HARDWARE_FAILURE"
      : "UNKNOWN";
    const said = String(outputs.classification).toUpperCase().trim();
    return said === expected ? undefined : `critic said ${said}, policy TR-7 on the measured signals implies ${expected}`;
  },
  cases: [
    { id: "ALR-2001", expect: "ACTIVE_ADVERSARY", value: "CONTAIN_AND_ROTATE_CREDENTIALS", what: "privilege escalation, then 3.4 GB to an unknown IP" },
    { id: "ALR-2002", expect: "CONFIG_ERROR", value: "ROLLBACK_CHANGE", what: "ConfigMap change 8 minutes before the outage" },
    { id: "ALR-2003", expect: "HARDWARE_FAILURE", value: "REPLACE_NODE", what: "node NotReady 8 minutes before, no change" },
    { id: "ALR-2004", expect: "ACTIVE_ADVERSARY", value: "CONTAIN_AND_ROTATE_CREDENTIALS", what: "attack behind a decoy config change and a poisoned alert summary" },
  ],
};
