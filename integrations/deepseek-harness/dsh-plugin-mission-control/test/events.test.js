/**
 * Fixture-driven tests: feed the plugin session events shaped exactly like
 * @deepseek-ai/dsh 0.1.0-rc.7 emits them ({type, seq, time, data} wrappers,
 * listener signature (session, event)) and assert the Mission Control API
 * calls that come out the other side.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, REASON_STATUS } from '../src/index.js';
import { startMockServer, fakeCtx, sessionEvent, textBlock } from './helpers.js';

async function mountedPlugin(configOverrides = {}) {
  const mock = await startMockServer();
  const ctx = fakeCtx();
  const dispose = apply(ctx, { missionControlUrl: mock.url, flushTimeoutMs: 5000, ...configOverrides });
  const session = { id: 'sess_fixture_01' };
  const emit = (type, data) => ctx.emit('session/event', session, sessionEvent(type, data));
  const finish = async () => {
    await ctx.emit('session/flush', session);
    await dispose();
    await mock.close();
  };
  return { mock, ctx, session, emit, finish };
}

const urlsOf = (mock) => mock.requests.map((r) => r.url);
const bodiesFor = (mock, url) => mock.requests.filter((r) => r.url === url).map((r) => r.body);

test('registers the agent and announces itself on mount', async () => {
  const { mock, finish } = await mountedPlugin();
  await finish();
  assert.ok(urlsOf(mock).includes('/api/agents/agent-dsh'));
  const agent = mock.requests.find((r) => r.url === '/api/agents/agent-dsh');
  assert.equal(agent.method, 'PUT');
  assert.equal(agent.body.model, 'deepseek-harness');
  assert.ok(agent.body.personality.about.length > 0);
});

test('session/created creates the task once, IN_PROGRESS, assigned to the agent', async () => {
  const { mock, ctx, session, finish } = await mountedPlugin();
  ctx.emit('session/created', session);
  ctx.emit('session/created', session); // duplicate must not create a second task
  await finish();
  const tasks = bodiesFor(mock, '/api/tasks');
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].id, /^task-\d{8}-dsh-sess_fixture_01$/);
  assert.equal(tasks[0].status, 'IN_PROGRESS');
  assert.equal(tasks[0].assignee, 'agent-dsh');
});

test('reads rc.7 payload paths: turn number, content blocks, tool name, tool error', async () => {
  const { mock, emit, finish } = await mountedPlugin();
  emit('turn/start', { turn: 1 });
  emit('user/message', { role: 'user', content: [textBlock('Refactor'), textBlock('the auth module')] });
  emit('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [textBlock('On it — starting with the token check.')] },
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  emit('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' });
  emit('tool/result', { turn: 1, step: 1, message: { role: 'user', content: [] }, error: { name: 'ExecError', code: 'EXIT_1' } });
  await finish();

  const logs = bodiesFor(mock, '/api/logs/activity').map((b) => `${b.action}: ${b.description}`);
  assert.ok(logs.some((l) => l.includes('TURN_START') && l.includes('turn 1')));
  assert.ok(logs.some((l) => l.includes('USER_MESSAGE') && l.includes('Refactor the auth module')));
  assert.ok(logs.some((l) => l.includes('ASSISTANT_MESSAGE') && l.includes('starting with the token check')));
  assert.ok(logs.some((l) => l.includes('TOOL_CALL') && l.includes('bash')));
  assert.ok(logs.some((l) => l.includes('TOOL_RESULT') && l.includes('error (EXIT_1)')));
});

test('turn/end maps every reason.kind to the right board status', async () => {
  for (const [kind, expected] of Object.entries(REASON_STATUS)) {
    const { mock, emit, finish } = await mountedPlugin();
    emit('turn/start', { turn: 1 });
    emit('turn/end', { turn: 1, reason: { kind } });
    await finish();
    const patches = mock.requests.filter((r) => r.method === 'PATCH');
    assert.equal(patches.length, 1, `one PATCH expected for ${kind}`);
    assert.equal(patches[0].body.status, expected, `${kind} → ${expected}`);
  }
});

test('failed turns log the structured error and never announce a review', async () => {
  const { mock, emit, finish } = await mountedPlugin();
  emit('turn/start', { turn: 1 });
  emit('turn/end', { turn: 1, reason: { kind: 'failed', error: { message: 'context window exceeded', code: 'LLM_LIMIT' } } });
  await finish();
  const logs = bodiesFor(mock, '/api/logs/activity').map((b) => b.description);
  assert.ok(logs.some((l) => l.includes('LLM_LIMIT') && l.includes('context window exceeded')));
  const chats = bodiesFor(mock, '/api/messages').map((b) => b.content);
  assert.ok(!chats.some((c) => c.includes('awaiting review')), 'failed turn must not announce a review');
});

test('completed turns announce the review in chat', async () => {
  const { mock, emit, finish } = await mountedPlugin();
  emit('turn/start', { turn: 3 });
  emit('turn/end', { turn: 3, reason: { kind: 'completed' } });
  await finish();
  const chats = bodiesFor(mock, '/api/messages').map((b) => b.content);
  assert.ok(chats.some((c) => c.includes('Turn 3') && c.includes('awaiting review')));
});

test('turn numbers come from the event, not a homemade counter', async () => {
  const { mock, emit, finish } = await mountedPlugin();
  emit('turn/start', { turn: 7 }); // resumed session: first observed turn is 7
  await finish();
  const logs = bodiesFor(mock, '/api/logs/activity').map((b) => b.description);
  assert.ok(logs.some((l) => l.includes('turn 7')));
});

test('unknown and malformed events are ignored without breaking the stream', async () => {
  const { mock, emit, ctx, session, finish } = await mountedPlugin();
  emit('step/start', { turn: 1, step: 1 });
  emit('assistant/chunk', { turn: 1, step: 1, chunk: {} });
  ctx.emit('session/event', session, null);
  ctx.emit('session/event', session);
  emit('turn/start', { turn: 1 }); // stream still works afterwards
  await finish();
  const logs = bodiesFor(mock, '/api/logs/activity').map((b) => b.action);
  assert.ok(logs.includes('TURN_START'));
  assert.ok(!logs.includes('undefined'));
});

test('session/flush is awaited and drains the queue', async () => {
  const { mock, ctx, session, emit } = await mountedPlugin();
  emit('turn/start', { turn: 1 });
  await ctx.emit('session/flush', session);
  // Everything emitted before the flush must already be on the wire.
  assert.ok(bodiesFor(mock, '/api/logs/activity').some((b) => b.action === 'TURN_START'));
  await ctx.listeners.get('session/flush')(session);
  await mock.close();
});

test('event names are overridable via config', async () => {
  const mock = await startMockServer();
  const ctx = fakeCtx();
  const dispose = apply(ctx, {
    missionControlUrl: mock.url,
    flushTimeoutMs: 5000,
    events: { turnStart: 'turn/begin' },
  });
  const session = { id: 's2' };
  ctx.emit('session/event', session, sessionEvent('turn/begin', { turn: 1 }));
  await ctx.emit('session/flush', session);
  await dispose();
  await mock.close();
  assert.ok(bodiesFor(mock, '/api/logs/activity').some((b) => b.action === 'TURN_START'));
});
