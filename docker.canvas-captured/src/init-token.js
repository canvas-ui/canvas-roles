import { chmodSync, chownSync } from 'node:fs';
import path from 'node:path';
import { ensureTokenFile } from './token.js';

const file = process.env.CAPTURE_TOKEN_FILE;
if (!file) throw new Error('CAPTURE_TOKEN_FILE is required');
const created = ensureTokenFile(file);
// Only this one-shot initializer can write the mounted secrets directory.
chownSync(path.dirname(file), 1000, 1000);
chmodSync(path.dirname(file), 0o700);
chownSync(file, 1000, 1000);
chmodSync(file, 0o400);
console.log(JSON.stringify({ event: created ? 'token_created' : 'token_preserved', file }));
