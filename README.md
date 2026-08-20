# JARVIS Mission Control for DeepSeek-Harness

[![Version](https://img.shields.io/badge/version-2.1.0-brightgreen.svg)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![DeepSeek-Harness](https://img.shields.io/badge/runtime-dsh%200.1.0--rc.7-4A5BD4.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![MissionDeck](https://img.shields.io/badge/platform-missiondeck.ai-blue.svg)](https://missiondeck.ai)

**The open-source AI agent orchestration board, connected to [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness).**

JARVIS Mission Control is a Git-based command center for managing AI agents and human collaborators: a live Kanban board, task manager, activity log, messaging layer, and review workflow — backed by plain JSON files and a Node.js server. This edition connects it to **DeepSeek-Harness (`dsh`)**, the plugin-kernel agent harness from DeepSeek: every dsh session appears as a task on your board, every turn and tool call streams into the activity log, and finished work lands in `REVIEW` for a human to approve.

> **Status: Experimental.** dsh is a v0.1 developer preview with announced breaking changes. The bridge is validated against `@deepseek-ai/dsh@0.1.0-rc.7` type definitions and covered by committed tests; event names are config-overridable so upstream renames are a config fix. 

---

## How It Connects

`dsh` treats everything as a plugin and broadcasts every model-visible moment on an append-only session event stream. Our bridge mounts *inside* the harness as a [Cordis](https://cordis.io) plugin and forwards that stream to Mission Control's REST API — no polling, no log scraping, no server changes:

```
┌────────────── dsh ──────────────┐        ┌──── Mission Control ────┐
│ agent loop → session event log  │        │ server (localhost:3000) │
│        │                        │  HTTP  │   POST /api/tasks       │
│        └─► mission-control ─────┼───────►│   PATCH /api/tasks/:id  │
│            plugin (this repo)   │        │   POST /api/logs/...    │
└─────────────────────────────────┘        │   → dashboard + WS      │
                                           └─────────────────────────┘
```

| dsh event | Board effect |
|---|---|
| `session/created` | Task created (`IN_PROGRESS`, assigned to the harness agent) |
| `user/message`, `assistant/message` | Activity log excerpts |
| `tool/call`, `tool/result` | Activity log entries (with error codes) |
| `turn/end` → `completed` | Task → `REVIEW` — humans approve to `DONE` |
| `turn/end` → `blocked` / `failed` | Task → `BLOCKED`, structured error logged |
| `turn/end` → `aborted` / `interrupted` | Task → `ASSIGNED` |

## Quick Start

```bash
# 1. Fork and clone this repo
git clone https://github.com/YOUR-USERNAME/JARVIS-Mission-Control-DeepSeek.git
cd JARVIS-Mission-Control-DeepSeek

# 2. Start the Mission Control server + dashboard
cd server && npm install && npm start        # → http://localhost:3000

# 3. Install the bridge into the web profile. The dsh.bundle manifest
#    activates it automatically; no hand-written Cordis row is required.
npx @deepseek-ai/dsh@0.1.0-rc.7 plugin --profile web add dsh-plugin-mission-control

# 4. Run DeepSeek-Harness
npx @deepseek-ai/dsh web                     # → http://127.0.0.1:3080
```

Open the board at `http://localhost:3000` and start a dsh session — the task appears as soon as the session does.

**Full setup, config reference, and troubleshooting:** [`integrations/deepseek-harness/README.md`](integrations/deepseek-harness/README.md)
**Architecture analysis and design rationale:** [`docs/deepseek-harness-integration.md`](docs/deepseek-harness-integration.md)

## What's in the Box

| Piece | Path | What it does |
|---|---|---|
| **Dashboard** | `dashboard/` | Kanban board, agent profiles, chat, activity feed, WebSocket live updates |
| **Server** | `server/` | Express + WebSocket API over `.mission-control/` JSON files |
| **dsh bridge** | `integrations/deepseek-harness/` | The Cordis plugin (`dsh-plugin-mission-control`) with its test suite |
| **Data** | `.mission-control/` | Tasks, agents, humans, messages — Git-versioned JSON, no database |
| **Skills** | `skills/` | Modular agent instructions, including the [dsh bridge skill](skills/deepseek-harness.md) |
| **Scripts** | `scripts/` | Setup helpers (`add-agent.sh`, `add-human.sh`, `init-mission-control.sh`, …) |

The plugin ships with **auth support** (`MC_AGENT_TOKEN` / `authToken` → `Authorization: Bearer`), a **serialized retry queue** so a dead board never blocks the agent loop, and an **awaited bounded `flush()`** wired to dsh's `session/flush` durability checkpoint.

```bash
# Run the bridge's test suite (16 tests: rc.7 event fixtures + mock HTTP)
cd integrations/deepseek-harness/dsh-plugin-mission-control && npm test
```

## MissionDeck Platform

This open-source repo is the engine. [MissionDeck.ai](https://missiondeck.ai) is the platform around it — hosted dashboards (`missiondeck.ai/mission-control/your-slug`), visual agent building, and one-click deployment. A free API key from [missiondeck.ai/auth](https://missiondeck.ai/auth) connects your instance:

```bash
./scripts/connect-missiondeck.sh --api-key YOUR_KEY
```

## Heritage & Roadmap

This project began as a port of [JARVIS Mission Control](https://github.com/Asif2BD/JARVIS-Mission-Control-OpenClaw) (v2.1.0); the board, server, and data model carry over, and everything runtime-specific here targets DeepSeek-Harness only. See the repo issues for the roadmap:

1. Live end-to-end validation with a real `DEEPSEEK_API_KEY`
2. dsh-native cost tracking (per-step `usage` from `assistant/message` events → the dashboard cost cards)
3. Track new dsh preview releases with a compatibility canary and configurable event mappings

## License

[MIT](LICENSE) — free to use, fork, and build on.
