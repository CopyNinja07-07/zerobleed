// Power plane client: Meterless Nightshift as the primary AI provider.
// OpenAI-compatible Runtime contract: Bearer token, meterless-app and
// meterless-scope headers, POST /v1/chat/completions, GET /v1/models.
// Every call is stateless: the caller passes the full (tiny) message list.
import { env } from "./env.ts";

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
  "Content-Type": "application/json",
});

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
  try {
    return await chatOnce(lane, messages, maxTokens, think);
  } catch (err) {
    if (!/empty_response/.test((err as Error).message)) throw err;
    return chatOnce(lane, messages, maxTokens * 2, think);
  }
}

async function chatOnce(lane: Lane, messages: Message[], maxTokens: number, think: boolean): Promise<ChatResult> {
  const model = modelFor(lane);
  const started = Date.now();
  const res = await fetch(env("METERLESS_BASE_URL").replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: think },
      messages,
    }),
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

export async function listModels(): Promise<string[]> {
  const res = await fetch(env("METERLESS_BASE_URL").replace(/\/$/, "") + "/models", { headers: headers() });
  if (!res.ok) throw new Error(`Nightshift ${res.status} on /models`);
  return ((await res.json()).data ?? []).map((m: { id: string }) => m.id);
}
