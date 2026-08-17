import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionControlClient } from '../src/mc-client.js';
import { startMockServer, sleep } from './helpers.js';

const quiet = () => {};

test('sends Authorization header when an auth token is configured', async () => {
  const mock = await startMockServer();
  const client = new MissionControlClient({ baseUrl: mock.url, authToken: 'secret-token', log: quiet });
  client.logActivity('agent-x', 'TEST', 'auth check');
  assert.equal(await client.flush(5000), true);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].auth, 'Bearer secret-token');
  await mock.close();
});

test('sends no Authorization header without a token', async () => {
  const prev = process.env.MC_AGENT_TOKEN;
  delete process.env.MC_AGENT_TOKEN;
  const mock = await startMockServer();
  const client = new MissionControlClient({ baseUrl: mock.url, log: quiet });
  client.logActivity('agent-x', 'TEST', 'no auth');
  assert.equal(await client.flush(5000), true);
  assert.equal(mock.requests[0].auth, null);
  await mock.close();
  if (prev !== undefined) process.env.MC_AGENT_TOKEN = prev;
});

test('retries transient 5xx and preserves request order', async () => {
  let failures = 2;
  const mock = await startMockServer((req) => {
    if (req.url === '/api/tasks' && failures > 0) {
      failures -= 1;
      return 500;
    }
    return 200;
  });
  const client = new MissionControlClient({ baseUrl: mock.url, log: quiet });
  client.createTask({ id: 'task-1' });
  client.logActivity('agent-x', 'AFTER', 'must arrive after the task');
  assert.equal(await client.flush(10_000), true);
  assert.deepEqual(mock.requests.map((r) => r.url), ['/api/tasks', '/api/logs/activity']);
  await mock.close();
});

test('drops 4xx without retrying and keeps draining', async () => {
  let postCount = 0;
  const mock = await startMockServer((req) => {
    if (req.url === '/api/messages') {
      postCount += 1;
      return 400;
    }
    return 200;
  });
  const client = new MissionControlClient({ baseUrl: mock.url, log: quiet });
  client.sendMessage({ from: 'agent-x', to: 'all', content: 'bad payload' });
  client.logActivity('agent-x', 'NEXT', 'still delivered');
  assert.equal(await client.flush(5000), true);
  assert.equal(postCount, 1, '4xx must not be retried');
  assert.deepEqual(mock.requests.map((r) => r.url), ['/api/logs/activity']);
  await mock.close();
});

test('flush returns false when the deadline hits before the queue drains', async () => {
  // Unreachable port: every attempt fails, retries with backoff outlast 150ms.
  const client = new MissionControlClient({ baseUrl: 'http://127.0.0.1:9', log: quiet });
  client.logActivity('agent-x', 'TEST', 'never delivers');
  assert.equal(await client.flush(150), false);
  client.stop();
});

test('stop refuses new work but flush still delivers what was queued', async () => {
  const mock = await startMockServer();
  const client = new MissionControlClient({ baseUrl: mock.url, log: quiet });
  client.logActivity('agent-x', 'QUEUED', 'before stop');
  client.stop();
  client.logActivity('agent-x', 'IGNORED', 'after stop');
  assert.equal(await client.flush(5000), true);
  await sleep(20);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.action, 'QUEUED');
  await mock.close();
});
