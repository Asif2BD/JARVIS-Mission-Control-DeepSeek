/** Shared test helpers: a capturing mock Mission Control server and a fake Cordis context. */

import http from 'node:http';

/**
 * Start a mock Mission Control API on an ephemeral port.
 * `behave(req)` may return a status number to force a response; default 200.
 * Returns { url, requests, close }.
 */
export function startMockServer(behave = () => 200) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const record = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || null,
        body: body ? JSON.parse(body) : null,
      };
      const status = behave(record) || 200;
      if (status < 400) requests.push(record);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Fake Cordis context recording listeners per channel. */
export function fakeCtx() {
  const listeners = new Map();
  return {
    listeners,
    on(channel, fn) {
      listeners.set(channel, fn);
      return () => listeners.delete(channel);
    },
    emit(channel, ...args) {
      const fn = listeners.get(channel);
      return fn ? fn(...args) : undefined;
    },
  };
}

/** Build an rc.7-shaped session event wrapper. */
export function sessionEvent(type, data, seq = 1) {
  return { type, seq, time: Date.now(), data };
}

export function textBlock(text) {
  return { type: 'text', text };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
