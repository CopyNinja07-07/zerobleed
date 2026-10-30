#!/bin/bash
# Unattended full run: alternates batches of both domains until every case has
# run under every framework, then writes the report. Safe to restart: finished
# runs are skipped. Usage: nohup bash scripts/benchAll.sh > evidence/bench/run.log 2>&1 &
set -u
FRAMEWORKS="${FRAMEWORKS:-zerobleed,zerobleed-batch,shared,summary,guard,dual,react}"
BATCH="${BATCH:-10}"
DRIVER="${ZETARIS_DRIVER:-zetaris-driver-1}"
DRIVER_MAX_GB="${DRIVER_MAX_GB:-6}"

driver_gb() {
  docker stats --no-stream --format '{{.MemUsage}}' "$DRIVER" 2>/dev/null | awk '{v=$1; if (v ~ /GiB/) {sub(/GiB/,"",v); print v} else if (v ~ /MiB/) {sub(/MiB/,"",v); print v/1024} else print 0}'
}

while true; do
  before=$(cat evidence/bench/*.jsonl 2>/dev/null | wc -l)
  for d in procurement-bench incident-bench; do
    # The Zetaris driver's memory grows over long runs; restart it before it nears Docker's limit.
    gb=$(driver_gb)
    if awk "BEGIN{exit !(${gb:-0} > $DRIVER_MAX_GB)}"; then
      echo "$(date -u +%FT%TZ) Zetaris driver at ${gb} GB: restarting it"
      docker restart "$DRIVER" && sleep 90
    fi
    npm run -s bench -- --domain "$d" --frameworks "$FRAMEWORKS" --limit "$BATCH"
    code=$?
    if [ $code -eq 3 ]; then echo "$(date -u +%FT%TZ) stopped by the Nightshift memory guard"; exit 3; fi
    if [ $code -eq 4 ]; then echo "$(date -u +%FT%TZ) services unreachable: waiting 5 minutes"; sleep 300; fi
  done
  after=$(cat evidence/bench/*.jsonl 2>/dev/null | wc -l)
  echo "$(date -u +%FT%TZ) runs on file: $after"
  npm run -s bench:report > /dev/null
  # Done only after two rounds in a row add nothing (one empty round can be an outage).
  if [ "$after" -eq "$before" ]; then idle=$(( ${idle:-0} + 1 )); else idle=0; fi
  [ "${idle:-0}" -ge 2 ] && break
  [ "${idle:-0}" -eq 1 ] && sleep 300
done
echo "$(date -u +%FT%TZ) no new runs in two rounds: finished (check REPORT.md run counts)"
npm run -s bench:report > /dev/null
