# Architecture — JARVIS Mission Control

## Stack

- **Runtime:** Node.js v22+ (required)
- **Server:** Express + WebSocket (`ws`) + Chokidar file watcher
- **Data storage:** JSON files in `.mission-control/` (no database)
- **Dashboard:** Vanilla JS/HTML served as static files
- **Process manager:** PM2 (`pm2 restart mission-control-server`)
- **Proxy:** nginx → localhost:3000

## Key Files

```
server/
├── index.js            ← Main Express server — REST API + WebSocket + file watcher
├── (bridge lives in integrations/deepseek-harness/ — a dsh plugin, not a server process)
├── telegram-bridge.js  ← Telegram bot integration
├── webhook-delivery.js ← Outgoing webhook delivery with retry
├── resource-manager.js ← Rate limiting & resource management
├── review-manager.js   ← Task review/approval logic
├── claude-sessions.js  ← Claude session monitoring
├── cli-connections.js  ← CLI tool connections
├── logger.js           ← Logging utility
└── middleware/
    └── basic-auth.js   ← Basic auth middleware (external access)

scripts/
├── safe-deploy.sh      ← ALWAYS use this instead of raw git pull
├── add-agent.sh        ← Register new agent
├── add-human.sh        ← Register new human operator
└── init-mission-control.sh ← Initialize fresh install

.mission-control/       ← LIVE DATA (not in git, sacred)
├── STATE.md            ← Live system state
├── tasks/*.json        ← Task files
├── agents/*.json       ← Agent registrations
├── humans/*.json       ← Human profiles
├── messages/*.json     ← Direct messages
├── queue/*.json        ← Recurring jobs
└── logs/activity.log  ← Append-only activity log

dashboard/              ← Static frontend
skill/                  ← Public ClawHub skill definition
skills/                 ← Modular skill docs (user-facing)
```

## URL Structure

| Endpoint | Description |
|----------|-------------|
| `http://localhost:3000` | Local dashboard |
| `https://zion.asif.dev` | Production (nginx proxy, basic auth) |
| `https://missiondeck.ai/mission-control/demo` | Public demo (USE THIS for public links) |

⚠️ **NEVER share `zion.asif.dev` publicly** — it's private infrastructure.

## Server Architecture

1. **File watcher (Chokidar)** monitors `.mission-control/**/*.json`
2. On file change → **WebSocket broadcast** to all connected dashboard clients
3. **REST API** for CRUD — agents use this to create/update tasks
4. **dsh Bridge** (`integrations/deepseek-harness/dsh-plugin-mission-control`) — a Cordis plugin mounted inside DeepSeek-Harness; mirrors the session event stream to this server's REST API (tasks, activity log, statuses)
5. **Webhook delivery** — notifies registered agent endpoints on events

## CSRF Protection

All mutating API calls (POST/PUT/PATCH/DELETE) require a CSRF token:
1. `GET /api/csrf-token` → returns token
2. Send token as `X-CSRF-Token` header on all subsequent mutating requests

## Input Sanitization

The `sanitizeInput()` helper in `index.js` strips: `< > " ' \` \\ $ ; | &`
**Always sanitize user-provided strings** before writing to JSON files.

## PM2 Process

```bash
# Check status
pm2 status mission-control-server

# Restart after code changes
pm2 restart mission-control-server

# View logs
pm2 logs mission-control-server

# Full restart with env reload
pm2 delete mission-control-server && pm2 start ecosystem.config.cjs
```
