// Dev helper: try reasoning controls on the fast lane (no secrets printed).
import { env } from "../src/env.ts";
const variants: Record<string, unknown>[] = [
  {},
  { chat_template_kwargs: { enable_thinking: false } },
  { reasoning_effort: "low" },
  { reasoning_budget: 128 },
];
for (const v of variants) {
  const t0 = Date.now();
  const res = await fetch(env("METERLESS_BASE_URL") + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env("METERLESS_RUNTIME_TOKEN"), "meterless-app": "zerobleed", "meterless-scope": "user", "Content-Type": "application/json" },
    body: JSON.stringify({ model: env("METERLESS_MODEL"), max_tokens: 3000, messages: [{ role: "system", content: "Reply with one JSON object only." }, { role: "user", content: 'Is 21 greater than 14? Return {"answer": true|false}' }], ...v }),
  });
  const d = await res.json();
  console.log(JSON.stringify(v).padEnd(52), res.status, `${Date.now() - t0}ms`, JSON.stringify(d.usage), (d.choices?.[0]?.message?.content ?? JSON.stringify(d.error)).slice(0, 80));
}
