// Standalone integration/conformance check for authors adapting the example Go plugin.
//
//   cd repovine && npm run build && node examples/repovine-plugin-go/run.mjs
//
// Analyzes fixtures/sample/ with the plugin wired in exactly as a user would (the plugin resolved
// from the analyzed repo's node_modules, INV-5), runs the real Stage-1 loader + extraction, and
// prints emitted facts plus core-projected API entrypoints from semanticHints.routes.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = here;
const target = path.join(here, 'fixtures', 'sample');
const distDir = path.resolve(here, '..', '..', 'dist');

if (!fs.existsSync(distDir)) {
  console.error('dist/ not found — run `npm run build` in the repovine repo first.');
  process.exit(1);
}
if (!fs.existsSync(target)) {
  console.error(`fixture not found: ${target}`);
  process.exit(1);
}

// Make `repovine-plugin-go` resolvable from the analyzed repo's node_modules (what `npm i` would do).
const nm = path.join(target, 'node_modules');
const link = path.join(nm, 'repovine-plugin-go');
fs.mkdirSync(nm, { recursive: true });
fs.rmSync(link, { recursive: true, force: true });
fs.symlinkSync(pluginRoot, link, 'junction');

const imp = rel => import(pathToFileURL(path.join(distDir, rel)).href);
const { checkSourcePluginConformance } = await import('@repovine/plugin-sdk');
const { collectRepositoryFactsAsync } = await imp('stage1/index.js');
const { collectFrameworkApiEntrypoints } = await imp('interpreters/server-entrypoints/entrypoints.js');

const plugin = (await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)).default;

const conformance = await checkSourcePluginConformance(plugin, { sampleRepoRoot: target });
console.log('=== Source plugin conformance ===');
for (const check of conformance.checks) {
  console.log(`  ${check.ok ? 'ok ' : 'FAIL'} ${check.name}${!check.ok && check.detail ? ` (${check.detail})` : ''}`);
}
if (!conformance.passed) process.exit(1);

const origLog = console.log;
console.log = () => {};
const snapshot = await collectRepositoryFactsAsync(target, {
  plugins: { defaults: true, add: ['repovine-plugin-go'], disable: [] },
  maxPackageWorkers: 1,
});
console.log = origLog;

const go = snapshot.modules.filter(m => m.sourcePluginId === 'go');
console.log(`\n=== ${go.length} modules from the 'go' plugin in fixtures/sample/ (sourcePluginId + contentHash stamped by the engine) ===`);
for (const m of go) {
  console.log(`\n${m.id}  hash=${m.contentHash}`);
  console.log('  imports:', m.imports.map(i => i.moduleSpecifier).join(', ') || '—');
  console.log('  exports:', m.exports.map(e => e.name).join(', ') || '—');
  for (const r of m.semanticHints?.routes ?? []) {
    console.log(`  route:   ${r.method} ${r.path}  [${m.semanticHints.webFramework}]`);
  }
}

const entrypoints = collectFrameworkApiEntrypoints({ snapshot });
console.log(`\n=== ${entrypoints.length} API entrypoints the CORE projected from the plugin's route facts (no new interpreter) ===`);
for (const e of entrypoints) {
  console.log(`  ${e.kind.toUpperCase()} ${e.method} ${e.path}  source=${e.source}  ->  ${e.moduleId}`);
}

fs.rmSync(nm, { recursive: true, force: true });
