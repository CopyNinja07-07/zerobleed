// A thin pass-through to Nightshift for third-party agents (Letta) that cannot
// send Nightshift's headers. Adds the runtime token and meterless headers,
// forwards /v1/* unchanged, and keeps a log of every call's usage and receipt
// (GET /calls?since=N) so their tokens are counted like everyone else's.
// Usage: npx tsx scripts/nightshiftProxy.ts     (127.0.0.1:8095; Docker Desktop reaches it as host.docker.internal)
import { createServer } from "node:http";
import { baseUrl } from "../src/llm.ts";
import { env } from "../src/env.ts";

const PORT = Number(process.env.PROXY_PORT ?? 8095);
const calls: { seq: number; kind: string; model: string; in: number; out: number; ms: number; receipt?: string }[] = [];
let seq = 0;

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/calls") {
    const since = Number(url.searchParams.get("since") ?? 0);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ last: seq, calls: calls.filter((c) => c.seq > since) }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  let body = Buffer.concat(chunks).toString("utf8");
  // Same model settings as every other framework: temperature 0, Nemotron's thinking mode off.
  if (url.pathname.endsWith("/chat/completions")) {
    try {
      const j = JSON.parse(body);
      j.temperature ??= 0;
      j.chat_template_kwargs ??= { enable_thinking: false };
      body = JSON.stringify(j);
    } catch {
      // not JSON: forward as is
    }
  }
  const started = Date.now();
  try {
    const upstream = await fetch(baseUrl() + url.pathname.replace(/^\/v1/, "") + url.search, {
      method: req.method,
      headers: {
        Authorization: "Bearer " + env("METERLESS_RUNTIME_TOKEN"),
        "meterless-app": "zerobleed",
        "meterless-scope": "user",
        "meterless-ttfb-ms": "60000",
        "Content-Type": "application/json",
      },
      body: req.method === "GET" ? undefined : body,
      signal: AbortSignal.timeout(180_000),
    });
    const text = await upstream.text();
    try {
      const d = JSON.parse(text);
      if (d.usage) {
        const kind = url.pathname.endsWith("/embeddings") ? "embed" : "chat";
        calls.push({ seq: ++seq, kind, model: d.model ?? "", in: d.usage.prompt_tokens ?? 0, out: d.usage.completion_tokens ?? 0, ms: Date.now() - started, receipt: d.meterless?.receipt_id });
        if (calls.length > 50_000) calls.splice(0, 10_000);
      }
    } catch {
      // streamed or non-JSON bodies are passed through uncounted
    }
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(text);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Nightshift proxy on 127.0.0.1:${PORT}`));
