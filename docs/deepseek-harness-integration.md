# DeepSeek-Harness Integration — Analysis & Guide

> Status: **Experimental, validated against `@deepseek-ai/dsh@0.1.0-rc.7`** — event names, the `(session, event)` listener signature, the `{type, seq, time, data}` wrapper, and the `turn/end` reason kinds were all confirmed against the shipped type definitions; the plugin ships with a committed test suite built on those shapes.
> Companion code: [`integrations/deepseek-harness/`](../integrations/deepseek-harness/)

This document answers three questions:

1. Could we fork JARVIS Mission Control to work with [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) the way it works with OpenClaw?
2. What is the *right* way to connect the two? (Spoiler: a **dsh plugin**, not a fork.)
3. If you still want a fork, how should you structure it?

---

## 1. What DeepSeek-Harness Is

DeepSeek-Harness (`dsh`, released August 2026, MIT license) is an open-source **agent harness**: it wraps LLMs into working agents with file access, command execution, and long-running task management.

Its defining trait is the **"everything is a plugin"** architecture, built on **Cordis** (the TypeScript plugin framework from the Koishi ecosystem):

- Models, tools, skills, sessions, sandboxes, storage, the agent loop, scheduling, and the UI are **all swappable plugins** mounted through configuration.
- Plugins contribute **services, typed events, and reversible effects** to a shared context (`ctx`). Unloading a plugin unwinds its registrations — no rebuild, no fork.
- Every run produces an **append-only session event stream** (`session/event`) that supports resume, fork, search, and replay. "Model-visible means logged."

Key services on the shared context:

| Service | Key | Responsibility |
|---------|-----|----------------|
| Sessions | `ctx.sessions` | Append-only event log + in-memory store |
| Tools | `ctx.tools` | Scoped registry, guarded execution |
| Agents | `ctx.agents` | Agent interface + live registry |
| Agent loop | `ctx.agentLoop` | Default think–act driver |
| LLM | `ctx.llm` | Message vocabulary + provider adapters |

Durable session events include `turn/start`, `turn/end`, `step/start`, `step/end`, `user/message`, `assistant/*`, and `tool/*`. Live agent events include `agent/pre-step`, `agent/request`, and `agent/turn-stopping`.

## 2. Architecture Comparison

| | JARVIS Mission Control | DeepSeek-Harness |
|---|---|---|
| Purpose | Task board + orchestration layer *above* agents | Runtime harness *around* one model/agent |
| State | JSON files in `.mission-control/` (Git-versioned) | Append-only session event log |
| Real-time | WebSocket broadcast + webhooks | Typed Cordis event bus |
| Extensibility | REST API, webhooks, bridge processes | First-class plugin kernel |
| Agents | Many agents, humans, reviews, permissions | One harnessed agent per session (composable) |
| UI | Kanban dashboard (`dashboard/`) | Local Web UI (`127.0.0.1:3080`) |

**These are complementary, not competing.** dsh answers "how does one agent think, act, and log?" Mission Control answers "how do many agents and humans coordinate work?" That's exactly the relationship the original Mission Control had with its first agent runtime — an external bridge process tailing session log files. 

With dsh the equivalent bridge is *cleaner*, because instead of scraping session files we can subscribe to a typed event stream from inside the harness itself.

## 3. Recommendation: Plugin, Not Fork

**Do not fork deepseek-harness.** Reasons:

1. **The architecture explicitly discourages it.** dsh's own docs: *"There is no privileged core to patch: you extend dsh by mounting a plugin beside the others."* A fork would fight the design and rot against a fast-moving v0.1 preview (breaking changes are announced).
2. **Everything we need is exposed as events.** The `session/event` stream carries every task-relevant moment (turn start/end, messages, tool calls). A plugin that forwards those to Mission Control's existing REST API gives us the full OpenClaw-bridge feature set with far less code.
3. **Mission Control's API is already the integration surface.** `POST /api/tasks`, `PATCH /api/tasks/:id`, `POST /api/logs/activity`, `POST /api/messages`, and `PUT /api/agents/:id` are everything a bridge needs. No server changes required.
4. **Discoverability.** dsh plugins are published with the `dsh-plugin` GitHub topic; the ecosystem hit ~1,200 plugin repos within days of launch. A `dsh-plugin-mission-control` package rides that wave; a fork does not.

