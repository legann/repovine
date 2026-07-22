// Shell-neutral build-asset copy: the bundled Python AST script ships in dist/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = path.join('source-plugins', 'python', 'route-ast-script.py');
const src = path.join(root, 'src', rel);
const dest = path.join(root, 'dist', rel);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
