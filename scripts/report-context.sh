#!/bin/bash
# report-context.sh — agent reports context window usage to local Mission Control
# Called from a cron job or agent heartbeat.
#
# Usage: ./scripts/report-context.sh <agent_id> <tokens_used> <tokens_total> [model]
#
# Example (from a cron job or agent exec tool):
#   ./scripts/report-context.sh oracle 45000 200000 claude-sonnet-4-6
#
# Or use environment variables:
#   export MC_AGENT_ID=oracle
#   export MC_CONTEXT_USED=45000
#   export MC_CONTEXT_TOTAL=200000
#   ./scripts/report-context.sh

AGENT_ID="${1:-${MC_AGENT_ID:-agent}}"
USED="${2:-${MC_CONTEXT_USED:-0}}"
TOTAL="${3:-${MC_CONTEXT_TOTAL:-200000}}"
MODEL="${4:-${MC_MODEL:-unknown}}"
MC_PORT="${MC_PORT:-3001}"
MC_SERVER="${MC_SERVER_URL:-http://localhost:$MC_PORT}"

curl -s -X POST "$MC_SERVER/api/agents/$AGENT_ID/context" \
  -H "Content-Type: application/json" \
  -d "{\"used\":$USED,\"total\":$TOTAL,\"model\":\"$MODEL\"}" \
  --max-time 5 > /dev/null

exit 0
