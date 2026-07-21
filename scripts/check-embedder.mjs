#!/usr/bin/env node
/**
 * Real embedder contract check — guards the @huggingface/transformers peer range
 * (`^3.8.1 || ^4.0.0` in package.json) with actual ONNX inference through repovine's own
 * `createEmbedder` (from dist).
 *
 * This is a standalone Node script, not a Jest test: onnxruntime's typed-array checks fail under
 * Jest's ESM VM sandbox (tensors get a different-realm Float32Array). The CI matrix
 * (.github/workflows/embedder-matrix.yml) installs transformers at each end of the range and runs
 * this after a build. Locally: `npm run check:embedder`. Downloads a ~23MB model on first run.
 *
 * Exit 0 = contract holds; non-zero = failure (prints which assertion).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { createEmbedder } from '../dist/semantic/embedder.js';

const DIM = 384; // Xenova/all-MiniLM-L6-v2

function transformersVersion(root) {
  try {
    const resolved = createRequire(path.join(root, 'package.json')).resolve('@huggingface/transformers');
    const pkgRoot = resolved.slice(0, resolved.indexOf('@huggingface/transformers') + '@huggingface/transformers'.length);
    return JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const checks = [];
function assert(name, cond) {
  checks.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

const root = process.cwd();
console.log(`check-embedder: transformers@${transformersVersion(root)} (workspace ${root})`);

const embedder = createEmbedder(true, root);
assert('createEmbedder returns an embedder', embedder !== null);

const [anchor, related, unrelated] = await embedder.embed([
  'the graph stores repository structure and dependencies',
  'repository dependency graph',
  'a recipe for baking chocolate cake',
]);

for (const [label, vec] of [['anchor', anchor], ['related', related], ['unrelated', unrelated]]) {
  assert(`${label}: ${DIM}-dim`, Array.isArray(vec) && vec.length === DIM);
  assert(`${label}: all finite`, vec.every(n => Number.isFinite(n)));
  const norm = Math.sqrt(vec.reduce((s, n) => s + n * n, 0));
  assert(`${label}: L2-normalized (norm=${norm.toFixed(5)})`, Math.abs(norm - 1) < 1e-3);
}

const simRelated = cosine(anchor, related);
const simUnrelated = cosine(anchor, unrelated);
assert(`semantic ordering (related ${simRelated.toFixed(3)} > unrelated ${simUnrelated.toFixed(3)})`, simRelated > simUnrelated);

const failed = checks.filter(c => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
