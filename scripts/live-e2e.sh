#!/usr/bin/env bash
# Live end-to-end validation: real DeepSeek-Harness + bridge plugin + Mission
# Control server, asserting actual board state afterwards.
#
# Modes (auto-selected):
#   mock  — no DEEPSEEK_API_KEY set. Runs dsh against a local mock
#           OpenAI-compatible model (scripts/e2e-mock-llm.js) via a
#           hand-declared provider route. Validates everything the bridge
#           owns without any external dependency. This is what CI runs.
#   real  — DEEPSEEK_API_KEY set. Runs dsh against DeepSeek's official API
#           (deepseek-official / deepseek-v4-flash, the harness defaults).
#           One green run in this mode closes issue #1.
#
# Env knobs: DSH_VERSION (default 0.1.0-rc.7), MC_PORT (default 3556),
#            MOCK_LLM_PORT (default 4517), E2E_WORKDIR (default mktemp).
#
# Intended for CI on a fresh checkout: it starts the repo's server, which
# writes E2E artifacts into .mission-control/. On a working copy, artifacts
# are cleaned up on exit, but prefer a scratch clone.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${E2E_WORKDIR:-$(mktemp -d)}"
mkdir -p "$WORK"
DSH_VERSION="${DSH_VERSION:-0.1.0-rc.7}"
MC_PORT="${MC_PORT:-3556}"
MOCK_LLM_PORT="${MOCK_LLM_PORT:-4517}"

MODE=mock
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then MODE=real; fi
echo "── live-e2e: mode=${MODE} dsh=${DSH_VERSION} workdir=${WORK}"

PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  rm -f "$ROOT"/.mission-control/tasks/task-*-dsh-*.json \
        "$ROOT"/.mission-control/agents/agent-dsh-e2e.json \
        "$ROOT"/.mission-control/messages/msg-*.json \
        "$ROOT"/.mission-control/logs/*.log 2>/dev/null || true
}
trap cleanup EXIT

# ── 1. Mission Control server ───────────────────────────────────────────────
echo "→ Installing server dependencies"
(cd "$ROOT/server" && (npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund) > /dev/null)
echo "→ Starting Mission Control on :${MC_PORT}"
(cd "$ROOT/server" && PORT="$MC_PORT" exec node index.js > "$WORK/mc.log" 2>&1) &
PIDS+=($!)
for i in $(seq 1 20); do
  curl -sf "http://127.0.0.1:${MC_PORT}/api/metrics" > /dev/null 2>&1 && break
  [ "$i" = 20 ] && { echo "❌ Mission Control did not start"; tail -20 "$WORK/mc.log"; exit 1; }
  sleep 1
done
echo "  ✓ board up"

# ── 2. Mock model (mock mode only) ─────────────────────────────────────────
if [ "$MODE" = mock ]; then
  echo "→ Starting mock model on :${MOCK_LLM_PORT}"
  MOCK_LLM_PORT="$MOCK_LLM_PORT" node "$ROOT/scripts/e2e-mock-llm.js" > "$WORK/mock-llm.log" 2>&1 &
  PIDS+=($!)
  sleep 1
  curl -sf "http://127.0.0.1:${MOCK_LLM_PORT}/v1/models" > /dev/null || { echo "❌ mock model did not start"; exit 1; }
  echo "  ✓ mock model up"
fi

# ── 3. DeepSeek-Harness + bridge plugin ────────────────────────────────────
echo "→ Installing @deepseek-ai/dsh@${DSH_VERSION} (takes a few minutes)"
mkdir -p "$WORK/dsh-env" && cd "$WORK/dsh-env"
npm init -y > /dev/null
npm install "@deepseek-ai/dsh@${DSH_VERSION}" --no-audit --no-fund > /dev/null

export DSH_HOME="$WORK/dsh-home"
echo "→ Installing the bridge plugin into the headless profile (self-activating)"
npx dsh plugin --profile headless add "$ROOT/integrations/deepseek-harness/dsh-plugin-mission-control" > /dev/null

PATCH_ARGS=()
if [ "$MODE" = mock ]; then
  cat > "$WORK/e2e.patch.yml" <<YML
# Mock-mode overlay: hand-declared openai-completions route to the local mock.
- id: llm-pi-ai
  config:
    providers:
      mock:
        displayName: Mock Model
        apiKeyEnv: MOCK_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${MOCK_LLM_PORT}/v1
        models:
          - id: mock-model
            name: Mock Model
            contextWindow: 65536
            maxTokens: 4096
- id: agent-default-model
  config:
    provider: mock
    model: mock-model
- id: session-title-llm
  disabled: true
YML
  PATCH_ARGS=(--patch "$WORK/e2e.patch.yml")
  export MOCK_API_KEY=mock-key
fi
# real mode needs no overlay: the harness defaults to deepseek-official.

# ── 4. Run a headless session ──────────────────────────────────────────────
export MISSION_CONTROL_URL="http://127.0.0.1:${MC_PORT}"
export MC_AGENT_ID="agent-dsh-e2e"
echo "→ Running dsh headless (${MODE} model)"
OUTPUT=$(timeout 300 npx dsh --profile headless "${PATCH_ARGS[@]}" "Reply with a short greeting and finish." 2>&1 | tail -5)
echo "  dsh output: $(echo "$OUTPUT" | tail -1)"

# ── 5. Assert board state ──────────────────────────────────────────────────
echo "→ Asserting board state"
TASKS=$(curl -sf "http://127.0.0.1:${MC_PORT}/api/tasks")
AGENTS=$(curl -sf "http://127.0.0.1:${MC_PORT}/api/agents")

echo "$TASKS" | python3 -c '
import json, sys
tasks = [t for t in json.load(sys.stdin) if "dsh" in t.get("labels", [])]
assert tasks, "no dsh task on the board"
t = tasks[0]
assert t["status"] == "REVIEW", "expected REVIEW, got " + str(t["status"])
assert t["assignee"] == "agent-dsh-e2e", "unexpected assignee " + str(t["assignee"])
print("  \u2713 task " + t["id"] + " -> " + t["status"])'

echo "$AGENTS" | python3 -c '
import json, sys
agents = {a["id"]: a for a in json.load(sys.stdin)}
a = agents.get("agent-dsh-e2e")
assert a, "bridge agent not registered"
assert a["model"] == "deepseek-harness", "unexpected model " + str(a["model"])
print("  \u2713 agent " + a["id"] + " registered (" + a["model"] + ")")'

ACTIVITY=$(curl -sf "http://127.0.0.1:${MC_PORT}/api/logs/activity")
for marker in TURN_START USER_MESSAGE ASSISTANT_MESSAGE TURN_END; do
  echo "$ACTIVITY" | grep -q "$marker" || { echo "❌ activity log missing $marker"; exit 1; }
done
echo "  ✓ activity log carries TURN_START / USER_MESSAGE / ASSISTANT_MESSAGE / TURN_END"

echo ""
echo "✅ live-e2e PASSED (mode=${MODE}, dsh=${DSH_VERSION})"
if [ "$MODE" = mock ]; then
  echo "   Run again with DEEPSEEK_API_KEY set for the real-provider confirmation (issue #1)."
fi
