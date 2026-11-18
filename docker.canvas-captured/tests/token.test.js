import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ensureTokenFile, readToken } from '../src/token.js';

function setup(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'captured-token-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'secrets', 'capture-token');
}

test('generates a persistent private token when the file and directory are missing', t => {
  const file = setup(t);
  assert.equal(ensureTokenFile(file), true);
  const token = readToken(file);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(ensureTokenFile(file), false);
  assert.equal(readToken(file), token);
  assert.deepEqual(readdirSync(path.dirname(file)), ['capture-token']);
});

test('preserves existing valid tokens and rejects invalid files without overwriting', t => {
  const file = setup(t);
  mkdirSync(path.dirname(file));
  for (const value of ['a'.repeat(43) + '\n', '', 'placeholder', '!'.repeat(43)]) {
    writeFileSync(file, value);
    if (value.startsWith('a')) assert.equal(ensureTokenFile(file), false);
    else assert.throws(() => ensureTokenFile(file), /Move the invalid file aside/);
    assert.equal(readFileSync(file, 'utf8'), value);
  }
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => ensureTokenFile(file), /regular file/);
  rmSync(file, { recursive: true });
  const target = path.join(path.dirname(file), 'other');
  writeFileSync(target, 'a'.repeat(43));
  symlinkSync(target, file);
  assert.throws(() => ensureTokenFile(file), /regular file/);
});

test('concurrent initializers publish one complete token without rotation or temporary files', async t => {
  const file = setup(t);
  const module = new URL('../src/token.js', import.meta.url).href;
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      import(workerData.module).then(({ ensureTokenFile, readToken }) => {
        const created = ensureTokenFile(workerData.file);
        parentPort.postMessage({ created, token: readToken(workerData.file) });
      });
    `, { eval: true, workerData: { module, file } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`Initializer exited ${code}`)); });
  })));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.ok(results.every(result => result.token === readToken(file)));
  assert.deepEqual(readdirSync(path.dirname(file)), ['capture-token']);
});
