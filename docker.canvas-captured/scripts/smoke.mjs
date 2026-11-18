import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

async function reservePort(host) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return { server, port: server.address().port };
}

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(path.join(tmpdir(), 'captured-smoke-'));
// A non-default bind address exercises health checks on the configured interface.
const apiHost = '127.0.0.2';
const api = await reservePort(apiHost);
const proxy = await reservePort('0.0.0.0');
const env = { ...process.env, CAPTURE_BIND_ADDRESS: apiHost,
  CAPTURE_PORT: String(api.port), CAPTURE_PROXY_PORT: String(proxy.port),
  CAPTURE_SECRETS_DIR: path.join(scratch, 'secrets') };
const args = ['compose', '-p', `captured-smoke-${process.pid}`, '-f', path.join(root, 'compose.yaml')];
const sync = (...cmd) => execFileSync('docker', [...args, ...cmd], { cwd: root, env, encoding: 'utf8', maxBuffer: 1024 * 1024 });
function compose(...cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...args, ...cmd], { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Compose ${cmd[0]} failed (${code})`)));
  });
}

try {
  await Promise.all([api, proxy].map(({ server }) => new Promise(resolve => server.close(resolve))));
  await compose('up', '-d', '--wait', '--wait-timeout', '60');
  const readToken = () => sync('exec', '-T', 'captured', 'node', '-e',
    "process.stdout.write(require('fs').readFileSync(process.env.CAPTURE_TOKEN_FILE,'utf8'))").trim();
  const token = readToken();
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(token), 'First startup must generate a 256-bit token');
  assert.ok(!sync('logs', '--no-color', 'token-init').includes(token), 'Token must not appear in logs');
  for (const service of ['captured', 'egress']) {
    const id = sync('ps', '-q', service).trim();
    assert.equal(execFileSync('docker', ['inspect', '--format', '{{.HostConfig.NetworkMode}}', id], { encoding: 'utf8' }).trim(), 'host');
  }
  const base = `http://${apiHost}:${api.port}`;
  const post = body => fetch(`${base}/v1/captures`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(130000),
  });
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/v1/captures`, { method: 'POST' })).status, 401);
  for (const url of [`${base}/healthz`, 'http://169.254.169.254/latest', 'http://[::1]']) {
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
    const nonLoopbackProxyListener = await new Promise(resolve => {
      const s = net.connect(${proxy.port}, '${apiHost}');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(2000, () => { s.destroy(); resolve(false); });
    });
    assert.equal(nonLoopbackProxyListener, false, 'Proxy must bind only to 127.0.0.1');
    for (const target of ['http://169.254.169.254/', 'http://10.0.0.1/', 'http://127.0.0.1/']) {
      const status = await new Promise((resolve, reject) => {
        http.get({hostname:'127.0.0.1',port:${proxy.port},path:target}, r => {r.resume();resolve(r.statusCode)}).on('error',reject);
      });
      assert.equal(status,403);
    }
    assert.equal(readdirSync('/tmp').some(n => n.startsWith('canvas-capture-')), false);
    console.log('Host networking verified; proxy binds only loopback and denies private targets; temporary captures cleaned');
  `);
  console.log(checks.trim());
  sync('exec', '-T', 'captured', 'node', '--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import assert from 'node:assert/strict';
    assert.throws(() => writeFileSync('/run/secrets/write-probe', 'test'), { code: 'EROFS' });
  `);
  await compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '60');
  assert.ok(readToken() === token, 'Generated token must survive container recreation');
  assert.equal((await post({ url: 'http://127.0.0.1/' })).status, 400);
  console.log('Missing token generated, never logged, mounted read-only and preserved across recreation');
  console.log('Docker smoke passed');
} catch (error) {
  console.error(sync('logs', '--no-color', '--tail', '50'));
  throw error;
} finally {
  try { await compose('down', '--timeout', '5'); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
