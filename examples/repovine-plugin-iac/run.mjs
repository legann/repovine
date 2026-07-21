// Standalone integration/conformance check for authors adapting the example IaC plugin.
//
//   cd repovine && npm run build && node examples/repovine-plugin-iac/run.mjs
//
// Analyzes fixtures/sample/ with the plugin wired in exactly as a user would (the plugin resolved
// from the analyzed repo's node_modules, INV-5), runs conformance, Stage-1 infra extraction, and
// Stage-2 graph compose to show runtime resources, entrypoints, and resource edges.

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

// Make `repovine-plugin-iac` resolvable from the analyzed repo's node_modules (what `npm i` would do).
const nm = path.join(target, 'node_modules');
const link = path.join(nm, 'repovine-plugin-iac');
fs.mkdirSync(nm, { recursive: true });
fs.rmSync(link, { recursive: true, force: true });
fs.symlinkSync(pluginRoot, link, 'junction');

const imp = rel => import(pathToFileURL(path.join(distDir, rel)).href);
const { checkIaCPluginConformance } = await import('@repovine/plugin-sdk');
const { collectRepositoryFactsAsync } = await imp('stage1/index.js');
const { composeRepositoryGraph } = await imp('stage2/index.js');
const { getInterpreterEntrypoints } = await imp('stage2/interpreter/entrypoint-store.js');
const { getPipelineLogSink, setPipelineLogSink } = await imp('cli/ui.js');

const plugin = (await import(pathToFileURL(path.join(pluginRoot, 'index.js')).href)).default;
const samplePath = path.join(target, 'edge-stack.json');
const sampleDoc = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
const conformance = checkIaCPluginConformance(plugin, {
  samples: [{ filePath: samplePath, relPath: 'edge-stack.json', doc: sampleDoc }],
});

console.log('=== IaC plugin conformance ===');
for (const check of conformance.checks) {
  console.log(`  ${check.ok ? 'ok ' : 'FAIL'} ${check.name}${!check.ok && check.detail ? ` (${check.detail})` : ''}`);
}
if (!conformance.passed) process.exit(1);

const origLog = console.log;
const origSink = getPipelineLogSink();
console.log = () => {};
setPipelineLogSink('silent');
let snapshot;
let graph;
try {
  snapshot = await collectRepositoryFactsAsync(target, {
    plugins: { defaults: true, add: ['repovine-plugin-iac'], disable: [] },
    maxPackageWorkers: 1,
  });
  graph = composeRepositoryGraph(snapshot);
} finally {
  console.log = origLog;
  setPipelineLogSink(origSink);
}

const edgeModules = (snapshot.infraModules ?? []).filter(m => m.kind === 'edge-stack');
console.log(`\n=== ${edgeModules.length} infra module from the 'edge-stack' plugin (module hash stamped by the engine) ===`);
for (const m of edgeModules) {
  console.log(`\n${m.id}  hash=${m.contentHash}`);
  for (const r of m.resources) {
    console.log(`  ${r.kind.padEnd(6)} ${r.id}  provider=${r.provider}  resourceHash=${r.contentHash}`);
    for (const t of r.triggers ?? []) {
      const targetLabel = t.path ?? t.queueRef ?? t.schedule ?? '';
      console.log(`    trigger: ${t.type} ${t.method ?? ''} ${targetLabel}`.trimEnd());
    }
    for (const ref of r.envRefs ?? []) {
      console.log(`    envRef:  ${ref.varName} -> ${ref.targetLogicalId}`);
    }
  }
}

const demoLabels = new Set(edgeModules.flatMap(m => m.resources.map(r => r.id)));
const runtimeNodeIds = [...(graph.byType.get('runtime-resource') ?? [])]
  .filter(id => demoLabels.has(graph.nodes.get(id)?.label));
const runtimeNodeSet = new Set(runtimeNodeIds);

console.log(`\n=== ${runtimeNodeIds.length} runtime-resource nodes the CORE projected from those infra facts ===`);
for (const id of runtimeNodeIds) {
  const node = graph.nodes.get(id);
  console.log(`  ${id}  kind=${node.data?.kind}  triggers=${node.data?.triggers?.length ?? 0}`);
}

const demoEdges = graph.edges.filter(e =>
  runtimeNodeSet.has(e.from) &&
  runtimeNodeSet.has(e.to) &&
  ['consumes', 'uses_env'].includes(e.kind));
console.log(`\n=== ${demoEdges.length} resource edges projected by the core infra interpreter ===`);
for (const e of demoEdges) {
  console.log(`  ${graph.nodes.get(e.from)?.label} --${e.kind}--> ${graph.nodes.get(e.to)?.label}`);
}

const entrypoints = getInterpreterEntrypoints(graph)
  .filter(e => typeof e.serviceId === 'string' && runtimeNodeSet.has(e.serviceId));
console.log(`\n=== ${entrypoints.length} entrypoints projected from the plugin's trigger facts (no new interpreter) ===`);
for (const e of entrypoints) {
  const method = e.method ? `${e.method} ` : '';
  const targetPath = e.path ?? e.trigger?.queueRef ?? '';
  console.log(`  ${String(e.kind).toUpperCase()} ${method}${targetPath}  service=${e.serviceLabel}`);
}

fs.rmSync(nm, { recursive: true, force: true });
