/**
 * Mock OpenAI-compatible /v1/chat/completions server for dsh E2E testing.
 * Supports streaming (SSE) and non-streaming. Always answers with a short
 * fixed assistant message and finish_reason "stop".
 */
const http = require('http');

const PORT = process.env.MOCK_LLM_PORT || 4515;
let calls = 0;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls += 1;
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    console.log(`[mock-llm] #${calls} ${req.method} ${req.url} stream=${!!parsed.stream} msgs=${(parsed.messages || []).length}`);

    if (!req.url.includes('/chat/completions')) {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    const text = 'Hello from the mock model. E2E bridge test complete.';
    const id = `chatcmpl-mock-${calls}`;
    const created = Math.floor(Date.now() / 1000);

    if (parsed.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: 'mock-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: 'assistant' }));
      for (const word of text.split(' ')) res.write(chunk({ content: word + ' ' }));
      res.write(chunk({}, 'stop'));
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model: 'mock-model',
        choices: [], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id, object: 'chat.completion', created, model: 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
      }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-llm] listening on 127.0.0.1:${PORT}`));
