import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runProcess } from './process.js';
import { parseTarget } from './network-policy.js';
import { CaptureError } from './errors.js';

const cli = fileURLToPath(new URL('../node_modules/single-file-cli/single-file-node.js', import.meta.url));
const pkg = JSON.parse(await readFile(new URL('../node_modules/single-file-cli/package.json', import.meta.url)));

export async function capturePage({ url, timeoutMs, maxBytes }, config, signal) {
  const directory = await mkdtemp(path.join(tmpdir(), 'canvas-capture-'));
  const outputFile = path.join(directory, 'page.html');
  try {
    const metadata = await runProcess(process.execPath, [
      cli, url, outputFile,
      '--dump-content=false', '--dump-json=true',
      `--browser-executable-path=${config.browserPath}`,
      `--http-proxy-server=${config.proxyUrl}`,
      `--browser-load-max-time=${timeoutMs}`, `--browser-capture-max-time=${timeoutMs}`,
      '--browser-wait-until=networkAlmostIdle', '--browser-wait-until-fallback=false',
      '--browser-single-process=false', '--block-scripts=true', '--block-audios=true', '--block-videos=true',
      '--browser-args=' + JSON.stringify([
        '--proxy-bypass-list=<-loopback>', '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-features=WebRtcHideLocalIpsWithMdns,MediaRouter',
      ]),
    ], {
      cwd: directory,
      // Never pass service credentials or the server environment to the browser.
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'C.UTF-8' },
      signal, outputFile, maxBytes,
    });
    signal.throwIfAborted();
    const info = JSON.parse(metadata);
    if (!Number.isInteger(info.response?.status) || info.response.status >= 400) {
      throw new CaptureError('target_http_error', 'The target did not return a successful page response', 502);
    }
    const finalUrl = parseTarget(info.url || info.request?.url).href;
    const file = await stat(outputFile);
    if (!file.isFile() || !file.size || file.size > maxBytes) {
      throw new CaptureError('output_too_large', 'Captured HTML is empty or exceeds the configured byte limit', 413);
    }
    const html = await readFile(outputFile);
    if (!/<html[\s>]/i.test(html.subarray(0, 65536).toString('utf8'))) {
      throw new CaptureError('invalid_capture', 'The capture did not produce an HTML document', 502);
    }
    return {
      html, finalUrl, capturedAt: new Date().toISOString(),
      engine: `single-file-cli/${pkg.version}`,
      sha256: createHash('sha256').update(html).digest('hex'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function checkBrowser(config) {
  const directory = await mkdtemp(path.join(tmpdir(), 'canvas-probe-'));
  try {
    await runProcess(config.browserPath, ['--headless', '--disable-gpu', `--user-data-dir=${directory}/profile`, '--dump-dom', 'about:blank'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8' },
      signal: AbortSignal.timeout(20000), maxStdout: 65536,
    });
  } catch {
    throw new Error('Sandboxed Chromium could not start. Check unprivileged user namespaces, the role seccomp profile and writable /tmp; see README troubleshooting.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
