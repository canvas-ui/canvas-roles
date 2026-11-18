import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, parseTarget, resolvePublic } from '../src/network-policy.js';

test('rejects local, reserved, mapped and transitional addresses', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.1.1', '168.63.129.16', '100.64.0.1', '198.18.0.1', '192.0.2.1', '224.0.0.1', '240.0.0.1',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', 'ff02::1',
    '64:ff9b::a00:1', '2002:7f00:1::', '2001:db8::1', '3fff::1', '4000::1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});

test('URL validation closes alternate IP encodings, credentials, schemes and ports', () => {
  for (const url of ['file:///etc/passwd', 'data:text/html,test', 'http://user:pass@example.com',
    'http://2130706433', 'http://0177.0.0.1', 'http://0x7f000001', 'http://127.1',
    'http://[::ffff:127.0.0.1]', 'http://LOCALHOST.', 'http://metadata.google.internal',
    'http://egress', 'https://example.com:8080', 'http://example.com:443']) {
    assert.throws(() => parseTarget(url), undefined, url);
  }
  assert.equal(parseTarget('https://example.com:443/a?q=1').href, 'https://example.com/a?q=1');
});

test('DNS validation rejects mixed public/private answers and returns a pinned address', async () => {
  let calls = 0;
  const resolver = async () => { calls++; return [{ address: '93.184.216.34', family: 4 }]; };
  assert.deepEqual(await resolvePublic('example.com', resolver), { address: '93.184.216.34', family: 4 });
  assert.equal(calls, 1);
  await assert.rejects(resolvePublic('example.com', async () => [
    { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 },
  ]), { code: 'blocked_target' });
  await assert.rejects(resolvePublic('example.com', async () => []), { code: 'blocked_target' });
  await assert.rejects(resolvePublic('example.com', async () => { throw Error('DNS'); }), { code: 'dns_failed' });
});
