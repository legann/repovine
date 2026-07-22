// Shell-neutral build-asset copy: non-TS runtime files ship in dist/ byte-identical
// (the bundled Python AST script and the client hook dispatcher).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rels = [
  path.join('source-plugins', 'python', 'route-ast-script.py'),
  path.join('cli', 'dispatcher', 'repovine-client-dispatcher.mjs'),
];
for (const rel of rels) {
  const src = path.join(root, 'src', rel);
  const dest = path.join(root, 'dist', rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
