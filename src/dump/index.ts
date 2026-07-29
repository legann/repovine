/**
 * Serialize the repository graph to YAML and/or JSON.
 *
 * Usage:
 *   npx tsx repovine/src/dump/index.ts              # writes .cache/graph.yaml + .cache/graph.json
 *   npx tsx repovine/src/dump/index.ts --yaml       # only YAML
 *   npx tsx repovine/src/dump/index.ts --json       # only JSON
 */

import { compareCodeUnits } from '../platform/ordering.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import yaml from 'js-yaml';
import { collectRepositoryFactsAsync } from '../stage1/index.js';
import { loadConfig } from '../config.js';
import { composeRepositoryGraph, getComposedRefusals } from '../stage2/index.js';
import { getGraphExtensions } from '../graph/build-artifact.js';
import type { ExtensionRecord } from '@repovine/plugin-sdk';
import type { Refusal } from '../response/refusal.js';
import { domainMembers, getChildren, graphStats, infraTargetIds, nodesOfType, taggedDomains } from '../graph/index.js';
import type { RepositoryGraph, RepositoryFactsSnapshot, FieldInfo, MemberInfo, RouteInfo, ConditionalRender } from '../types.js';
import { repoRoot, cacheDir } from '../paths.js';

interface DumpModule {
  id: string;
  label: string;
  file: string;
  domains: string[];
  imports: string[];
  exports: DumpExport[];
  envVars?: string[];
  routes?: RouteInfo[];
  conditionalRenders?: ConditionalRender[];
}

interface DumpExport {
  name: string;
  kind: string;
  signature?: string;
  typeValue?: string;
  fields?: FieldInfo[];
  implementsInterfaces?: string[];
  calls?: string[];
  privateMembers?: MemberInfo[];
  lineRange?: { start: number; end: number };
}

interface DumpPackage {
  id: string;
  name: string;
  modules: DumpModule[];
}

interface DumpGraph {
  meta: {
    generatedAt: string;
    repoRoot: string;
    nodes: number;
    edges: number;
  };
  domains: Record<string, string[]>;
  services: Array<{ id: string; label: string; handler?: string }>;
  packages: DumpPackage[];
  /**
   * Namespaced extensions, with owner, subject and provenance. Serialized beside the graph and never
   * inside it: the dump publishes what a plugin contributed without claiming the graph interprets it.
   * Omitted when the build produced none.
   */
  extensions?: ExtensionRecord[];
  /** What the build refused. Omitted when it took every record. */
  refusals?: Refusal[];
}

