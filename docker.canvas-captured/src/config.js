import { readFileSync } from 'node:fs';

function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function readConfig(env = process.env) {
  if (!env.CAPTURE_TOKEN_FILE) throw new Error('CAPTURE_TOKEN_FILE is required');
  const token = readFileSync(env.CAPTURE_TOKEN_FILE, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error('CAPTURE_TOKEN_FILE must contain a 32–256 character base64url service token');
  }
  const proxy = new URL(env.CAPTURE_PROXY_URL || 'http://127.0.0.1:3128');
  if (proxy.protocol !== 'http:' || proxy.username || proxy.password
    || proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw new Error('CAPTURE_PROXY_URL must be an HTTP proxy origin without credentials');
  }
  return {
    token,
    host: env.CAPTURE_HOST || '127.0.0.1',
    port: integer(env, 'CAPTURE_PORT', 8085, 1, 65535),
    concurrency: integer(env, 'CAPTURE_CONCURRENCY', 1, 1, 8),
    timeoutMs: integer(env, 'CAPTURE_TIMEOUT_MS', 120000, 1000, 300000),
    maxBytes: integer(env, 'CAPTURE_MAX_BYTES', 32 * 1024 ** 2, 1024, 128 * 1024 ** 2),
    proxyUrl: proxy.origin,
    browserPath: '/app/bin/chromium-sandboxed',
  };
}

export function readProxyConfig(env = process.env) {
  return { host: '127.0.0.1', port: integer(env, 'PROXY_PORT', 3128, 1, 65535) };
}
