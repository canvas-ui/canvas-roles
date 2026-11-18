import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { CaptureError } from './errors.js';

export function isPublicAddress(address) {
  if (!isIP(address)) return false;
  if (address === '168.63.129.16') return false; // Azure host virtual IP.
  const ip = ipaddr.parse(address);
  if (ip.range() !== 'unicast') return false;
  // Only allocated global-unicast IPv6; exclude documentation and transition space.
  return ip.kind() === 'ipv4' || (ip.match(ipaddr.parse('2000::'), 3)
    && !ip.match(ipaddr.parse('3fff::'), 20));
}

export function parseTarget(value) {
  if (typeof value !== 'string' || value.length > 8192) {
    throw new CaptureError('invalid_url', 'url must be an HTTP(S) URL of at most 8192 characters');
  }
  let url;
  try { url = new URL(value); } catch {
    throw new CaptureError('invalid_url', 'url must be an absolute HTTP(S) URL');
  }
  if (url.href.length > 8192) throw new CaptureError('invalid_url', 'The serialized URL must not exceed 8192 characters');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new CaptureError('invalid_url', 'url must use HTTP(S) without embedded credentials');
  }
  if (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) {
    throw new CaptureError('blocked_target', 'Only HTTP port 80 and HTTPS port 443 are allowed');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname.includes('.') && !isIP(hostname)
    || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|onion)$/.test(hostname)
    || (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new CaptureError('blocked_target', 'Capture targets must use public Internet addresses');
  }
  return url;
}

export async function resolvePublic(hostname, resolve = lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }]
      : await resolve(host, { all: true, verbatim: true });
  } catch {
    throw new CaptureError('dns_failed', 'Could not resolve the target host', 502);
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new CaptureError('blocked_target', 'All resolved target addresses must be public');
  }
  // The proxy connects to this literal address: no second DNS lookup / rebinding window.
  return addresses.find(({ family }) => family === 4) || addresses[0];
}
