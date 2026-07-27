import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnnotationStore } from '../../src/annotations/store.js';
import {
  ARCHITECTURE_SCOPE_KINDS,
  architectureCanScope,
  scopedGraphIds,
} from '../../src/analysis/architecture/scope.js';
import { addEdge, addNode, createEmptyGraph } from '../../src/graph/index.js';
import { NODE_ID_PREFIXES, SCOPE_PREFIXES } from '../../src/graph/node-ids.js';
import {
  RUNTIME_TOPOLOGY_SCOPE_KINDS,
  projectRuntimeTopology,
  topologyCanScope,
} from '../../src/mcp/lib/topology.js';
import { resolveScope } from '../../src/mcp/scope/resolve.js';
import { handleAnalyzeArchitecture } from '../../src/mcp/tools/analyze-architecture.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';
import { SCOPE_KINDS, type ResolvedScope, type ScopeKind } from '../../src/scope/resolved.js';
import type { RepositoryGraph } from '../../src/types.js';
import { findFixturesRoot, lawRuntime } from './graph-law-helpers.js';

// One reading of a scope argument, and an answer for every kind it can resolve to.
//
// A caller's scope string used to be parsed three times: the rich ladder in resolveScope, a second
// parser in the architecture analysis that knew three of the ten kinds, and a third in the runtime
// topology projection. The two re-parsers returned empty sets for every kind they did not know, and
// their callers published that as a result — `analyze_architecture` on a module scope reported "no
// findings … with the current detectors and thresholds" for a scope it had never expanded, and
// `trace_flow` read a `template:` scope as a domain name.
//
// Two things are held here. Every downstream consumer answers for every kind in SCOPE_KINDS, either
// by inspecting it or by refusing it by name; and the vocabulary of node-id prefixes is declared
// once, so a second reader cannot answer "is this a node id" from a different list.

const FIXTURE = {
  packageId: 'pkg:app',
  moduleId: 'mod:app/src/service',
  exportId: 'export:app/src/service/handle',
  domainId: 'domain:orders',
  resourceId: 'resource:aws-lambda:Worker',
  otherResourceId: 'resource:aws-sqs:WorkQueue',
  templateId: 'template:app/template.yaml',
  infraId: 'infra:dockerfile:app/Dockerfile',
};

function buildScopeFixtureGraph(): RepositoryGraph {
  const g = createEmptyGraph();
  addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
  addNode(g, { id: FIXTURE.packageId, type: 'package', label: 'app', description: '' });
  addNode(g, { id: FIXTURE.moduleId, type: 'module', label: 'service', description: '' });
  addNode(g, { id: FIXTURE.exportId, type: 'export-symbol', label: 'handle', description: '' });
  addNode(g, { id: FIXTURE.domainId, type: 'domain', label: 'orders', description: '' });
  addNode(g, { id: FIXTURE.resourceId, type: 'runtime-resource', label: 'Worker', description: 'Lambda' });
  addNode(g, { id: FIXTURE.otherResourceId, type: 'runtime-resource', label: 'WorkQueue', description: 'Queue' });
  addNode(g, { id: FIXTURE.templateId, type: 'template', label: 'template.yaml', description: '' });
  // IaC documents are stored with graph type 'module'; only the id prefix marks them.
  addNode(g, { id: FIXTURE.infraId, type: 'module', label: 'Dockerfile', description: '' });
  addEdge(g, 'root', FIXTURE.packageId, 'contains');
  addEdge(g, FIXTURE.packageId, FIXTURE.moduleId, 'contains');
  addEdge(g, FIXTURE.moduleId, FIXTURE.exportId, 'contains');
  addEdge(g, FIXTURE.moduleId, FIXTURE.domainId, 'tagged');
  addEdge(g, FIXTURE.resourceId, FIXTURE.moduleId, 'infra');
  return g;
}

/** Repository root, derived from the fixtures helper rather than the working directory. */
function repoRoot(): string {
  return path.resolve(findFixturesRoot(), '..', '..');
}

let annotationsDir: string;

function scopeFixtureRuntime(): McpToolRuntime {
  const base = lawRuntime(buildScopeFixtureGraph());
  const annotations = AnnotationStore.createSync(annotationsDir);
  return { ...base, getState: () => ({ ...base.getState(), annotations }) };
}

