// Outages (Zetaris or Nightshift unreachable, gateway errors, rate limits, a
// Zetaris driver restart mid-query) are not results. The runner retries them and
// the report leaves out any such row that was written before this list caught it.
export const INFRA = /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|ETIMEDOUT|aborted due to timeout|Zetaris 5\d\d|TTransportException|Nightshift (429|5\d\d)|empty_response|Connection refused/i;

export const isOutage = (row: { error?: unknown; reviewReasons?: unknown }) =>
  INFRA.test([row.error, ...((row.reviewReasons as string[] | undefined) ?? [])].filter(Boolean).join(" "));
