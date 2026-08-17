/**
 * dsh-plugin-mission-control
 *
 * DeepSeek-Harness (dsh) plugin that mirrors harness activity onto a JARVIS
 * Mission Control board. Payload shapes follow @deepseek-ai/dsh 0.1.0-rc.7:
 * session events arrive as `{ type, seq, time, data }` wrappers on the
 * `session/event` channel with the listener signature `(session, event)`.
 *
 *   session/created               → task created (IN_PROGRESS)
 *   turn/start                    → task kept IN_PROGRESS + activity log
 *   user/message                  → activity log excerpt (data.content blocks)
 *   assistant/message             → activity log excerpt (data.message.content)
 *   tool/call, tool/result        → activity log entries (data.name / data.error)
 *   turn/end                      → status from data.reason.kind:
 *                                     completed → REVIEW (humans approve DONE)
 *                                     blocked | failed → BLOCKED
 *                                     aborted | interrupted → ASSIGNED
 *   session/flush                 → awaited bounded flush of the HTTP queue
 *
 * Event names remain overridable via config for future preview renames, and
 * payload reads fall back defensively so unknown shapes degrade to log lines
 * instead of crashing the harness.
 */

import { MissionControlClient } from './mc-client.js';

export const name = 'dsh-plugin-mission-control';

export const defaultConfig = {
  missionControlUrl: 'http://localhost:3000',
  authToken: null, // falls back to env MC_AGENT_TOKEN
  agentId: 'agent-dsh',
  agentName: 'DeepSeek Harness',
  designation: 'Harnessed Agent',
  capabilities: ['coding', 'automation'],
  maxExcerpt: 280,
  flushTimeoutMs: 10_000,
  dryRun: false,
  events: {
    channel: 'session/event',
    sessionCreated: 'session/created',
    sessionDisposed: 'session/disposed',
    sessionFlush: 'session/flush',
    turnStart: 'turn/start',
    turnEnd: 'turn/end',
    userMessage: 'user/message',
    assistantMessage: 'assistant/message',
    toolCall: 'tool/call',
    toolResult: 'tool/result',
  },
};

/** How each turn/end reason.kind maps onto the Mission Control board. */
export const REASON_STATUS = {
  completed: 'REVIEW',
  blocked: 'BLOCKED',
  failed: 'BLOCKED',
  aborted: 'ASSIGNED',
  interrupted: 'ASSIGNED',
};

export function apply(ctx, userConfig = {}) {
  const config = {
    ...defaultConfig,
    ...userConfig,
    events: { ...defaultConfig.events, ...(userConfig.events || {}) },
  };

  if (!/^[a-zA-Z0-9-_]+$/.test(config.agentId)) {
    throw new Error(`[mission-control] invalid agentId "${config.agentId}" — must match ^[a-zA-Z0-9-_]+$`);
  }

  const log = makeLogger(ctx);
  const client = new MissionControlClient({
    baseUrl: config.missionControlUrl,
    authToken: config.authToken,
    dryRun: config.dryRun,
    log,
  });

  // sessionId → { taskId, turn } for sessions seen while this plugin is loaded
  const sessions = new Map();

  registerAgent(client, config);
  client.sendMessage({
    from: config.agentId,
    to: 'all',
    content: `${config.agentName} connected via dsh-plugin-mission-control.`,
    thread_id: 'chat-general',
    type: 'chat',
  });

  const guarded = (fn) => (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      // Never let board mirroring break the agent loop.
      log('error', `event handling failed: ${err.message}`);
    }
  };

  const disposers = [
    ctx.on(config.events.sessionCreated, guarded((session) => {
      const sessionId = sessionIdOf(session);
      if (sessionId) ensureTask(sessionId, { client, config, sessions });
    })),

    ctx.on(config.events.sessionDisposed, guarded((session) => {
      const sessionId = sessionIdOf(session);
      const record = sessionId && sessions.get(sessionId);
      if (record) client.logActivity(config.agentId, 'SESSION_DISPOSED', `${record.taskId} session left the store`);
    })),

    ctx.on(config.events.channel, guarded((...args) => {
      handleSessionEvent(normalizeEvent(args), { client, config, sessions });
    })),

    // Awaited parallel durability checkpoint: dsh waits for every listener,
    // so our queued HTTP rides the same flush the session log does.
    ctx.on(config.events.sessionFlush, () => client.flush(config.flushTimeoutMs)),
  ];

  return async () => {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose();
    }
    client.logActivity(config.agentId, 'DISCONNECTED', 'dsh mission-control plugin unloaded');
    client.stop();
    await client.flush(config.flushTimeoutMs);
  };
}

// ── Event handling ──────────────────────────────────────────────────────────

