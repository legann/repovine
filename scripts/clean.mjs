// Shell-neutral `npm run clean`: removes build output on every OS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of ['dist', path.join('packages', 'plugin-sdk', 'dist')]) {
  // maxRetries: Windows AV/indexer can hold files briefly (EBUSY/EPERM).
  fs.rmSync(path.join(root, dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
