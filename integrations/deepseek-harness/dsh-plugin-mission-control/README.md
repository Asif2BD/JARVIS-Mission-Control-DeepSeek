# dsh-plugin-mission-control

Mirror [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) agent activity onto a live [JARVIS Mission Control](https://github.com/Asif2BD/JARVIS-Mission-Control-DeepSeek) board: every dsh session becomes a task, messages and tool calls stream into the activity log, and finished turns land in `REVIEW` for a human to approve.

Validated against `@deepseek-ai/dsh@0.1.0-rc.7` — both the shipped type definitions and a live headless run. dsh is a developer preview; event names are config-overridable so upstream renames are a config fix.

## Install

```bash
# Into a dsh profile — the plugin self-activates via its dsh.bundle declaration
npx dsh plugin --profile web add dsh-plugin-mission-control

# Point it at your board (defaults shown)
export MISSION_CONTROL_URL=http://localhost:3000
export MC_AGENT_ID=agent-dsh
export MC_AGENT_TOKEN=...   # only if your board enforces auth

npx @deepseek-ai/dsh web
```

Need a board? `git clone https://github.com/Asif2BD/JARVIS-Mission-Control-DeepSeek && cd JARVIS-Mission-Control-DeepSeek/server && npm install && npm start` → http://localhost:3000

## What it does

| dsh event | Board effect |
|---|---|
| `session/created` | Task created (`IN_PROGRESS`, assigned to the harness agent) |
| `user/message`, `assistant/message` | Activity log excerpts |
| `tool/call`, `tool/result` | Activity log entries (tool name; error code on failure) |
| `turn/end` → `completed` | Task → `REVIEW` (humans approve to `DONE`) |
| `turn/end` → `blocked` / `failed` | Task → `BLOCKED`, structured error logged |
| `turn/end` → `aborted` / `interrupted` | Task → `ASSIGNED` |
| `session/flush` | Awaited bounded flush of the plugin's HTTP queue |

All Mission Control calls go through a serialized retry queue — an unreachable board never blocks the dsh agent loop.

## Configuration

Override the bundle defaults per profile by addressing row id `mission-control` in the profile's `cordis.patch.yml`:

```yaml
- id: mission-control
  config:
    missionControlUrl: http://localhost:3000
    agentId: agent-dsh          # must match ^[a-zA-Z0-9-_]+$
    agentName: DeepSeek Harness
    authToken: null             # or set env MC_AGENT_TOKEN
    maxExcerpt: 280             # max chars of content forwarded to logs
    flushTimeoutMs: 10000       # bound for the awaited session/flush drain
    events: {}                  # override dsh event names after upstream renames
```

## Troubleshooting

- **Nothing on the board** — confirm the server is up (`curl $MISSION_CONTROL_URL/api/metrics`) and check dsh logs for `[mission-control]` lines. Set `dryRun: true` in the row config to print payloads instead of sending.
- **Unknown event warnings after a dsh upgrade** — map the renamed events via the `events` config block.
- **Auth failures (401/403)** — set the same token in the server env (`MC_AGENT_TOKEN`) and the plugin (`authToken` or env).

## License

MIT — part of [JARVIS-Mission-Control-DeepSeek](https://github.com/Asif2BD/JARVIS-Mission-Control-DeepSeek).
