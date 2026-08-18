# Deploy Guide — JARVIS Mission Control

## Production Environment

- **Server:** zion.asif.dev (this IS the local machine — no SSH needed)
- **Local URL:** http://localhost:3000
- **External URL:** https://zion.asif.dev (nginx proxy, basic auth protected)
- **Process:** PM2 (`mission-control-server`)
- **Repo path:** `/opt/jarvis-mission-control-deepseek/`

⚠️ **zion.asif.dev is PRIVATE** — never share it publicly, never put it in docs/READMEs.
**Public demo:** https://missiondeck.ai/mission-control/demo

## Standard Deploy (after merge to main)

```bash
cd /opt/jarvis-mission-control-deepseek

# Safe pull (backs up .mission-control/ first, then pulls)
./scripts/safe-deploy.sh --pull

# Restart PM2
pm2 restart mission-control-server

# Verify
pm2 status mission-control-server
curl http://localhost:3000/api/metrics
```

## Deploy Checklist

- [ ] PR merged to `main` by Oracle
- [ ] `./scripts/safe-deploy.sh --pull` (NOT raw `git pull`)
- [ ] `pm2 restart mission-control-server`
- [ ] Check `pm2 logs mission-control-server` for errors
- [ ] Verify `http://localhost:3000` responds
- [ ] Update CHANGELOG.md if version bump

## Backup & Restore

```bash
# Create named backup before risky changes
./scripts/safe-deploy.sh --backup pre-v2.1.0

# List backups
ls .mission-control-backups/

# Restore
./scripts/safe-deploy.sh --restore pre-v2.1.0
```

## PM2 Commands

```bash
pm2 status                           # All processes
pm2 status mission-control-server    # This process only
pm2 restart mission-control-server   # Restart (preserves env)
pm2 logs mission-control-server      # View logs
pm2 logs mission-control-server --lines 50  # Last 50 lines
pm2 delete mission-control-server    # Kill it
pm2 start ecosystem.config.cjs       # Start from ecosystem config (full env reload)
```

## Environment Variables

Stored in `ecosystem.config.cjs` — do not hardcode in source files.

Key vars:
- `PORT` — server port (default 3000)
- `TELEGRAM_BOT_TOKEN` — Telegram bridge token
- `MISSIONDECK_API_KEY` — MissionDeck sync key
- `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` — external access credentials (see credentials file)

## nginx Config

nginx proxies `zion.asif.dev` → `localhost:3000`. Do not touch the nginx config unless explicitly asked. If the server needs a restart:

```bash
systemctl reload nginx
```

## Version Bump Process

1. Update `VERSION` file with new semver
2. Update `CHANGELOG.md` with changes
3. Update version in `package.json`
4. Commit: `[agent:tank] chore: bump version to X.Y.Z`
5. Open PR → tag Oracle → wait for merge
6. After merge: deploy as above

## Rollback

If deploy breaks production:

```bash
# Immediate rollback
./scripts/safe-deploy.sh --restore BACKUP_NAME
pm2 restart mission-control-server
```

Then report to Oracle with what happened.
