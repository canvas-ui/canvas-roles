import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseTarget } from './network-policy.js';
import { CaptureError } from './errors.js';
import { capturePage, checkBrowser } from './capture.js';
import { readConfig } from './config.js';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readRequest(req, config) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new CaptureError('invalid_content_type', 'Use Content-Type: application/json', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16384) throw new CaptureError('request_too_large', 'JSON request exceeds 16384 bytes', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks)); } catch {
    throw new CaptureError('invalid_json', 'Body must be valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CaptureError('invalid_request', 'Body must be a JSON object');
  for (const key of Object.keys(body)) {
    if (!['url', 'timeoutMs', 'maxBytes'].includes(key)) {
      throw new CaptureError('unknown_argument', `Unknown argument ${key}; allowed arguments: url, timeoutMs, maxBytes`);
    }
  }
  const result = { url: parseTarget(body.url).href };
  for (const key of ['timeoutMs', 'maxBytes']) {
    const value = Object.hasOwn(body, key) ? body[key] : config[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > config[key]) {
      throw new CaptureError('invalid_argument', `${key} must be an integer between 1 and ${config[key]}`);
    }
    result[key] = value;
  }
  return result;
}

export function createCaptureServer(config, capture = capturePage, log = console.log) {
  const tokenHash = createHash('sha256').update(`Bearer ${config.token}`).digest();
  const active = new Set();
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { status: 'ok', api: { major: 1, minor: 0 } });
    const supplied = createHash('sha256').update(req.headers.authorization || '').digest();
    if (!timingSafeEqual(supplied, tokenHash)) {
      res.setHeader('Connection', 'close');
      res.setHeader('WWW-Authenticate', 'Bearer');
      return json(res, 401, { error: { code: 'unauthorized', message: 'A valid service bearer token is required' } });
    }
    if (req.url !== '/v1/captures') return json(res, 404, { error: { code: 'not_found', message: 'Use POST /v1/captures' } });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, { error: { code: 'method_not_allowed', message: 'Use POST /v1/captures' } });
    }
    if (active.size >= config.concurrency) {
      res.setHeader('Retry-After', '5');
      res.setHeader('Connection', 'close');
      return json(res, 429, { error: { code: 'busy', message: 'All capture slots are occupied; retry later' } });
    }
    const controller = new AbortController();
    active.add(controller);
    const started = Date.now();
    const disconnected = () => {
      if (!res.writableFinished) controller.abort(new CaptureError('cancelled', 'Capture client disconnected', 499));
    };
    req.once('aborted', disconnected);
    res.once('close', disconnected);
    let timer = setTimeout(() => {
      controller.abort(new CaptureError('request_timeout', 'Request body timed out', 408));
      req.destroy();
    }, 10000);
    let outcome = 'ok';
    try {
      const input = await readRequest(req, config);
      clearTimeout(timer);
      controller.signal.throwIfAborted();
      timer = setTimeout(() => controller.abort(new CaptureError('capture_timeout', 'Capture exceeded timeoutMs', 504)), input.timeoutMs);
      const result = await capture(input, config, controller.signal);
      controller.signal.throwIfAborted();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Length': result.html.length,
        'Content-Disposition': 'attachment; filename="capture.html"',
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; frame-src data:",
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
        'X-Capture-Final-Url': result.finalUrl,
        'X-Capture-Time': result.capturedAt, 'X-Capture-Engine': result.engine,
        'X-Capture-Sha256': result.sha256,
      });
      await pipeline(Readable.from([result.html]), res, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) error = controller.signal.reason;
      const known = error instanceof CaptureError;
      outcome = known ? error.code : 'capture_failed';
      if (!res.destroyed && !res.headersSent) {
        res.setHeader('Connection', 'close');
        json(res, known ? error.status : 502, { error: {
          code: outcome, message: known ? error.message : 'Capture failed',
        } });
      }
    } finally {
      clearTimeout(timer);
      active.delete(controller);
      req.off('aborted', disconnected);
      res.off('close', disconnected);
      log(JSON.stringify({ event: 'capture', outcome, durationMs: Date.now() - started }));
    }
  });
  server.maxConnections = 128;
  server.on('close', () => { for (const task of active) task.abort(new CaptureError('shutdown', 'Service shutting down', 503)); });
  server.shutdown = () => {
    for (const task of active) task.abort(new CaptureError('shutdown', 'Service shutting down', 503));
    server.close();
    server.closeAllConnections();
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readConfig();
  await checkBrowser(config);
  const server = createCaptureServer(config);
  server.listen(config.port, config.host, () => console.log(JSON.stringify({ event: 'listening', port: config.port })));
  process.on('SIGTERM', () => server.shutdown());
  process.on('SIGINT', () => server.shutdown());
}
