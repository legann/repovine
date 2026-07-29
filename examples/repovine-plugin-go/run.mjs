// Standalone integration/conformance check for authors adapting the example Go plugin.
//
//   cd repovine && npm run build && node examples/repovine-plugin-go/run.mjs
//
// Analyzes fixtures/sample/ with the plugin wired in exactly as a user would (the plugin resolved
// from the analyzed repo's node_modules), runs the real Stage-1 loader + extraction, and prints
// emitted facts plus the API entrypoints the core route collector projects from semanticHints.routes.
//
// This check calls that collector directly. In a graph build the built-in `server-entrypoints`
// interpreter reads `semanticHints.routes` for the `typescript` and `python` source plugins.

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
const { checkPluginConformance, checkSourcePluginConformance } = await import('@repovine/plugin-sdk');
const { collectRepositoryFactsAsync } = await imp('stage1/index.js');
const { collectFrameworkApiEntrypoints } = await imp('interpreters/server-entrypoints/entrypoints.js');

const descriptor = (await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)).default;
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).repovine;

// Two kits, two questions. The plugin kit checks the package contract — manifest, descriptor, and
// the agreement between them. The source kit checks the capability's behaviour on a sample repo.
const printChecks = (title, report) => {
  console.log(`=== ${title} ===`);
  for (const check of report.checks) {
    console.log(`  ${check.ok ? 'ok ' : 'FAIL'} ${check.name}${!check.ok && check.detail ? ` (${check.detail})` : ''}`);
  }
  if (!report.passed) process.exit(1);
};

printChecks('Plugin contract conformance', checkPluginConformance({ manifest, descriptor }));
printChecks(
  'Source capability conformance',
  await checkSourcePluginConformance(
    { ...descriptor.capabilities.source, id: descriptor.id },
    { sampleRepoRoot: target },
  ),
);

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
console.log(`\n=== ${entrypoints.length} API entrypoints the core route collector projected from the plugin's route facts ===`);
console.log("    (collector called directly; in a graph build 'server-entrypoints' reads these routes for the typescript and python plugins)");
for (const e of entrypoints) {
  console.log(`  ${e.kind.toUpperCase()} ${e.method} ${e.path}  source=${e.source}  ->  ${e.moduleId}`);
}

fs.rmSync(nm, { recursive: true, force: true });
