// Power plane client: Meterless Nightshift as the primary AI provider.
// OpenAI-compatible Runtime contract: Bearer token, meterless-app and
// meterless-scope headers, POST /v1/chat/completions, GET /v1/models.
// Every call is stateless: the caller passes the full (tiny) message list.
import { env } from "./env.ts";
import { withReplay } from "./replay.ts";

export type Lane = "fast" | "deep";

export interface ChatResult {
  text: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  ms: number;
  receiptId?: string; // Nightshift compute receipt, proof the request went through Meterless
}

const headers = () => ({
  Authorization: "Bearer " + env("METERLESS_RUNTIME_TOKEN"),
  "meterless-app": "zerobleed",
  "meterless-scope": "user",
  // Large cloud models can be slow to start; give the first token up to 60s.
  "meterless-ttfb-ms": "60000",
  "Content-Type": "application/json",
});

// Contract (Meterless Runtime 0.90.0): accept any pasted URL and normalise it
// to <host>/v1, never /v1/v1.
export function baseUrl(): string {
  let u = env("METERLESS_BASE_URL").trim();
  if (!/^https?:\/\//.test(u)) u = "http://" + u;
  u = u.replace(/\/(v1\/)?(chat\/completions|models)\/?$/, "").replace(/\/healthz\/?$/, "").replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  return `${u}/v1`;
}

export function modelFor(lane: Lane): string {
  return lane === "deep" ? env("METERLESS_DEEP_MODEL") : env("METERLESS_MODEL");
}

// Nemotron reasoning models may think out loud before answering. Keep only the answer.
function stripReasoning(text: string): string {
  const closed = text.lastIndexOf("</think>");
  return (closed >= 0 ? text.slice(closed + 8) : text).trim();
}

export interface ChatOptions {
  think?: boolean; // Nemotron reasoning mode; off by default (bounded micro-tasks rarely need it)
  maxTokens?: number;
}

// Hidden reasoning counts against max_tokens, so the budget is generous.
// An empty answer (reasoning ran out of budget) is retried once with double the budget.
export type Message = { role: "system" | "user" | "assistant"; content: string };

export async function chat(lane: Lane, system: string, user: string, opts: ChatOptions = {}): Promise<ChatResult> {
  return chatMessages(lane, [{ role: "system", content: system }, { role: "user", content: user }], opts);
}

// Multi-turn form. ZeroBleed itself never uses history; the baseline does.
export async function chatMessages(lane: Lane, messages: Message[], opts: ChatOptions = {}): Promise<ChatResult> {
  const think = opts.think ?? false;
  const maxTokens = opts.maxTokens ?? (think ? 4000 : 800);
  return withReplay("nightshift", { lane, messages, think }, () => chatLive(lane, messages, maxTokens, think));
}

// One bounded retry: an empty answer gets double the budget, a transient
// gateway error (502/503/504) is simply tried again.
async function chatLive(lane: Lane, messages: Message[], maxTokens: number, think: boolean): Promise<ChatResult> {
  try {
    return await chatOnce(lane, messages, maxTokens, think);
  } catch (err) {
    const msg = (err as Error).message;
    if (/empty_response/.test(msg)) return chatOnce(lane, messages, maxTokens * 2, think);
    if (/Nightshift 50[234]/.test(msg)) return chatOnce(lane, messages, maxTokens, think);
    throw err;
  }
}

async function chatOnce(lane: Lane, messages: Message[], maxTokens: number, think: boolean): Promise<ChatResult> {
  const model = modelFor(lane);
  const started = Date.now();
  const res = await fetch(baseUrl() + "/chat/completions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: think },
      messages,
    }),
    signal: AbortSignal.timeout(180_000), // contract: 180 s, a cold model load can take minutes
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Nightshift ${res.status} (${model}): ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  const msg = data.choices?.[0]?.message ?? {};
  return {
    text: stripReasoning(msg.content ?? ""),
    model: data.model ?? model,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
    ms: Date.now() - started,
    receiptId: data.meterless?.receipt_id,
  };
}

// Contract: GET /v1/models decides status. 401/403 = unauthorized, 200 with
// meterless ids = online, anything else = offline. /healthz alone proves nothing.
export async function providerStatus(): Promise<{ status: "online" | "unauthorized" | "offline"; models: string[]; missing: string[] }> {
  try {
    const res = await fetch(baseUrl() + "/models", { headers: headers(), signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) return { status: "unauthorized", models: [], missing: [] };
    if (!res.ok) return { status: "offline", models: [], missing: [] };
    const models: string[] = ((await res.json()).data ?? []).map((m: { id: string }) => m.id);
    const online = models.some((m) => m.startsWith("meterless/"));
    const missing = [modelFor("fast"), modelFor("deep")].filter((m) => !models.includes(m));
    return { status: online ? "online" : "offline", models, missing };
  } catch {
    return { status: "offline", models: [], missing: [] };
  }
}
