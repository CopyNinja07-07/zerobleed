// Starts everything with one command (npm start):
//   :8000  the API for judges and scripts (POST /run, GET /health)
//   :3030  the auditor dashboard (streams each broker step live)
//   :8787  the three data silos that Zetaris reads as REST tables
// No key ever reaches the browser or a response body.
import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { AGENTS, handleRun } from "./api.ts";
import { runAudit, showValue } from "./broker/broker.ts";
import { domainForId, getDomain } from "./domains/index.ts";
import { runBaseline } from "./baseline.ts";
import { startDataServer } from "./dataServer.ts";
import { isSampleMode } from "./replay.ts";
import { query } from "./zetaris.ts";

const API_PORT = Number(process.env.PORT ?? 8000);
const UI_PORT = Number(process.env.DASHBOARD_PORT ?? 3030);
await startDataServer().catch(() => console.log("[INFO] data silos already served on :8787"));

createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "POST" && path === "/run") return handleRun(req, res);
  if (path === "/health") {
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", sample_mode: isSampleMode(), agents: AGENTS.map((a) => a.name) }));
  }
  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ status: "error", error: { type: "NotFound", message: "POST /run or GET /health", recoverable: true } }));
}).listen(API_PORT, "0.0.0.0", () => console.log(`[INFO] ZeroBleed API: http://localhost:${API_PORT}/run`));

const sse = (res: ServerResponse) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  return (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${UI_PORT}`);
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync("web/index.html"));
    } else if (url.pathname === "/api/targets") {
      // What the user can pick: late shipments, or open alerts.
      const domain = getDomain(url.searchParams.get("domain") ?? "procurement");
      const rows =
        domain.id === "incident"
          ? (await query("SELECT alert_id, service, severity, alert_time, metric FROM incidents.alerts ORDER BY alert_id")).map((r) => ({
              id: r.alert_id, title: `${r.alert_id} · ${r.service}`, detail: `${r.severity}, ${r.metric}, ${String(r.alert_time).slice(11, 16)} UTC`,
            }))
          : (await query("SELECT shipment_id, vendor_id, hub_region, delay_days, breach_date FROM zerobleed.shipments WHERE delay_days > 5 ORDER BY delay_days DESC")).map((r) => ({
              id: r.shipment_id, title: `${r.shipment_id} · ${r.vendor_id}`, detail: `${r.delay_days} days late, ${r.hub_region}, ${r.breach_date ?? ""}`,
            }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
    } else if (url.pathname === "/api/audit") {
      const send = sse(res);
      const id = url.searchParams.get("id") ?? "SHP-1017";
      const domain = domainForId(id);
      const result = await runAudit({ id, domain: domain.id }, { onEvent: (e) => send("step", e), historyDir: ".zerobleed" });
      send("result", {
        decision: result.decision,
        valueKey: result.valueKey,
        valueText: showValue(domain, result.decision?.[result.valueKey]),
        needsHumanReview: result.needsHumanReview,
        reviewReasons: result.reviewReasons,
        plan: result.plan,
        citations: result.citations,
        ledger: result.ledger,
        totals: result.totals,
        traceFile: result.traceFile,
        chunks: result.run.chunks.map((c) => ({ id: c.id, carryover: c.carryover, content: c.content, tool: c.toolCall })),
        reflection: result.run.reflection,
      });
      res.end();
    } else if (url.pathname === "/api/baseline") {
      const send = sse(res);
      const id = url.searchParams.get("id") ?? "SHP-1017";
      const result = await runBaseline(id, domainForId(id).id);
      send("result", result);
      res.end();
    } else {
      res.writeHead(404).end();
    }
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (err as Error).message.slice(0, 300) }));
  }
}).listen(UI_PORT, "0.0.0.0", () => console.log(`[INFO] ZeroBleed dashboard: http://localhost:${UI_PORT}`));
