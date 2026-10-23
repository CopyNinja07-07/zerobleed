// The comparison: a conventional shared-history agent pipeline. Same models,
// same Zetaris data, same question. The difference is the architecture: the
// raw rows go into one conversation that every later turn re-reads.
import { getDomain } from "./domains/index.ts";
import { chatMessages, type ChatResult, type Lane, type Message } from "./llm.ts";
import { query } from "./zetaris.ts";

export interface BaselineResult {
  decision?: { decision: string; rationale: string; [key: string]: string };
  turns: { turn: string; lane: Lane; model: string; inputTokens: number; outputTokens: number; ms: number; receiptId?: string }[];
  totals: { inputTokens: number; outputTokens: number; llmCalls: number; ms: number };
  error?: string;
}

interface BaselineSetup {
  data(id: string): Promise<string>;
  steps(id: string): [string, Lane, string][];
}

const SETUPS: Record<string, BaselineSetup> = {
  procurement: {
    async data() {
      const [shipments, contracts, weather] = await Promise.all([
        query("SELECT * FROM zerobleed.shipments"),
        query("SELECT * FROM zerobleed.contracts"),
        query("SELECT * FROM zerobleed.force_majeure"),
      ]);
      return `SHIPMENTS: ${JSON.stringify(shipments)}\nCONTRACTS: ${JSON.stringify(contracts)}\nFORCE_MAJEURE_LOGS: ${JSON.stringify(weather)}`;
    },
    steps: (id) => [
      ["EXTRACT", "fast", `Extract the delay_days, breach_date, hub_region and vendor_id for shipment ${id}.`],
      ["CRITIQUE", "fast", "Find that vendor's contract clause and say whether its penalty applies to this delay."],
      ["WEATHER", "fast", "Check the force majeure log for that date and region. Was a waiver active?"],
      ["DECIDE", "deep", 'Give the final decision as one JSON object: {"decision": "ENFORCE"|"WAIVE"|"NO_BREACH", "penalty_usd": number, "rationale": "one sentence"}.'],
    ],
  },
  incident: {
    // A typical responder pipeline: pull the alert, the runbook and every raw
    // log line from the hour before the alert, and hand it all to the model.
    async data(id) {
      const [alert] = await query(`SELECT * FROM incidents.alerts WHERE alert_id = '${id}'`);
      const ts = Number(alert.ts);
      const win = `ts BETWEEN ${ts - 3600} AND ${ts}`;
      const [runbook, cloudtrail, flows, k8s] = await Promise.all([
        query(`SELECT * FROM incidents.runbooks WHERE service = '${alert.service}'`),
        query(`SELECT event_time, principal, principal_type, action, resource, source_ip FROM incidents.cloudtrail WHERE ${win}`),
        query(`SELECT flow_time, src_ip, dst_ip, dst_owner, bytes_out FROM incidents.vpc_flows WHERE ${win}`),
        query(`SELECT event_time, namespace, object, reason, node, message FROM incidents.k8s_events WHERE ${win}`),
      ]);
      return (
        `ALERT: ${JSON.stringify(alert)}\nRUNBOOK: ${JSON.stringify(runbook)}\nCLOUDTRAIL_LAST_HOUR: ${JSON.stringify(cloudtrail)}\n` +
        `VPC_FLOWS_LAST_HOUR: ${JSON.stringify(flows)}\nK8S_EVENTS_LAST_HOUR: ${JSON.stringify(k8s)}`
      );
    },
    // Three turns, not five: each turn re-reads about 60,000 tokens of logs.
    steps: (id) => [
      ["SIGNALS", "fast", `For alert ${id}, list from the logs: any IAM privilege escalation by a non-admin principal, the total GB sent to destinations outside the allowlist, any ConfigMap or Deployment change, and any node NotReady, with times. Then apply the runbook's triage policy in its stated order.`],
      [
        "DECIDE",
        "deep",
        'Give the final decision as one JSON object: {"decision": "ACTIVE_ADVERSARY"|"CONFIG_ERROR"|"HARDWARE_FAILURE"|"UNKNOWN", "recommended_action": "CONTAIN_AND_ROTATE_CREDENTIALS"|"ROLLBACK_CHANGE"|"REPLACE_NODE"|"INVESTIGATE", "rationale": "one sentence"}.',
      ],
    ],
  },
};

export async function runBaseline(id: string, domainId = "procurement"): Promise<BaselineResult> {
  const started = Date.now();
  const setup = SETUPS[getDomain(domainId).id];
  const history: Message[] = [
    { role: "system", content: "You are a team of audit agents sharing one conversation. Answer each request briefly." },
    { role: "user", content: `Here is all the data for the audit.\n${await setup.data(id)}\nAcknowledge in one line.` },
  ];
  const steps: [string, Lane, string][] = [["LOAD", "fast", ""], ...setup.steps(id)];
  const turns: BaselineResult["turns"] = [];
  let last: ChatResult | undefined;
  try {
    for (const [turn, lane, ask] of steps) {
      if (ask) history.push({ role: "user", content: ask });
      last = await chatMessages(lane, history, { maxTokens: 1200 });
      history.push({ role: "assistant", content: last.text });
      turns.push({ turn, lane, model: last.model, inputTokens: last.usage.input_tokens, outputTokens: last.usage.output_tokens, ms: last.ms, receiptId: last.receiptId });
    }
  } catch (err) {
    return { turns, totals: totalsOf(turns, started), error: (err as Error).message.slice(0, 300) };
  }
  let decision: BaselineResult["decision"];
  try {
    const t = last!.text;
    const o = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    decision = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])) as BaselineResult["decision"];
  } catch {
    decision = undefined;
  }
  return { decision, turns, totals: totalsOf(turns, started) };
}

function totalsOf(turns: BaselineResult["turns"], started: number) {
  return {
    inputTokens: turns.reduce((s, t) => s + t.inputTokens, 0),
    outputTokens: turns.reduce((s, t) => s + t.outputTokens, 0),
    llmCalls: turns.length,
    ms: Date.now() - started,
  };
}