function handleSessionEvent(evt, { client, config, sessions }) {
  if (!evt || !evt.type) return;
  const e = config.events;
  const { sessionId, data } = evt;

  switch (evt.type) {
    case e.turnStart: {
      const record = ensureTask(sessionId, { client, config, sessions });
      record.turn = typeof data.turn === 'number' ? data.turn : record.turn + 1;
      if (record.turn > 1) {
        client.patchTask(record.taskId, {
          status: 'IN_PROGRESS',
          updated_at: new Date().toISOString(),
        });
      }
      client.logActivity(config.agentId, 'TURN_START', `${record.taskId} turn ${record.turn}`);
      break;
    }

    case e.turnEnd: {
      const record = sessions.get(sessionId);
      if (!record) return;
      const kind = data.reason?.kind || 'completed';
      const status = REASON_STATUS[kind] || 'REVIEW';
      client.patchTask(record.taskId, {
        status,
        updated_at: new Date().toISOString(),
      });
      let detail = `${record.taskId} turn ${record.turn} ended (${kind}) → ${status}`;
      if (kind === 'failed' && data.reason?.error) {
        const err = data.reason.error;
        detail += ` — ${err.code || 'UNKNOWN'}: ${String(err.message || '').slice(0, 160)}`;
      }
      client.logActivity(config.agentId, 'TURN_END', detail);
      if (status === 'REVIEW') {
        client.sendMessage({
          from: config.agentId,
          to: 'all',
          content: `Turn ${record.turn} of ${record.taskId} finished — awaiting review.`,
          thread_id: 'chat-general',
          type: 'chat',
        });
      }
      break;
    }

    case e.userMessage: {
      const record = ensureTask(sessionId, { client, config, sessions });
      client.logActivity('human', 'USER_MESSAGE', `${record.taskId}: ${excerpt(data.content, config.maxExcerpt)}`);
      break;
    }

    case e.assistantMessage: {
      const record = ensureTask(sessionId, { client, config, sessions });
      client.logActivity(config.agentId, 'ASSISTANT_MESSAGE', `${record.taskId}: ${excerpt(data.message?.content, config.maxExcerpt)}`);
      break;
    }

    case e.toolCall: {
      const record = sessions.get(sessionId);
      client.logActivity(config.agentId, 'TOOL_CALL', `${record?.taskId || sessionId}: ${data.name || 'tool'}`);
      break;
    }

    case e.toolResult: {
      const record = sessions.get(sessionId);
      const status = data.error ? `error (${data.error.code || data.error.name || 'unknown'})` : 'ok';
      client.logActivity(config.agentId, 'TOOL_RESULT', `${record?.taskId || sessionId}: ${status}`);
      break;
    }

    default:
      // step/start, step/end, assistant/chunk, todo/write, … — ignored.
      break;
  }
}

function ensureTask(sessionId, { client, config, sessions }) {
  let record = sessions.get(sessionId);
  if (record) return record;

  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const taskId = `task-${datePart}-dsh-${sanitizeId(sessionId)}`;
  record = { taskId, turn: 0 };
  sessions.set(sessionId, record);

  client.createTask({
    id: taskId,
    title: `dsh session ${sessionId}`,
    description: `Auto-created by dsh-plugin-mission-control for DeepSeek-Harness session "${sessionId}". Follow progress in the activity log.`,
    status: 'IN_PROGRESS',
    priority: 'medium',
    assignee: config.agentId,
    created_by: config.agentId,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    labels: ['dsh', 'auto-created'],
    comments: [],
    deliverables: [],
    dependencies: [],
    blocked_by: [],
  });
  client.logActivity(config.agentId, 'CREATED', `${taskId} for dsh session ${sessionId}`);
  return record;
}

function registerAgent(client, config) {
  const now = new Date().toISOString();
  client.registerAgent({
    id: config.agentId,
    name: config.agentName,
    type: 'ai',
    role: 'specialist',
    designation: config.designation,
    model: 'deepseek-harness',
    status: 'active',
    capabilities: config.capabilities,
    personality: {
      about: 'A DeepSeek-Harness (dsh) agent mirrored onto Mission Control by dsh-plugin-mission-control. Every session I run appears as a task; my turns and tool calls stream into the activity log.',
      tone: 'focused',
      traits: ['harnessed', 'traceable', 'replayable'],
      greeting: 'Harness online. Sessions are being mirrored to the board.',
    },
    registered_at: now,
    last_active: now,
    current_tasks: [],
    completed_tasks: 0,
    metadata: {
      description: 'DeepSeek-Harness bridge agent',
      clearance: 'BETA',
      bridge: 'dsh-plugin-mission-control',
    },
  });
}

// ── Normalization helpers ───────────────────────────────────────────────────

/**
 * rc.7 emits `session/event` with the listener signature `(session, event)`
 * where the event is a `{ type, seq, time, data }` wrapper. Accept any
 * argument order anyway: the event is whichever object carries a string
 * `type`; the session is whatever else exposes an id.
 */
function normalizeEvent(args) {
  const objs = args.filter((a) => a && typeof a === 'object');
  const event = objs.find((o) => typeof o.type === 'string') || null;
  if (!event) return null;
  const session = objs.find((o) => o !== event && sessionIdOf(o)) || null;
  const sessionId = String(
    event.sessionId || event.session?.id || sessionIdOf(session) || 'default'
  );
  // rc.7 wraps payloads in `data`; fall back to the event root for older or
  // foreign shapes.
  const data = (event.data && typeof event.data === 'object') ? event.data : event;
  return { type: event.type, sessionId, data };
}

function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return null;
  return session.id || session.sessionId || session.header?.id || null;
}

/** Flatten message content (string or ContentBlock[]) to a short excerpt. */
function excerpt(content, maxLen) {
  let text;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : part?.text || ''))
      .filter(Boolean)
      .join(' ');
  } else {
    text = '';
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '(no text content)';
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function sanitizeId(value) {
  const cleaned = String(value).replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 24);
  return cleaned || 'session';
}

function makeLogger(ctx) {
  const target = typeof ctx?.logger === 'function' ? ctx.logger('mission-control') : null;
  return (level, msg) => {
    if (target && typeof target[level] === 'function') target[level](msg);
    else console[level === 'error' ? 'error' : 'log'](`[mission-control] ${msg}`);
  };
}