function buildDump(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): DumpGraph {
  const stats = graphStats(graph);
  const extensions = getGraphExtensions(graph);
  const refusals = [...(snapshot.buildRefusals ?? []), ...getComposedRefusals(graph)];

  // Domains → tagged module ids
  const domains: Record<string, string[]> = {};
  for (const domainId of nodesOfType(graph, 'domain')) {
    const node = graph.nodes.get(domainId);
    if (!node) continue;
    domains[node.label] = [...new Set(domainMembers(graph, domainId).all)];
  }

  // Runtime resources exposed through the legacy dump `services` projection.
  const services: DumpGraph['services'] = [];
  for (const svcId of nodesOfType(graph, 'runtime-resource')) {
    const svc = graph.nodes.get(svcId);
    if (!svc) continue;
    services.push({
      id: svcId,
      label: svc.label,
      handler: infraTargetIds(graph, svcId)[0],
    });
  }

  // Packages → modules → exports
  const packages: DumpPackage[] = [];
  for (const pkgId of nodesOfType(graph, 'package')) {
    const pkgNode = graph.nodes.get(pkgId);
    if (!pkgNode) continue;
    const moduleNodes = getChildren(graph, pkgId);

    const modules: DumpModule[] = [];
    for (const modNode of moduleNodes) {
      if (modNode.type !== 'module') continue;

      // file path from node data
      const filePath = (modNode.data?.filePath as string) ?? '';
      const relFile = filePath ? path.relative(repoRoot, filePath) : modNode.id;

      // domains this module is tagged with
      const modDomains = taggedDomains(graph, modNode.id).labels;
      const outEdges = graph.outEdges.get(modNode.id) ?? [];

      // imports (other modules)
      const imports: string[] = [];
      for (const e of outEdges) {
        if (e.kind === 'imports') imports.push(e.to);
      }

      // exports (export-symbol nodes)
      const exportSymbolChildren = getChildren(graph, modNode.id);
      const exports: DumpExport[] = exportSymbolChildren.map(cap => {
        const entry: DumpExport = {
          name: cap.label,
          kind: cap.type === 'export-symbol' && cap.data ? (cap.data.symbolKind ?? 'unknown') : 'unknown',
        };
        if (cap.type === 'export-symbol' && cap.data) {
          const d = cap.data;
          if (d.signature) entry.signature = d.signature;
          if (d.typeValue) entry.typeValue = d.typeValue;
          if (d.fields) entry.fields = d.fields;
          if (d.implementsInterfaces) entry.implementsInterfaces = d.implementsInterfaces;
          if (d.calls) entry.calls = d.calls;
          if (d.privateMembers) entry.privateMembers = d.privateMembers;
          if (d.lineRange) entry.lineRange = d.lineRange;
        }
        return entry;
      });

      // semantic hints from snapshot
      const snapshotMod = snapshot.modules.find(m => m.id === modNode.id);
      const hints = snapshotMod?.semanticHints;

      const mod: DumpModule = {
        id: modNode.id,
        label: modNode.label,
        file: relFile,
        domains: modDomains,
        imports,
        exports,
      };
      if (hints?.envVars?.length) mod.envVars = hints.envVars;
      if (hints?.routes?.length) mod.routes = hints.routes;
      if (hints?.conditionalRenders?.length) mod.conditionalRenders = hints.conditionalRenders;

      modules.push(mod);
    }

    // Sort modules by file path
    modules.sort((a, b) => compareCodeUnits(a.file, b.file));

    packages.push({
      id: pkgId,
      name: pkgNode.label,
      modules,
    });
  }

  // Sort packages by name
  packages.sort((a, b) => compareCodeUnits(a.name, b.name));

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      repoRoot,
      nodes: stats.totalNodes,
      edges: stats.totalEdges,
    },
    domains,
    services,
    packages,
    ...(extensions.records.length > 0 ? { extensions: extensions.records } : {}),
    ...(refusals.length > 0 ? { refusals } : {}),
  };
}

// ── Main ──

const args = process.argv.slice(2);
const wantYaml = args.length === 0 || args.includes('--yaml');
const wantJson = args.length === 0 || args.includes('--json');

console.log(`Building repovine context for: ${repoRoot}`);

console.log('Stage 1: Repository facts snapshot...');
// The workspace config names this build's plugins; dump and the embedded API load the same
// set the MCP server and `repovine build` do.
const snapshot = await collectRepositoryFactsAsync(repoRoot, { plugins: loadConfig(repoRoot).plugins });

console.log('Stage 2: repovine repository graph...');
const graph = composeRepositoryGraph(snapshot);

console.log('Serializing...\n');
const dump = buildDump(graph, snapshot);

fs.mkdirSync(cacheDir, { recursive: true });

if (wantYaml) {
  const yamlPath = path.join(cacheDir, 'graph.yaml');
  const yamlStr = yaml.dump(dump, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  fs.writeFileSync(yamlPath, yamlStr);
  const sizeKb = (Buffer.byteLength(yamlStr) / 1024).toFixed(1);
  console.log(`  YAML: ${path.relative(repoRoot, yamlPath)} (${sizeKb} KB)`);
}

if (wantJson) {
  const jsonPath = path.join(cacheDir, 'graph.json');
  const jsonStr = JSON.stringify(dump, null, 2);
  fs.writeFileSync(jsonPath, jsonStr);
  const sizeKb = (Buffer.byteLength(jsonStr) / 1024).toFixed(1);
  console.log(`  JSON: ${path.relative(repoRoot, jsonPath)} (${sizeKb} KB)`);
}

console.log(`\n  ${dump.packages.length} packages, ${dump.packages.reduce((s, p) => s + p.modules.length, 0)} modules, ${dump.meta.nodes} nodes`);
console.log('');
