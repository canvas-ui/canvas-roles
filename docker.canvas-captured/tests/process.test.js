import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '../src/process.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('process runner enforces cancellation and bounded stdout', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    signal: AbortSignal.timeout(100),
  }), { name: 'TimeoutError' });
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], {
    maxStdout: 1024,
  }), { code: 'output_too_large' });
  assert.equal(await runProcess(process.execPath, ['-e', 'console.log("ok")'], {}), 'ok\n');
});

test('cancellation stops descendants as well as the CLI process', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'captured-process-test-'));
  const marker = path.join(directory, 'heartbeat');
  const heartbeat = `const fs=require('fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)},String(Date.now())),10)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(heartbeat)}]);setInterval(()=>{},1000)`;
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', parent], { signal: controller.signal });
  // Attach a handler immediately; failed assertions still cancel and reap the group.
  pending.catch(() => {});
  try {
    for (let i = 0; i < 100; i++) {
      if (await stat(marker).catch(() => null)) break;
      await delay(10);
    }
    assert.ok(await stat(marker));
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const stopped = await readFile(marker, 'utf8');
    await delay(100);
    assert.equal(await readFile(marker, 'utf8'), stopped);
  } finally {
    controller.abort();
    await pending.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
