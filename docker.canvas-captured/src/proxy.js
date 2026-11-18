import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { parseTarget, resolvePublic } from './network-policy.js';
import { readProxyConfig } from './config.js';

const MAX_CONNECTION_BYTES = 128 * 1024 ** 2;
const HOP_HEADERS = ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
  'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function headersWithoutHop(headers) {
  const result = { ...headers };
  const nominated = String(headers.connection || '').toLowerCase().split(',').map(s => s.trim());
  for (const key of [...HOP_HEADERS, ...nominated]) delete result[key];
  return result;
}

export function createEgressProxy({ resolve = resolvePublic, connect = net.connect, request = http.request } = {}) {
  const server = http.createServer({ maxHeaderSize: 32768, headersTimeout: 10000, requestTimeout: 30000 });
  const sockets = new Set();
  server.maxConnections = 256;
  server.on('connection', socket => {
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), 310000);
    socket.setTimeout(30000, () => socket.destroy());
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });
  });
  server.on('request', async (req, res) => {
    let upstream;
    const fail = () => {
      upstream?.destroy();
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      res.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('Destination denied or unavailable');
    };
    req.on('error', fail);
    res.once('close', () => upstream?.destroy());
    try {
      const target = parseTarget(req.url);
      if (target.protocol !== 'http:' || !['GET', 'HEAD', 'POST', 'OPTIONS'].includes(req.method)) return fail();
      const address = await resolve(target.hostname);
      if (req.destroyed || res.destroyed) return;
      upstream = request({
        hostname: address.address, family: address.family, port: 80,
        method: req.method, path: target.pathname + target.search, agent: false,
        headers: { ...headersWithoutHop(req.headers), host: target.host },
      }, response => {
        res.writeHead(response.statusCode, headersWithoutHop(response.headers));
        let bytes = 0;
        response.on('data', chunk => { if ((bytes += chunk.length) > MAX_CONNECTION_BYTES) fail(); });
        response.on('error', fail);
        response.pipe(res);
      });
      upstream.setTimeout(30000, fail);
      upstream.on('error', fail);
      let bytes = 0;
      req.on('data', chunk => { if ((bytes += chunk.length) > 1024 * 1024) fail(); });
      req.pipe(upstream);
    } catch { fail(); }
  });
  server.on('connect', async (req, client, head) => {
    let upstream;
    let established = false;
    const fail = () => {
      upstream?.destroy();
      if (client.destroyed) return;
      if (established) client.destroy();
      else client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    };
    client.on('error', () => upstream?.destroy());
    client.once('close', () => upstream?.destroy());
    try {
      const target = parseTarget(`https://${req.url}`);
      if (req.url.toLowerCase() !== `${target.hostname}:443`.toLowerCase()) return fail();
      const address = await resolve(target.hostname);
      if (client.destroyed) return;
      upstream = connect({ host: address.address, port: 443, family: address.family });
      upstream.on('error', fail);
      upstream.once('close', () => client.destroy());
      upstream.setTimeout(30000, fail);
      upstream.once('connect', () => {
        established = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        let bytes = head.length;
        const count = chunk => { if ((bytes += chunk.length) > MAX_CONNECTION_BYTES) fail(); };
        client.on('data', count);
        upstream.on('data', count);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch { fail(); }
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  server.shutdown = () => { server.close(); for (const socket of sockets) socket.destroy(); };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { host, port } = readProxyConfig();
  const server = createEgressProxy();
  server.listen(port, host);
  process.on('SIGTERM', () => server.shutdown());
  process.on('SIGINT', () => server.shutdown());
}
