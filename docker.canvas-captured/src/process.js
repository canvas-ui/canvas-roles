import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { CaptureError } from './errors.js';

export function runProcess(command, args, { cwd, env, signal, outputFile, maxBytes, maxStdout = 1024 * 1024 }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let failure;
    let size = 0;
    const output = [];
    const kill = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    };
    const fail = (error) => { failure ||= error; kill(); };
    const abort = () => fail(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxStdout) fail(new CaptureError('output_too_large', 'Capture metadata exceeds its limit', 502));
      else output.push(chunk);
    });
    // Browser diagnostics can contain URL credentials, query strings or page content.
    child.stderr.resume();
    const monitor = outputFile ? setInterval(async () => {
      try {
        if ((await stat(outputFile)).size > maxBytes) {
          fail(new CaptureError('output_too_large', 'Captured HTML exceeds the configured byte limit', 413));
        }
      } catch (error) { if (error.code !== 'ENOENT') fail(error); }
    }, 100) : null;
    child.once('error', error => { failure ||= error; });
    child.once('close', code => {
      if (monitor) clearInterval(monitor);
      signal?.removeEventListener('abort', abort);
      kill();
      if (failure) reject(failure);
      else if (code !== 0) reject(new CaptureError('capture_failed', 'Browser capture failed; check service readiness and target availability', 502));
      else resolve(Buffer.concat(output).toString('utf8'));
    });
  });
}
