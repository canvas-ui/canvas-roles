import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createEgressProxy } from '../src/proxy.js';
import { resolvePublic } from '../src/network-policy.js';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.shutdown?.(); server.close(); server.closeAllConnections?.(); });
  return server.address().port;
}

function proxyGet(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: url, headers: { 'proxy-authorization': 'must-not-leak' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, location: res.headers.location }));
    });
    req.on('error', reject);
  });
}

test('HTTP proxy pins public DNS, strips proxy auth, and denies redirect destinations', async t => {
  const targetPort = await listen(t, http.createServer((req, res) => {
    assert.equal(req.headers.host, 'example.com');
    assert.equal(req.headers['proxy-authorization'], undefined);
    res.writeHead(302, { Location: 'http://169.254.169.254/latest' });
    res.end();
  }));
  let connects = 0;
  const proxy = createEgressProxy({
    resolve: host => resolvePublic(host, async () => [{ address: '93.184.216.34', family: 4 }]),
    request: (options, callback) => {
      connects++;
      assert.equal(options.hostname, '93.184.216.34');
      return http.request({ ...options, hostname: '127.0.0.1', port: targetPort }, callback);
    },
  });
  const port = await listen(t, proxy);
  const response = await proxyGet(port, 'http://example.com/article');
  assert.equal(response.status, 302);
  assert.equal((await proxyGet(port, response.location)).status, 403);
  for (const url of ['http://127.0.0.1', 'http://10.0.0.1', 'http://[::1]', 'http://example.com:8001', 'file:///etc/passwd']) {
    assert.equal((await proxyGet(port, url)).status, 403);
  }
  assert.equal(connects, 1);
});

test('HTTPS CONNECT only accepts public port 443 and pins the connection address', async t => {
  const echo = net.createServer(socket => socket.pipe(socket));
  const echoPort = await listen(t, echo);
  let connects = 0;
  const port = await listen(t, createEgressProxy({
    resolve: host => resolvePublic(host, async () => [{ address: '93.184.216.34', family: 4 }]),
    connect: options => {
      connects++;
      assert.deepEqual(options, { host: '93.184.216.34', port: 443, family: 4 });
      return net.connect({ host: '127.0.0.1', port: echoPort });
    },
  }));
  async function tunnel(authority) {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const [data] = await once(socket, 'data');
    socket.destroy();
    return data.toString();
  }
  assert.match(await tunnel('example.com:443'), /200 Connection Established/);
  for (const target of ['127.0.0.1:443', '[::1]:443', 'example.com:22', 'example.com:443/path', 'user@example.com:443']) {
    assert.match(await tunnel(target), /403 Forbidden/);
  }
  assert.equal(connects, 1);
});
