import * as path from 'node:path';
import * as fs from 'node:fs';
import { collectRepositoryFactsAsync } from './stage1/index.js';
import { composeRepositoryGraph } from './stage2/index.js';
import { graphStats, pathFromRoot, getImpact, domainMembers } from './graph/index.js';
import { repoRoot, cacheDir } from './paths.js';

async function main(): Promise<void> {
  console.log(`\nRepo root: ${repoRoot}\n`);

  // ── Stage 1 ──

  console.log('Stage 1: Collecting repository facts snapshot...\n');
  const snapshot = await collectRepositoryFactsAsync(repoRoot);

  const totalImports = snapshot.modules.reduce((s, m) => s + m.imports.length, 0);
  const resolvedImports = snapshot.modules.reduce(
    (s, m) => s + m.imports.filter(i => i.resolvedModuleId && !i.isExternal).length, 0,
  );
  const externalImports = snapshot.modules.reduce(
    (s, m) => s + m.imports.filter(i => i.isExternal).length, 0,
  );
  const totalExports = snapshot.modules.reduce((s, m) => s + m.exports.length, 0);

  console.log('\n── Stage 1 Summary ──\n');
  console.log(`  Packages:  ${snapshot.packages.length}`);
  console.log(`  Modules:   ${snapshot.modules.length}`);
  console.log(`  Imports:   ${totalImports} (${resolvedImports} resolved, ${externalImports} external)`);
  console.log(`  Exports:   ${totalExports}`);

  // ── Stage 2 ──

  console.log('\nStage 2: Building repovine repository graph...\n');
  const graph = composeRepositoryGraph(snapshot);
  const stats = graphStats(graph);

  console.log('── Stage 2 Summary ──\n');
  console.log('repovine repository graph:');
  console.log(`  Nodes: ${stats.totalNodes}`);
  console.log(`  Edges: ${stats.totalEdges}`);
  console.log('');
  console.log('  By type: ', stats.nodesByType);
  console.log('  By kind: ', stats.edgesByKind);

  // ── Demo queries ──

  console.log('\n── Demo: pathFromRoot for a module ──\n');
  const sampleModule = snapshot.modules.find(m =>
    m.relativeFilePath.toLowerCase().includes('oauth') ||
    m.relativeFilePath.toLowerCase().includes('auth'),
  );
  if (sampleModule) {
    const result = pathFromRoot(graph, sampleModule.id);
    if (result) {
      console.log('  Path:');
      for (const node of result.path) {
        console.log(`    L${node.level}: ${node.label}`);
      }
      console.log(`  Focus: ${result.focus.label} (${result.focus.drillDown.length} children, ${result.focus.links?.length ?? 0} links)`);
    }
  }

  console.log('\n── Demo: impact analysis ──\n');
  if (sampleModule) {
    const impact = getImpact(graph, sampleModule.id);
    console.log(`  Impact of ${sampleModule.id}:`);
    console.log(`    Downstream (who depends on this): ${impact.downstream.length} nodes`);
    console.log(`    Upstream (what this depends on):   ${impact.upstream.length} nodes`);
    if (impact.downstream.length > 0) {
      console.log(`    Sample downstream:`, impact.downstream.slice(0, 5));
    }
  }

  console.log('\n── Demo: domain tagged modules ──\n');
  const domains = graph.byType.get('domain');
  if (domains) {
    for (const domainId of domains) {
      console.log(`  ${domainId}: ${domainMembers(graph, domainId).all.length} members`);
    }
  }

  // ── Write snapshot ──

  fs.mkdirSync(cacheDir, { recursive: true });

  const snapshotPath = path.join(cacheDir, 'repository-facts-snapshot-dump.json');
  const serializable = {
    ...snapshot,
    modules: snapshot.modules.map(m => ({ ...m, filePath: path.relative(repoRoot, m.filePath) })),
  };
  fs.writeFileSync(snapshotPath, JSON.stringify(serializable, null, 2));

  const graphPath = path.join(cacheDir, 'repovine.json');
  const graphJson = {
    stats,
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
  };
  fs.writeFileSync(graphPath, JSON.stringify(graphJson, null, 2));

  console.log(`\nSnapshot: ${path.relative(repoRoot, snapshotPath)}`);
  console.log(`Graph:    ${path.relative(repoRoot, graphPath)}`);
}

await main();
