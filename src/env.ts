// Loads settings from .env without printing them. Secrets never leave this module
// except as request headers.
import { readFileSync, existsSync } from "node:fs";
import { isSampleMode } from "./replay.ts";

const loaded: Record<string, string> = {};
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) loaded[m[1]] = m[2];
  }
}

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? loaded[name] ?? fallback;
  // SAMPLE_MODE replays recordings, so no service credentials are needed.
  if (isSampleMode() && (v === undefined || v.startsWith("paste-your"))) return "sample-mode";
  if (v === undefined || v === "" || v.startsWith("paste-your")) throw new Error(`${name} is missing from .env`);
  return v;
}
