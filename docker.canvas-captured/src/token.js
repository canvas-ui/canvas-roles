import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function readToken(file) {
  if (!lstatSync(file).isFile()) throw new Error(`Token path ${file} must be a regular file`);
  const token = readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new Error(`Invalid token file ${file}: expected a 32–256 character base64url service token. Move the invalid file aside and restart to generate one; existing files are never overwritten.`);
  }
  return token;
}

/** Publish a complete token atomically, without replacing an existing credential. */
export function ensureTokenFile(file) {
  try { readToken(file); return false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.capture-token-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  let created = false;
  try {
    try {
      writeFileSync(fd, randomBytes(32).toString('base64url') + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(temporary, file); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { unlinkSync(temporary); }
  readToken(file);
  return created;
}
