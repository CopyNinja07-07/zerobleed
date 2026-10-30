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
  done
  after=$(cat evidence/bench/*.jsonl 2>/dev/null | wc -l)
  echo "$(date -u +%FT%TZ) runs on file: $after"
  npm run -s bench:report > /dev/null
  [ "$after" -eq "$before" ] && break
done
echo "$(date -u +%FT%TZ) all runs done"
npm run -s bench:report > /dev/null
