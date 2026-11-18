import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), 'captured-smoke-'));
const token = randomBytes(32).toString('base64url');
const override = path.join(scratch, 'compose.json');
await writeFile(path.join(scratch, 'token'), token + '\n', { mode: 0o644 });
await writeFile(override, JSON.stringify({ secrets: { capture_token: { file: path.join(scratch, 'token') } } }));
const env = { ...process.env, CAPTURE_BIND_ADDRESS: '127.0.0.1', CAPTURE_HOST_PORT: '0', CAPTURE_NETWORK_PREFIX: '172.30.87' };
const args = ['compose', '-p', `captured-smoke-${process.pid}`, '-f', path.join(root, 'compose.yaml'), '-f', override];
const sync = (...cmd) => execFileSync('docker', [...args, ...cmd], { cwd: root, env, encoding: 'utf8', maxBuffer: 1024 * 1024 });
function compose(...cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...args, ...cmd], { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Compose ${cmd[0]} failed (${code})`)));
  });
}

try {
  await compose('up', '-d', '--wait', '--wait-timeout', '60');
  const base = `http://${sync('port', 'api', '8080').trim()}`;
  const post = body => fetch(`${base}/v1/captures`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(130000),
  });
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/v1/captures`, { method: 'POST' })).status, 401);
  for (const url of ['http://127.0.0.1:8080/healthz', 'http://169.254.169.254/latest', 'http://[::1]']) {
    assert.equal((await post({ url })).status, 400);
  }
  const response = await post({ url: 'https://example.com/' });
  const html = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, html.toString());
  assert.match(html.toString(), /Example Domain/);
  assert.match(html.toString(), /SingleFile/);
  assert.equal(response.headers.get('x-capture-sha256'), createHash('sha256').update(html).digest('hex'));
  assert.equal(response.headers.get('x-capture-final-url'), 'https://example.com/');
  console.log(`Captured example.com: ${html.length} bytes (${response.headers.get('x-capture-engine')})`);
  assert.equal((await post({ url: 'https://example.com/', maxBytes: 1 })).status, 413);
  assert.equal((await post({ url: 'https://example.com/', timeoutMs: 1 })).status, 504);
  const checks = sync('exec', '-T', 'captured', 'node', '--input-type=module', '-e', `
    import net from 'node:net';
    import http from 'node:http';
    import assert from 'node:assert/strict';
    import { readdirSync } from 'node:fs';
    const reachable = await new Promise(resolve => {
      const s = net.connect(443, '1.1.1.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(2000, () => { s.destroy(); resolve(false); });
    });
    assert.equal(reachable, false, 'Direct browser egress must be blocked');
    for (const target of ['http://169.254.169.254/', 'http://172.30.87.1/', 'http://127.0.0.1/']) {
      const status = await new Promise((resolve, reject) => {
        http.get({hostname:'172.30.87.2',port:3128,path:target}, r => {r.resume();resolve(r.statusCode)}).on('error',reject);
      });
      assert.equal(status,403);
    }
    assert.equal(readdirSync('/tmp').some(n => n.startsWith('canvas-capture-')), false);
    console.log('Direct egress blocked; proxy denies private targets; temporary captures cleaned');
  `);
  console.log(checks.trim());
  console.log('Docker smoke passed');
} catch (error) {
  console.error(sync('logs', '--no-color', '--tail', '50'));
  throw error;
} finally {
  try { await compose('down', '--timeout', '5'); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
