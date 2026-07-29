// Shell-neutral build-asset copy: non-TS runtime files ship beside their compiled output
// byte-identical (the client hook dispatcher, and the Python AST script the Python plugin runs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = [
  { from: path.join('src', 'cli', 'dispatcher'), to: path.join('dist', 'cli', 'dispatcher'), file: 'repovine-client-dispatcher.mjs' },
  {
    from: path.join('packages', 'plugins', 'source-python', 'src'),
    to: path.join('packages', 'plugins', 'source-python', 'dist'),
    file: 'route-ast-script.py',
  },
];
for (const asset of assets) {
  const src = path.join(root, asset.from, asset.file);
  const dest = path.join(root, asset.to, asset.file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
