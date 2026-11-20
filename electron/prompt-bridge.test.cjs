const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { test } = require('node:test');
const { createPromptHandler } = require('./prompt-bridge.cjs');

const rendererUrl = 'file:///jarvis/dist/index.html';
const sender = { senderFrame: { url: rendererUrl, parent: null } };

async function withWebhook(t, respond, options) {
  const server = createServer(respond);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const env = { JARVIS_N8N_PORT: String(server.address().port) };
  return createPromptHandler(rendererUrl, { env, ...options });
}

test('validates the top-level renderer, input and n8n port before sending', () => {
  const handle = createPromptHandler(rendererUrl, { env: { JARVIS_N8N_PORT: '65536' } });
  for (const event of [{}, { senderFrame: { url: rendererUrl, parent: {} } },
    { senderFrame: { url: 'file:///other.html', parent: null } }]) {
    assert.equal(handle(event, 'Hello').error.code, 'UNTRUSTED_SENDER');
  }
  for (const input of [undefined, null, 42, { prompt: 'Hello' }, ' \n ', 'a'.repeat(10_001)]) {
    assert.equal(handle(sender, input).error.code, 'INVALID_PROMPT');
  }
  assert.equal(handle(sender, 'Hello').error.code, 'INVALID_N8N_PORT');
});

test('POSTs the trimmed prompt and a generated timestamp to the configured local port', async (t) => {
  const requests = [];
  const handle = await withWebhook(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks)) });
    response.end(JSON.stringify({ output: '  Hello 👋\n', internal: 'ignored' }));
  });
  const prompt = 'x'.repeat(10_000);
  const started = Date.now();
  assert.deepEqual(await handle(sender, ` \n${prompt} `, 'https://example.com'), {
    success: true, data: { output: '  Hello 👋\n' },
  });
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/webhook/jarvis-prompt');
  assert.deepEqual(Object.keys(request.body), ['prompt', 'timestamp']);
  assert.equal(request.body.prompt, prompt);
  const timestamp = Date.parse(request.body.timestamp);
  assert.ok(timestamp >= started && timestamp <= Date.now());
});

test('returns actionable HTTP errors without forwarding redirects or upstream bodies', async (t) => {
  let status = 404;
  const paths = [];
  const handle = await withWebhook(t, (request, response) => {
    paths.push(request.url);
    response.writeHead(status, { Location: '/elsewhere' }).end('private response');
  });
  for (const [nextStatus, code, retryable] of [
    [404, 'WEBHOOK_NOT_FOUND', true], [503, 'WEBHOOK_HTTP_ERROR', true], [307, 'WEBHOOK_HTTP_ERROR', false],
  ]) {
    status = nextStatus;
    const result = await handle(sender, 'Hello');
    assert.equal(result.success, false);
    assert.equal(result.error.code, code);
    assert.equal(result.error.retryable, retryable);
    assert.doesNotMatch(result.error.message, /private response/);
  }
  assert.deepEqual(paths, Array(3).fill('/webhook/jarvis-prompt'));
});

test('rejects invalid JSON, malformed outputs and oversized responses', async (t) => {
  let body;
  const handle = await withWebhook(t, (_request, response) => response.end(body));
  for (const invalid of ['<html>', '[{"output":"Hi"}]', '{"output":" "}', '{"output":42}',
    JSON.stringify({ output: 'a'.repeat(1024 * 1024) })]) {
    body = invalid;
    assert.equal((await handle(sender, 'Hello')).error.code, 'INVALID_RESPONSE');
  }
});

test('times out while waiting for headers or for a stalled response body', async (t) => {
  let flushHeaders = false;
  let requests = 0;
  const handle = await withWebhook(t, (_request, response) => {
    requests++;
    if (flushHeaders) response.write('{"output":');
  }, { timeoutMs: 200 });
  assert.equal((await handle(sender, 'Hello')).error.code, 'WEBHOOK_TIMEOUT');
  flushHeaders = true;
  assert.equal((await handle(sender, 'Hello')).error.code, 'WEBHOOK_TIMEOUT');
  assert.equal(requests, 2);
});

test('returns a safe error when the local connection drops', async (t) => {
  const handle = await withWebhook(t, (request) => request.socket.destroy());
  const result = await handle(sender, 'Hello');
  assert.equal(result.error.code, 'N8N_UNAVAILABLE');
  assert.equal(result.error.retryable, true);
});

test('normalizes JSON string replies without changing their formatting', async (t) => {
  const output = '  **Hello**\n';
  const handle = await withWebhook(t, (_request, response) => response.end(JSON.stringify(output)));
  assert.deepEqual(await handle(sender, 'Hello'), { success: true, data: { output } });
});
