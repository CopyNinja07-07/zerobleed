// SAMPLE_MODE and service fallback. Every live Zetaris or Nightshift response
// is recorded to fixtures/, keyed by a hash of the request. With SAMPLE_MODE=true
// the app replays those recordings and runs fully offline. In live mode, if a
// service is unreachable, the same recording is used as a fallback and the
// event is reported, so a demo never dies on a network blip.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "fixtures";
export const SAMPLE_MODE = /^(1|true|yes)$/i.test(process.env.SAMPLE_MODE ?? "");

const listeners: ((msg: string) => void)[] = [];
export function onFallback(fn: (msg: string) => void): () => void {
  listeners.push(fn);
  return () => listeners.splice(listeners.indexOf(fn), 1);
}

const keyOf = (service: string, request: unknown) => createHash("sha256").update(service + JSON.stringify(request)).digest("hex").slice(0, 24);

function load<T>(service: string, request: unknown): T | undefined {
  const file = `${DIR}/${service}-${keyOf(service, request)}.json`;
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
}

export async function withReplay<T>(service: "zetaris" | "nightshift", request: unknown, live: () => Promise<T>): Promise<T> {
  if (SAMPLE_MODE) {
    const hit = load<T>(service, request);
    if (hit === undefined) throw new Error(`SAMPLE_MODE: no recording for this ${service} request. Run once live to record it.`);
    return hit;
  }
  try {
    const result = await live();
    mkdirSync(DIR, { recursive: true });
    writeFileSync(`${DIR}/${service}-${keyOf(service, request)}.json`, JSON.stringify(result));
    return result;
  } catch (err) {
    const msg = (err as Error).message;
    const unreachable = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket|50[234]/i.test(msg);
    const hit = unreachable ? load<T>(service, request) : undefined;
    if (hit === undefined) throw err;
    for (const fn of listeners) fn(`${service} unavailable (${msg.slice(0, 80)}); used the recorded response`);
    return hit;
  }
}
