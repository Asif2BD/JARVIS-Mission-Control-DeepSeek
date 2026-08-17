/**
 * Minimal JARVIS Mission Control REST client used by the dsh plugin.
 *
 * All writes go through a serialized queue with retry/backoff so a slow or
 * unreachable Mission Control server can never stall the dsh agent loop.
 * Requests that exhaust their retries are dropped with a log line.
 *
 * Auth: pass `authToken` (or set MC_AGENT_TOKEN in the environment) to send
 * `Authorization: Bearer <token>` on every request, for Mission Control
 * deployments with the authentication middleware enabled.
 */

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_QUEUE = 500;

export class MissionControlClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl     Mission Control server, e.g. http://localhost:3000
   * @param {string} [options.authToken] Bearer token; falls back to env MC_AGENT_TOKEN
   * @param {boolean} [options.dryRun]   Log payloads instead of sending them
   * @param {(level: string, msg: string) => void} [options.log]
   */
  constructor({ baseUrl, authToken, dryRun = false, log }) {
    this.baseUrl = String(baseUrl || 'http://localhost:3000').replace(/\/+$/, '');
    this.authToken = authToken || process.env.MC_AGENT_TOKEN || null;
    this.dryRun = dryRun;
    this.log = log || ((level, msg) => console[level === 'error' ? 'error' : 'log'](`[mission-control] ${msg}`));
    this.queue = [];
    this.draining = false;
    this.drainPromise = null;
    this.stopped = false;
  }

  registerAgent(agent) {
    return this.enqueue('PUT', `/api/agents/${encodeURIComponent(agent.id)}`, agent);
  }

  createTask(task) {
    return this.enqueue('POST', '/api/tasks', task);
  }

  patchTask(taskId, patch) {
    return this.enqueue('PATCH', `/api/tasks/${encodeURIComponent(taskId)}`, patch);
  }

  logActivity(actor, action, description) {
    return this.enqueue('POST', '/api/logs/activity', {
      timestamp: new Date().toISOString(),
      actor,
      action,
      description,
    });
  }

  sendMessage(message) {
    return this.enqueue('POST', '/api/messages', message);
  }

  enqueue(method, path, body) {
    if (this.stopped) {
      this.log('warn', `client stopped, ignoring ${method} ${path}`);
      return;
    }
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift();
      this.log('warn', `queue full (${MAX_QUEUE}), dropping oldest request`);
    }
    this.queue.push({ method, path, body, attempts: 0 });
    void this.drain();
  }

  /**
   * Await delivery (or final drop) of everything queued so far, bounded by
   * `timeoutMs`. Resolves `true` when the queue fully drained, `false` when
   * the deadline hit first. Safe to call from dsh's awaited `session/flush`
   * durability checkpoint.
   */
  async flush(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0 && Date.now() < deadline) {
      const wait = this.drainPromise || this.drain();
      await Promise.race([wait, sleep(Math.max(1, deadline - Date.now()))]);
      if (this.queue.length > 0) await sleep(25);
    }
    return this.queue.length === 0;
  }

  drain() {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainLoop().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  async drainLoop() {
    while (this.queue.length > 0) {
      const item = this.queue[0];
      const ok = await this.send(item);
      if (ok) {
        this.queue.shift();
      } else if (item.attempts >= MAX_RETRIES) {
        this.queue.shift();
        this.log('error', `dropping ${item.method} ${item.path} after ${item.attempts} attempts`);
      } else {
        await sleep(BASE_BACKOFF_MS * 2 ** (item.attempts - 1));
      }
    }
  }

  async send(item) {
    item.attempts += 1;
    if (this.dryRun) {
      this.log('info', `[dry-run] ${item.method} ${item.path} ${JSON.stringify(item.body)}`);
      return true;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const headers = { 'Content-Type': 'application/json' };
      if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
      const res = await fetch(this.baseUrl + item.path, {
        method: item.method,
        headers,
        body: JSON.stringify(item.body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      // 4xx means the payload or credentials are wrong; retrying identical
      // bytes won't help.
      if (res.status >= 400 && res.status < 500) {
        this.log('error', `${item.method} ${item.path} → ${res.status}, not retrying`);
        return true;
      }
      return res.ok;
    } catch (err) {
      this.log('warn', `${item.method} ${item.path} failed (attempt ${item.attempts}): ${err.message}`);
      return false;
    }
  }

  /** Refuse new work. Pending items can still be delivered via flush(). */
  stop() {
    this.stopped = true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
