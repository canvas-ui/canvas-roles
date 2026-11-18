import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig, readProxyConfig } from '../src/config.js';

test('startup refuses missing/weak credentials and invalid deployment limits', async () => {
  assert.throws(() => readConfig({}), /CAPTURE_TOKEN_FILE/);
  const directory = await mkdtemp(path.join(tmpdir(), 'captured-config-test-'));
  const file = path.join(directory, 'token');
  const env = { CAPTURE_TOKEN_FILE: file };
  try {
    await writeFile(file, 'weak');
    assert.throws(() => readConfig(env), /base64url service token/);
    await writeFile(file, 'a'.repeat(43) + '\n');
    assert.equal(readConfig(env).token, 'a'.repeat(43));
    assert.throws(() => readConfig({ ...env, CAPTURE_CONCURRENCY: '0' }), /CAPTURE_CONCURRENCY/);
    assert.throws(() => readConfig({ ...env, CAPTURE_TIMEOUT_MS: 'Infinity' }), /CAPTURE_TIMEOUT_MS/);
    assert.throws(() => readConfig({ ...env, CAPTURE_PROXY_URL: 'http://user:password@egress:3128' }), /CAPTURE_PROXY_URL/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('host-network listeners default to loopback and proxy ports are validated', () => {
  assert.deepEqual(readProxyConfig({}), { host: '127.0.0.1', port: 3128 });
  assert.deepEqual(readProxyConfig({ PROXY_PORT: '43128' }), { host: '127.0.0.1', port: 43128 });
  for (const port of ['0', '-1', '65536', '1.5', 'abc']) {
    assert.throws(() => readProxyConfig({ PROXY_PORT: port }), /PROXY_PORT/);
  }
});