/** The scope argument that resolves to each kind on the fixture graph above. */
const SCOPE_ARG_BY_KIND: Record<ScopeKind, string> = {
  all: 'all',
  domain: FIXTURE.domainId,
  package: FIXTURE.packageId,
  module: FIXTURE.moduleId,
  'export-symbol': FIXTURE.exportId,
  'runtime-resource': FIXTURE.resourceId,
  template: FIXTURE.templateId,
  infra: FIXTURE.infraId,
  query: 'query:service',
  unknown: 'mod:absent/module',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('core-laws scope resolution (one reading of a scope argument)', () => {
  beforeAll(() => {
    annotationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-scope-law-'));
  });

  afterAll(() => {
    fs.rmSync(annotationsDir, { recursive: true, force: true });
  });

  it('resolves every kind in SCOPE_KINDS on the fixture, so no case below is vacuous', () => {
    const runtime = scopeFixtureRuntime();
    for (const kind of SCOPE_KINDS) {
      expect(resolveScope(runtime, SCOPE_ARG_BY_KIND[kind]).kind).toBe(kind);
    }
    // A kind added to the union without an argument here would be skipped in silence.
    expect(Object.keys(SCOPE_ARG_BY_KIND).sort()).toEqual([...SCOPE_KINDS].sort());
  });

  // ── the prefix vocabulary ──

  it('declares node-id prefixes once, in src/graph/node-ids.ts', () => {
    // The pattern is built from the canonical list: a prefix added there widens this guard with it.
    const alt = SCOPE_PREFIXES.join('|');
    // A regexp literal alternating two or more prefixes before a colon — the form both removed
    // declarations took (`/^(mod|export|pkg|resource|infra):/`).
    const alternation = new RegExp(`\\((?:${alt})(?:\\|(?:${alt}))+\\)\\s*:`);
    // A list literal of two or more prefixed strings — the same vocabulary spelled as data.
    const listed = new RegExp(`(['"\`])(?:${alt}):\\1\\s*,\\s*(['"\`])(?:${alt}):\\2`);
    const canonical = path.join('src', 'graph', 'node-ids.ts');

    const offenders: string[] = [];
    const root = repoRoot();
    for (const file of sourceFiles(path.join(root, 'src'))) {
      const rel = path.relative(root, file);
      if (rel === canonical) continue;
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        // Comment lines are prose: naming `mod:` and `export:` in a sentence declares nothing.
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        if (alternation.test(line) || listed.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }

    // Scope of this guard: a declaration of the vocabulary. A single `startsWith('pkg:')` while
    // walking one edge kind is a use of one prefix, not a second list, and is not flagged here.
    expect(offenders).toEqual([]);
  });

  it('resolves every declared prefix rather than falling through to a text query', () => {
    const runtime = scopeFixtureRuntime();
    for (const prefix of NODE_ID_PREFIXES) {
      // The prefix is recognised and its target is missing — not "this looks like search text".
      expect(resolveScope(runtime, `${prefix}:absent-target`).kind).toBe('unknown');
    }
    expect(resolveScope(runtime, 'absent-target').kind).toBe('query');
  });

  // ── architecture analysis ──

  it('refuses a raw scope string where a resolved scope is required', () => {
    const graph = buildScopeFixtureGraph();
    expect(() => scopedGraphIds(
      graph,
      new Map(),
      // @ts-expect-error a scope string is exactly what this signature exists to refuse
      'all',
    )).toThrow(/ResolvedScope/);
  });

  it('expands a scope kind it inspects and refuses every other one, in step with its own predicate', () => {
    const runtime = scopeFixtureRuntime();
    const graph = runtime.getState().graph;
    for (const kind of SCOPE_KINDS) {
      const scope = resolveScope(runtime, SCOPE_ARG_BY_KIND[kind]);
      const scoped = scopedGraphIds(graph, new Map(), scope);
      expect(scoped.kind === 'unsupported').toBe(!architectureCanScope(kind));
      if (scoped.kind === 'unsupported') expect(scoped.unsupportedKind).toBe(kind);
    }
    for (const kind of ARCHITECTURE_SCOPE_KINDS) expect(SCOPE_KINDS).toContain(kind);
  });

  it('never reports a scope it cannot inspect as having no findings', async () => {
    const runtime = scopeFixtureRuntime();
    for (const kind of SCOPE_KINDS) {
      const response = await handleAnalyzeArchitecture(runtime, { scope: SCOPE_ARG_BY_KIND[kind] });
      const result = response.result as {
        totalFindings?: unknown;
        error?: unknown;
        emptyDiagnostic?: { reason?: string };
      };
      if (architectureCanScope(kind)) continue;
      // The defect this law exists for: an uninspected scope answering in the vocabulary of an
      // inspected one. `no_architecture_findings` names detectors and thresholds that never ran.
      expect(result.emptyDiagnostic?.reason).not.toBe('no_architecture_findings');
      expect(typeof result.error).toBe('string');
      // No finding counts at all: `totalFindings: 0` is what read as a clean bill of health.
      expect(result.totalFindings).toBeUndefined();
      expect(result.emptyDiagnostic?.reason).toBe(
        kind === 'unknown' ? 'scope_unresolved' : 'scope_kind_not_analyzable',
      );
    }
  });

  it('discloses what a single-node scope cannot reach, and still reports it as inspected', async () => {
    const runtime = scopeFixtureRuntime();
    for (const kind of ['module', 'runtime-resource'] as const) {
      const response = await handleAnalyzeArchitecture(runtime, { scope: SCOPE_ARG_BY_KIND[kind] });
      const result = response.result as { totalFindings?: unknown; emptyDiagnostic?: { reason?: string } };
      // Inspected: the node set was expanded and the detectors ran over it.
      expect(typeof result.totalFindings).toBe('number');
      expect(result.emptyDiagnostic?.reason).toBe('no_architecture_findings');
      // And the coverage the granularity rules out is stated whether or not anything was found.
      expect(response.gaps.some(gap => gap.includes('one node'))).toBe(true);
    }
  });

  // ── runtime topology ──

  it('narrows runtime topology to nothing for a kind it cannot scope, not to everything', () => {
    const runtime = scopeFixtureRuntime();
    const everything = projectRuntimeTopology(runtime, {}) as { services?: unknown[] };
    // Without services in the fixture the checks below would pass on an empty projection.
    expect(everything.services?.length).toBe(2);

    for (const kind of SCOPE_KINDS) {
      const scope = resolveScope(runtime, SCOPE_ARG_BY_KIND[kind]);
      const projected = projectRuntimeTopology(runtime, { scope }) as {
        services?: unknown[];
        resources?: unknown[];
        dataFlows?: unknown[];
      };
      if (topologyCanScope(kind)) continue;
      expect(projected.services).toEqual([]);
      expect(projected.resources).toBeUndefined();
      expect(projected.dataFlows).toBeUndefined();
    }
    for (const kind of RUNTIME_TOPOLOGY_SCOPE_KINDS) expect(SCOPE_KINDS).toContain(kind);
  });

  it('reaches the infra hull from a module scope and the resource itself from a resource scope', () => {
    const runtime = scopeFixtureRuntime();
    const fromModule = projectRuntimeTopology(runtime, {
      scope: resolveScope(runtime, FIXTURE.moduleId),
    }) as { services?: Array<{ id: string }> };
    expect(fromModule.services?.map(s => s.id)).toEqual([FIXTURE.resourceId]);

    const fromResource = projectRuntimeTopology(runtime, {
      scope: resolveScope(runtime, FIXTURE.resourceId),
    }) as { services?: Array<{ id: string }> };
    expect(fromResource.services?.map(s => s.id)).toEqual([FIXTURE.resourceId]);
  });

  it('scopes runtime topology by a query rather than answering for the whole graph', () => {
    const runtime = scopeFixtureRuntime();
    const projected = projectRuntimeTopology(runtime, {
      scope: resolveScope(runtime, 'query:worker'),
    }) as { services?: Array<{ id: string }> };
    expect(projected.services?.map(s => s.id)).toEqual([FIXTURE.resourceId]);
  });

  it('keeps ResolvedScope out of the MCP layer so an analysis outside it can take one', () => {
    // src/analysis holds the detectors and imports nothing from src/mcp; the type it needs for a
    // scope argument therefore cannot live under src/mcp either.
    const scopeModule = path.join(repoRoot(), 'src', 'scope', 'resolved.ts');
    expect(fs.existsSync(scopeModule)).toBe(true);

    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(repoRoot(), 'src', 'analysis'))) {
      const text = fs.readFileSync(file, 'utf8');
      if (/from '(\.\.\/)+mcp\//.test(text)) offenders.push(path.relative(repoRoot(), file));
    }
    expect(offenders).toEqual([]);
  });
});

// The type is what a consumer takes; this only pins that the module exports it as one.
const typedScope: ResolvedScope = { raw: 'all', resolvedScope: 'all', kind: 'all' };
void typedScope;
