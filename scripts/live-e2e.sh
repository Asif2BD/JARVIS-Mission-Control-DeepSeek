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
# Safe on working installations: the server runs against an ISOLATED data
# directory under the (ephemeral) workdir via MISSION_CONTROL_DIR, so this
# checkout's .mission-control/ is never read, written, or cleaned.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Caller-supplied E2E_WORKDIR is preserved across runs (caches the dsh
# install); a script-created mktemp dir is removed on exit.
if [ -n "${E2E_WORKDIR:-}" ]; then
  WORK="$E2E_WORKDIR"; WORK_CREATED=0
else
  WORK="$(mktemp -d)"; WORK_CREATED=1
fi
mkdir -p "$WORK"
# Normalize to an absolute path: later stages cd into other directories and
# a relative E2E_WORKDIR would resolve against the wrong base.
WORK="$(cd "$WORK" && pwd)"
DSH_VERSION="${DSH_VERSION:-0.1.0-rc.7}"
MC_PORT="${MC_PORT:-3556}"
MOCK_LLM_PORT="${MOCK_LLM_PORT:-4517}"

MODE=mock
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then MODE=real; fi
echo "── live-e2e: mode=${MODE} dsh=${DSH_VERSION} workdir=${WORK}"

PIDS=()
# Isolated, PER-RUN data directory: the server never touches the checkout's
# data, and a reused workdir cannot leak a previous run's tasks/agents into
# this run's assertions.
export MISSION_CONTROL_DIR="$WORK/mc-data.$$"
rm -rf "$MISSION_CONTROL_DIR"
mkdir -p "$MISSION_CONTROL_DIR"/{tasks,agents,humans,messages,queue,logs}
# Never let the test server sync to a MissionDeck cloud workspace, even on a
# checkout that is connected (env key or .missiondeck file present).
export MISSIONDECK_SYNC=off
unset MISSIONDECK_API_KEY MISSIONDECK_SLUG 2>/dev/null || true
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$MISSION_CONTROL_DIR" 2>/dev/null || true
  if [ "${WORK_CREATED}" = 1 ]; then rm -rf "$WORK" 2>/dev/null || true; fi
}
trap cleanup EXIT

# ── 1. Mission Control server ───────────────────────────────────────────────
echo "→ Installing server dependencies"
(cd "$ROOT/server" && (npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund) > /dev/null)
# Refuse to run against a port that is already answering: any response
# there would come from a foreign instance we must not write E2E data into.
if curl -sf "http://127.0.0.1:${MC_PORT}/api/metrics" > /dev/null 2>&1; then
  echo "❌ Port ${MC_PORT} is already serving a Mission Control API — pick another MC_PORT"
  exit 1
fi
echo "→ Starting Mission Control on :${MC_PORT}"
: > "$WORK/mc.log"
(cd "$ROOT/server" && PORT="$MC_PORT" exec node index.js > "$WORK/mc.log" 2>&1) &
MC_PID=$!
PIDS+=("$MC_PID")
# Readiness is tied to OUR process: its own log must report server_start AND
# the PID must still be alive — a foreign responder can satisfy neither.
for i in $(seq 1 20); do
  if ! kill -0 "$MC_PID" 2>/dev/null; then
    echo "❌ Mission Control process exited during startup"; tail -20 "$WORK/mc.log"; exit 1
  fi
  grep -q "server_start" "$WORK/mc.log" 2>/dev/null && break
  [ "$i" = 20 ] && { echo "❌ Mission Control did not start"; tail -20 "$WORK/mc.log"; exit 1; }
  sleep 1
done
curl -sf "http://127.0.0.1:${MC_PORT}/api/metrics" > /dev/null || { echo "❌ board not answering after start"; exit 1; }
echo "  ✓ board up (pid ${MC_PID}, data dir ${MISSION_CONTROL_DIR})"

# ── 2. Mock model (mock mode only) ─────────────────────────────────────────
if [ "$MODE" = mock ]; then
  if curl -sf "http://127.0.0.1:${MOCK_LLM_PORT}/v1/models" > /dev/null 2>&1; then
    echo "❌ Port ${MOCK_LLM_PORT} is already serving a model API — pick another MOCK_LLM_PORT"
    exit 1
  fi
  echo "→ Starting mock model on :${MOCK_LLM_PORT}"
  : > "$WORK/mock-llm.log"
  MOCK_LLM_PORT="$MOCK_LLM_PORT" node "$ROOT/scripts/e2e-mock-llm.js" > "$WORK/mock-llm.log" 2>&1 &
  MOCK_PID=$!
  PIDS+=("$MOCK_PID")
  for i in $(seq 1 10); do
    if ! kill -0 "$MOCK_PID" 2>/dev/null; then
      echo "❌ mock model process exited during startup"; tail -5 "$WORK/mock-llm.log"; exit 1
    fi
    grep -q "listening" "$WORK/mock-llm.log" 2>/dev/null && break
    [ "$i" = 10 ] && { echo "❌ mock model did not start"; tail -5 "$WORK/mock-llm.log"; exit 1; }
    sleep 1
  done
  echo "  ✓ mock model up (pid ${MOCK_PID})"
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
assert len(tasks) == 1, "expected exactly 1 dsh task from this run, got " + str(len(tasks))
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
