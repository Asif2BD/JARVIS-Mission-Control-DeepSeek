/**
 * MissionDeck Cloud Sync Module
 *
 * Watches .mission-control/tasks/ and .mission-control/agents/ for changes
 * and pushes diffs to the MissionDeck API so the cloud dashboard stays live.
 *
 * Activated automatically when MISSIONDECK_API_KEY is set in config.yaml
 * or as environment variable MISSIONDECK_API_KEY.
 *
 * Usage (from server/index.js):
 *   const { startMissionDeckSync } = require('./missiondeck-sync');
 *   startMissionDeckSync({ missionControlDir, clientVersion });
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const MISSIONDECK_API = process.env.MISSIONDECK_URL || 'https://missiondeck.ai';
// MISSIONDECK_API_URL: direct Supabase endpoint (works while missiondeck.ai/api proxy isn't active).
// Once nginx proxy is live on xCloud, this can be overridden to https://missiondeck.ai/api
const MISSIONDECK_API_URL = process.env.MISSIONDECK_API_URL ||
  'https://sqykgceibcmnmgfuioso.supabase.co/functions/v1';
const SYNC_ENDPOINT = `${MISSIONDECK_API_URL}/mc-sync`;
const DEBOUNCE_MS = 3000;       // wait 3s after last change before syncing
const FULL_SYNC_INTERVAL = 300000; // full sync every 5 minutes

let syncTimer = null;
let lastSyncHash = null;
let isRunning = false;

/**
 * Start watching for changes and syncing to MissionDeck.
 * @param {object} opts
 * @param {string} opts.missionControlDir - path to .mission-control directory
 * @param {string} [opts.apiKey]           - override env var
 * @param {string} [opts.clientVersion]    - e.g. "1.0.0"
 */
function startMissionDeckSync({ missionControlDir, apiKey, clientVersion = 'unknown' }) {
  const key = apiKey || process.env.MISSIONDECK_API_KEY;
  if (!key) return; // Not configured — skip silently

  const tasksDir = path.join(missionControlDir, 'tasks');
  const agentsDir = path.join(missionControlDir, 'agents');

  console.log('☁️  MissionDeck sync enabled — watching for changes...');
  isRunning = true;

  // Do an immediate full sync on startup
  doFullSync({ missionControlDir, apiKey: key, clientVersion });

  // Watch tasks directory
  watchDir(tasksDir, () => scheduleSync({ missionControlDir, apiKey: key, clientVersion }));

  // Watch agents directory (if exists)
  if (fs.existsSync(agentsDir)) {
    watchDir(agentsDir, () => scheduleSync({ missionControlDir, apiKey: key, clientVersion }));
  }

  // Periodic full sync as safety net
  setInterval(() => {
    doFullSync({ missionControlDir, apiKey: key, clientVersion });
  }, FULL_SYNC_INTERVAL);
}

function watchDir(dir, callback) {
  if (!fs.existsSync(dir)) return;
  try {
    fs.watch(dir, { persistent: false }, (eventType, filename) => {
      if (filename && filename.endsWith('.json')) {
        callback();
      }
    });
  } catch (e) {
    console.warn('MissionDeck: could not watch', dir, '—', e.message);
  }
}

function scheduleSync(opts) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doFullSync(opts), DEBOUNCE_MS);
}

async function doFullSync({ missionControlDir, apiKey, clientVersion }) {
  if (!isRunning) return;
  try {
    const tasks = readJsonDir(path.join(missionControlDir, 'tasks'));
    const agents = readJsonDir(path.join(missionControlDir, 'agents'));

    // Simple hash to avoid redundant syncs
    const hash = simpleHash(JSON.stringify({ tasks: tasks.length, agents: agents.length }));
    if (hash === lastSyncHash) return;

    const payload = JSON.stringify({ tasks, agents, deleted_ids: [], client_version: clientVersion });

    const result = await postJson(SYNC_ENDPOINT, payload, apiKey);

    if (result.ok) {
      lastSyncHash = hash;
      console.log(`☁️  MissionDeck synced — ${result.tasks_upserted} tasks → ${result.dashboard_url}`);
    } else {
      console.warn('MissionDeck sync failed:', result.error);
    }
  } catch (err) {
    console.warn('MissionDeck sync error:', err.message);
  }
}

function readJsonDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== '.gitkeep')
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch (e) { return null; }
    })
    .filter(Boolean);
}

function postJson(url, payload, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${apiKey}`,
      },
      timeout: 15000,
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ ok: false, error: 'Invalid JSON response' }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Sync timeout')); });
    req.write(payload);
    req.end();
  });
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return h.toString(36);
}

// ── Cloud Pull: sync cloud-created tasks back to local ────────────────────────

let lastPullAt = new Date(0); // epoch = pull everything on first run

/**
 * Start polling MissionDeck cloud for tasks created/updated from the dashboard.
 * Any cloud-originated tasks are written to the local tasks directory so the
 * file watcher (chokidar in server/index.js) picks them up and fires
 * task.created / task.updated → WebSocket broadcast + webhooks.
 *
 * @param {object} opts
 * @param {string} opts.missionControlDir
 * @param {string} opts.apiKey
 * @param {string} opts.slug             - workspace slug (from .missiondeck MISSIONDECK_SLUG)
 * @param {number} [opts.intervalMs]     - poll interval (default 30s)
 */
function startCloudPull({ missionControlDir, apiKey, slug, intervalMs = 30000 }) {
  if (!apiKey || !slug) return;

  const tasksDir = path.join(missionControlDir, 'tasks');
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });

  const apiBase = (process.env.MISSIONDECK_API_URL ||
    'https://sqykgceibcmnmgfuioso.supabase.co/functions/v1') + `/mc-api/${slug}`;

  console.log(`☁️  MissionDeck cloud pull enabled — polling every ${intervalMs / 1000}s`);

  // Run immediately, then on interval
  pullCloudTasks({ tasksDir, apiKey, apiBase }).catch(() => {});
  setInterval(() => {
    pullCloudTasks({ tasksDir, apiKey, apiBase }).catch(() => {});
  }, intervalMs);
}

async function pullCloudTasks({ tasksDir, apiKey, apiBase }) {
  const cloudTasks = await fetchJson(`${apiBase}/tasks`, apiKey);
  if (!Array.isArray(cloudTasks)) return;

  const since = lastPullAt;
  lastPullAt = new Date();

  for (const task of cloudTasks) {
    if (!task || !task.id) continue;

    const updatedAt = task.updated_at ? new Date(task.updated_at) : new Date(0);

    // Only process tasks updated after last pull (or on first run: all cloud tasks)
    if (updatedAt <= since) continue;

    const localFile = path.join(tasksDir, `${task.id}.json`);
    const localExists = fs.existsSync(localFile);

    // Skip if this task was locally created (already in sync, avoid loop)
    if (localExists) {
      const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      // If local is newer or same age, skip (local wins)
      const localUpdated = local.updated_at ? new Date(local.updated_at) : new Date(0);
      if (localUpdated >= updatedAt) continue;
    }

    // Write task to local filesystem — chokidar picks this up automatically
    fs.writeFileSync(localFile, JSON.stringify(task, null, 2));
    console.log(`☁️  Cloud pull: ${localExists ? 'updated' : 'new'} task ${task.id} — "${task.title}"`);
  }
}

function fetchJson(url, apiKey) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 15000,
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Pull timeout')); });
    req.end();
  });
}

module.exports = { startMissionDeckSync, startCloudPull };