### Concept mapping

| DeepSeek-Harness | Mission Control | Bridge behavior |
|---|---|---|
| Session (first `turn/start`) | Task (`task-YYYYMMDD-dsh-<id>`) | Auto-create as `IN_PROGRESS`, assigned to the harness agent |
| `turn/start` | Task status / comment | Ensure `IN_PROGRESS`, add progress comment |
| `user/message` | Activity log | Trimmed excerpt logged |
| `assistant/message` | Activity log | Trimmed excerpt logged |
| `tool/call`, `tool/result` | Activity log | `TOOL:` entries |
| `turn/end` | Task → `REVIEW` | Never `DONE` — the permission model reserves that for humans/reviewers |
| Harness agent identity | Agent (`.mission-control/agents/`) | Registered/updated via `PUT /api/agents/:id` |

The `REVIEW`-not-`DONE` rule matters: Mission Control's permission model says agents may never move work directly to `DONE`. The plugin honors that.

## 4. What Ships in This Repo

```
integrations/deepseek-harness/
├── README.md                          # Quickstart
└── dsh-plugin-mission-control/        # Installable dsh plugin (ESM, zero deps)
    ├── package.json
    └── src/
        ├── index.js                   # Cordis plugin: subscribes to session/event
        └── mc-client.js               # Tiny Mission Control REST client (queue + retry)
```

The plugin is deliberately defensive about the preview-stage API:

- Event names are **configurable** (`events` map in config) so renames in future dsh versions are a config fix, not a code fix.
- Payloads are read loosely — missing fields degrade to log-only behavior instead of crashing the harness.
- All Mission Control calls go through a serialized queue with retry/backoff; a dead dashboard never blocks the agent loop.
- Cordis disposers are respected: everything the plugin registers unwinds when it unloads.

### Installing into dsh

```bash
# Install the published bundle into a dsh profile. The dsh.bundle manifest
# activates the Cordis patch automatically.
npx @deepseek-ai/dsh@0.1.0-rc.7 plugin --profile web add dsh-plugin-mission-control
```

To override the defaults, address the installed row from the profile's
`cordis.patch.yml`:

```yaml
# cordis.patch.yml
- id: mission-control
  config:
    missionControlUrl: http://localhost:3000
    agentId: agent-dsh
    agentName: DeepSeek Harness
```

Verify composition with `npx @deepseek-ai/dsh@0.1.0-rc.7 --profile web --dump-config`, then run a session and watch tasks appear on the Mission Control board at `http://localhost:3000`.

## 5. The Fork Happened — You're In It

This document was written inside the original OpenClaw-based repository as a
feasibility analysis. The recommendation above was followed, and then the
product fork was made anyway — as its own repo, not a fork of deepseek-harness:
**this repository (JARVIS-Mission-Control-DeepSeek)** is the result. The board,
server, and data model carried over; every runtime-specific piece now targets
DeepSeek-Harness only, with the plugin from section 4 as the sole data path.

## 6. Known Unknowns (v0.1 preview)

- Exact `session/event` payload shapes are not yet formally documented; the plugin normalizes defensively and logs unknown events at debug level.
- Plugin manifest conventions (`dsh` field in `package.json`, bundle declaration via `dsh.bundle`) are evolving; the shipped `package.json` follows what the repo documents today.
- The dsh Python SDK and JSON-RPC agent (`examples/jsonrpc-agent`) offer an alternative *external* integration path if in-process plugins prove too unstable during the preview — the Mission Control REST surface used here would be identical.

## References

- Repo: https://github.com/deepseek-ai/deepseek-harness (`docs/architecture.md`, `docs/development.md`)
- Overview: https://xcloud.host/what-is-deepseek-harness-features-architecture-use-cases/
- Comparison: https://xcloud.host/deepseek-harness-vs-openclaw-vs-hermes-agent/
- Hosting: https://xcloud.host/deepseek-harness/ and https://xcloud.host/best-deepseek-harness-hosting-providers/
