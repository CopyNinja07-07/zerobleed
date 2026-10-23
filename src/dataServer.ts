// Stands in for three separate enterprise systems (ERP, legal, weather) by
// serving each silo as its own JSON API. Zetaris registers these endpoints as
// REST tables, so the agent only ever reaches the data through Zetaris SQL.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.DATA_PORT ?? 8787);
const silos: Record<string, string> = {
  "/erp/shipments": "data/shipments.json",
  "/legal/contracts": "data/contracts.json",
  "/weather/force_majeure": "data/force_majeure.json",
  // Domain 2: incident response
  "/aws/cloudtrail": "data/incident/cloudtrail.json",
  "/aws/vpc_flows": "data/incident/vpc_flows.json",
  "/k8s/events": "data/incident/k8s_events.json",
  "/datadog/alerts": "data/incident/alerts.json",
  "/sre/runbooks": "data/incident/runbooks.json",
};

export function startDataServer(port = PORT) {
  const server = createServer((req, res) => {
    const file = silos[(req.url ?? "").split("?")[0]];
    if (!file) {
      res.writeHead(404).end("unknown silo");
      return;
    }
    // Wrapped in {"records": [...]}: Zetaris flattens an array-of-structs field with explode().
    res.writeHead(200, { "content-type": "application/json" }).end(`{"records":${readFileSync(file, "utf8")}}`);
  });
  // Rejects if the port is taken (another ZeroBleed process already serves the silos).
  return new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startDataServer();
  console.log(`data silos on http://localhost:${PORT}: ${Object.keys(silos).join(", ")}`);
}
