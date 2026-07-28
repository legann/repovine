// Shell-neutral `npm run clean`: removes build output on every OS.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDirs = [
  'dist',
  path.join('packages', 'plugin-sdk', 'dist'),
  path.join('packages', 'plugin-sdk', 'tsconfig.tsbuildinfo'),
  path.join('packages', 'plugins', 'dist'),
];
const pluginsRoot = path.join(root, 'packages', 'plugins');
for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    buildDirs.push(
      path.join('packages', 'plugins', entry.name, 'dist'),
      path.join('packages', 'plugins', entry.name, 'tsconfig.tsbuildinfo'),
    );
  }
}
for (const dir of buildDirs) {
  // maxRetries: Windows AV/indexer can hold files briefly (EBUSY/EPERM).
  fs.rmSync(path.join(root, dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
