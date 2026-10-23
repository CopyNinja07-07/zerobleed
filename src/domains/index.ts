import { incident } from "./incident.ts";
import { procurement } from "./procurement.ts";
import type { Domain } from "./types.ts";

export const DOMAINS: Record<string, Domain> = { procurement, incident };

export function getDomain(id = "procurement"): Domain {
  const d = DOMAINS[id];
  if (!d) throw new Error(`unknown domain "${id}" (known: ${Object.keys(DOMAINS).join(", ")})`);
  return d;
}

// The domain a target id belongs to, e.g. SHP-1017 -> procurement, ALR-2001 -> incident.
export function domainForId(id: string): Domain {
  const d = Object.values(DOMAINS).find((x) => x.targetPattern.test(id));
  if (!d) throw new Error(`no domain recognises "${id}"`);
  return d;
}

export type { Domain } from "./types.ts";
