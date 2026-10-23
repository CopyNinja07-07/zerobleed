// The ZeroBleed dashboard: a local web app for the auditor. It streams each
// broker step live (Server-Sent Events), shows the scratchpad passed between
// steps, the interrupt gate, the evidence trail and the token ledger, and can
// run the shared-history baseline side by side. No key ever reaches the browser.
import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { runAudit } from "./broker/broker.ts";
import { runBaseline } from "./baseline.ts";
import { startDataServer } from "./dataServer.ts";
import { query } from "./zetaris.ts";

const PORT = Number(process.env.PORT ?? 3030);
await startDataServer().catch(() => undefined);

const sse = (res: ServerResponse) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  return (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync("web/index.html"));
    } else if (url.pathname === "/api/shipments") {
      const rows = await query("SELECT shipment_id, vendor_id, hub_region, delay_days, breach_date FROM zerobleed.shipments WHERE delay_days > 5 ORDER BY delay_days DESC");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
    } else if (url.pathname === "/api/audit") {
      const send = sse(res);
      const shipment_id = url.searchParams.get("shipment") ?? "SHP-1017";
      const result = await runAudit({ shipment_id }, { onEvent: (e) => send("step", e), historyDir: ".zerobleed" });
      send("result", {
        decision: result.decision,
        needsHumanReview: result.needsHumanReview,
        reviewReasons: result.reviewReasons,
        plan: result.plan,
        citations: result.citations,
        ledger: result.ledger,
        totals: result.totals,
        chunks: result.run.chunks.map((c) => ({ id: c.id, carryover: c.carryover, content: c.content, tool: c.toolCall })),
        reflection: result.run.reflection,
      });
      res.end();
    } else if (url.pathname === "/api/baseline") {
      const send = sse(res);
      const shipment_id = url.searchParams.get("shipment") ?? "SHP-1017";
      send("step", "Loading every row of all three silos into one shared conversation");
      const result = await runBaseline(shipment_id);
      send("result", result);
      res.end();
    } else {
      res.writeHead(404).end();
    }
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (err as Error).message.slice(0, 300) }));
  }
}).listen(PORT, () => console.log(`ZeroBleed dashboard: http://localhost:${PORT}`));
