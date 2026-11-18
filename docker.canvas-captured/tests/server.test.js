import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createCaptureServer } from '../src/server.js';

const token = 'test-capture-token-with-at-least-32-characters';
const config = { token, concurrency: 1, timeoutMs: 500, maxBytes: 1024 };
const result = { html: Buffer.from('<html>saved</html>'), finalUrl: 'https://example.com/changed?q=1',
  capturedAt: '2026-11-18T00:00:00.000Z', engine: 'single-file-cli/test', sha256: 'abc' };

async function setup(t, capture = async () => result) {
  const logs = [];
  const server = createCaptureServer(config, capture, line => logs.push(line));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, options = {}) => fetch(`${base}/v1/captures`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), ...options,
  });
  return { server, base, post, logs };
}

test('auth, protocol and strict arguments fail before capture', async t => {
  let calls = 0;
  const { base, post } = await setup(t, async () => { calls++; return result; });
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await post({ url: 'https://example.com' }, { headers: {} })).status, 401);
  for (const body of [{ url: 'http://localhost' }, { url: 'https://example.com', cookies: 'secret' },
    { url: 'https://example.com', timeoutMs: 501 }, { url: 'https://example.com', maxBytes: null }, []]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post({}, { body: '{' })).status, 400);
  assert.equal((await post({}, { body: 'x'.repeat(17000) })).status, 413);
  assert.equal(calls, 0);
});

test('serves exact HTML bytes and provenance without logging URL or token', async t => {
  const { post, logs } = await setup(t);
  const response = await post({ url: 'https://example.com/?secret=yes' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), result.html.toString());
  assert.equal(response.headers.get('x-capture-final-url'), result.finalUrl);
  assert.equal(response.headers.get('x-capture-engine'), result.engine);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.doesNotMatch(logs.join(''), /secret|example|test-capture-token/);
  assert.equal(JSON.parse(logs[0]).outcome, 'ok');
});

test('timeout kills work, rejects excess concurrency and releases the slot', async t => {
  let calls = 0;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const { post } = await setup(t, async (_input, _config, signal) => {
    calls++;
    if (calls > 1) return result;
    began();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const first = post({ url: 'https://example.com', timeoutMs: 150 });
  await started;
  const busy = await post({ url: 'https://example.com' });
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '5');
  const timedOut = await first;
  assert.equal(timedOut.status, 504);
  assert.equal((await timedOut.json()).error.code, 'capture_timeout');
  assert.equal((await post({ url: 'https://example.com' })).status, 200);
});

test('disconnect cancels running work', async t => {
  let began, cancelled;
  const started = new Promise(resolve => { began = resolve; });
  const stopped = new Promise(resolve => { cancelled = resolve; });
  const { post } = await setup(t, async (_input, _config, signal) => {
    began();
    await new Promise((_, reject) => signal.addEventListener('abort', () => {
      cancelled(signal.reason.code); reject(signal.reason);
    }, { once: true }));
  });
  const controller = new AbortController();
  const pending = post({ url: 'https://example.com' }, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending);
  assert.equal(await stopped, 'cancelled');
});
