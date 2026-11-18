import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';

await mkdir(new URL('../secrets/', import.meta.url), { recursive: true, mode: 0o700 });
try {
  // Compose bind-mounts the file; the container's non-root uid must be able to read it.
  // The parent directory remains accessible only to its host owner.
  await writeFile(new URL('../secrets/capture-token', import.meta.url), randomBytes(32).toString('base64url') + '\n', {
    flag: 'wx', mode: 0o644,
  });
  console.log('Created secrets/capture-token');
} catch (error) { if (error.code !== 'EEXIST') throw error; }
try {
  await copyFile(new URL('../.env.example', import.meta.url), new URL('../.env', import.meta.url), constants.COPYFILE_EXCL);
  console.log('Created .env; set CAPTURE_BIND_ADDRESS to the VM private IP');
} catch (error) { if (error.code !== 'EEXIST') throw error; }
