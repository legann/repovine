import { asPkgRelPath } from '@repovine/plugin-sdk';
import { asHostPath, asRepoRelPath } from '@repovine/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnnotationStore } from '../../src/annotations/store.js';
import { classifyStale } from '../../src/annotations/backlog.js';
import { nodeFreshnessLookup } from '../../src/analysis/architecture/index.js';
import {
  HASHED_NODE_KINDS,
  hashedNodeKind,
  resolveNodeContentHash,
  type HashedNodeKind,
} from '../../src/annotations/content-hash.js';
import {
  FRESHNESS_STATES,
  STALE_REASONS,
  annotationFreshness,
  annotationFreshnessMeta,
  annotationFreshnessProvenance,
  type FreshnessState,
  type AnnotatedFreshnessVerdict,
  type FreshnessVerdict,
  type StaleReason,
} from '../../src/annotations/freshness.js';
import { CURRENT_ANNOTATION_SCHEMA_VERSION } from '../../src/annotations/types.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../../src/config.js';
import { addEdge, addNode, createEmptyGraph } from '../../src/graph/index.js';
import { buildInspectNodeDetail } from '../../src/mcp/lib/inspect-node-core.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';
import type {
  ModuleInfo,
  RepositoryFactsSnapshot,
  RepositoryGraph,
  StoredAnnotation,
} from '../../src/types.js';
import { findFixturesRoot, lawRuntime } from './graph-law-helpers.js';

// One rule for "is this annotation still true", and one resolver for the hash it compares against.
//
// Freshness used to be written six times over five node kinds. The schema gate ran on two of the
// five branches; `inspect_node` compared hashes only, the queue folded in import-baseline drift,
// and `AnnotationStore.isFresh` did a third thing. On this repository that produced 83 modules the
// queue ranked as propagation-stale while `inspect_node` — the call an agent makes before editing —
// answered `fresh: true` about the same node.
//
// Three things are held here. Every hashed node kind resolves a hash through one dispatcher and is
// judged by one rule, including the schema gate. Every state and reason in the vocabulary is
// reachable and carries provenance derived from the verdict. And the two tools that speak about a
// node — `inspect_node` and the annotation queue — never disagree about it.
//
// Scope of the last guard below: it reads source text for the two comparisons the removed copies
// were written with (a stored `contentHash` compared for equality, the schema version compared
// against the current constant). A copy assembled through intermediate variables, or one that
// re-derives freshness from `pass`/`updatedAt`, is outside what text can catch — the agreement
// tests above are what covers those.

const FIXTURE = {
  moduleId: 'mod:app/src/service',
  hubId: 'mod:app/src/contracts',
  staleModuleId: 'mod:app/src/legacy',
  domainId: 'domain:orders',
  resourceId: 'resource:aws-lambda:Worker',
  templateId: 'template:app/template.yaml',
  infraId: 'infra:dockerfile:app/Dockerfile',
} as const;

const HASH = {
  module: 'h-service-1',
  hub: 'h-contracts-2',
  hubBaseline: 'h-contracts-1',
  staleModule: 'h-legacy-2',
  staleAnnotation: 'h-legacy-1',
  template: 'h-template-1',
  infra: 'h-infra-1',
  resource: 'h-resource-1',
} as const;

function makeModule(id: string, relativeFilePath: string, contentHash: string, imports: string[] = []): ModuleInfo {
  return {
    id,
    packageName: 'app',
    absPath: asHostPath(`/repo/${relativeFilePath}`),
    pkgRelPath: asPkgRelPath(relativeFilePath),
    contentHash,
    imports: imports.map(target => ({ specifier: target, resolvedModuleId: target })),
    exports: [{ name: 'handle', kind: 'function', lineRange: { start: 1, end: 3 } }],
  } as unknown as ModuleInfo;
}

function buildFreshnessFixture(): { graph: RepositoryGraph; snapshot: RepositoryFactsSnapshot } {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'root', type: 'root', label: 'root', description: '' });
  addNode(graph, { id: 'pkg:app', type: 'package', label: 'app', description: '' });
  for (const id of [FIXTURE.moduleId, FIXTURE.hubId, FIXTURE.staleModuleId]) {
    addNode(graph, { id, type: 'module', label: id, description: '' });
    addEdge(graph, 'pkg:app', id, 'contains');
  }
  // IaC documents are stored with graph type 'module'; only the id prefix marks them.
  addNode(graph, { id: FIXTURE.infraId, type: 'module', label: 'Dockerfile', description: '' });
  addNode(graph, { id: FIXTURE.domainId, type: 'domain', label: 'orders', description: '' });
  addNode(graph, { id: FIXTURE.resourceId, type: 'runtime-resource', label: 'Worker', description: 'Lambda' });
  addNode(graph, { id: FIXTURE.templateId, type: 'template', label: 'template.yaml', description: '' });
  addEdge(graph, FIXTURE.moduleId, FIXTURE.hubId, 'imports');
  addEdge(graph, FIXTURE.moduleId, FIXTURE.domainId, 'tagged', { tagSource: 'path' });
  addEdge(graph, FIXTURE.infraId, FIXTURE.resourceId, 'contains');

  const snapshot: RepositoryFactsSnapshot = {
    repoRoot: '/repo',
    timestamp: '2026-01-01T00:00:00.000Z',
    packages: [],
    modules: [
      makeModule(FIXTURE.moduleId, 'src/service.ts', HASH.module, [FIXTURE.hubId]),
      makeModule(FIXTURE.hubId, 'src/contracts.ts', HASH.hub),
      makeModule(FIXTURE.staleModuleId, 'src/legacy.ts', HASH.staleModule),
    ],
    templates: [{ id: FIXTURE.templateId, relPath: 'app/template.yaml', contentHash: HASH.template }],
    infraModules: [{
      id: FIXTURE.infraId,
      kind: 'dockerfile',
      absPath: asHostPath('/repo/app/Dockerfile'),
      repoRelPath: asRepoRelPath('app/Dockerfile'),
      contentHash: HASH.infra,
      resources: [{
        id: 'Worker',
        kind: 'lambda',
        provider: 'aws',
        identity: { namespace: 'aws-lambda', localKey: 'Worker' },
        contentHash: HASH.resource,
        attributes: {},
      }],
    }],
  } as unknown as RepositoryFactsSnapshot;
  return { graph, snapshot };
}

function annotation(nodeId: string, contentHash: string, extra: Partial<StoredAnnotation> = {}): StoredAnnotation {
  return {
    nodeId,
    nodeType: 'module',
    contentHash,
    pass: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    annotation: { summary: `Note for ${nodeId}.` },
    schemaVersion: CURRENT_ANNOTATION_SCHEMA_VERSION,
    ...extra,
  };
}

/** The hash each kind currently resolves to, and the node that carries it. */
const NODE_BY_KIND: Record<HashedNodeKind, { id: string; hash: string }> = {
  module: { id: FIXTURE.moduleId, hash: HASH.module },
  infra: { id: FIXTURE.infraId, hash: HASH.infra },
  'runtime-resource': { id: FIXTURE.resourceId, hash: HASH.resource },
  template: { id: FIXTURE.templateId, hash: HASH.template },
  // A domain hash is a roll-up over its members, so it is read from the resolver, not asserted.
  domain: { id: FIXTURE.domainId, hash: '' },
};

let annotationsDir: string;

/**
 * Fixture runtime with a real annotation store.
 *
 * `mod:app/src/service` is content-fresh with a stale import baseline on `mod:app/src/contracts`,
 * whose own content moved and whose keyExports no longer match its exports — the contract-hub drift
 * that makes the importer propagation-stale without any entrypoint in the fixture.
 */
function freshnessRuntime(): { runtime: McpToolRuntime; annotations: AnnotationStore } {
  const { graph, snapshot } = buildFreshnessFixture();
  const base = lawRuntime(graph, snapshot);
  const annotations = AnnotationStore.createSync(annotationsDir);
  annotations.set(FIXTURE.moduleId, annotation(FIXTURE.moduleId, HASH.module, {
    importBaseline: { [FIXTURE.hubId]: HASH.hubBaseline },
  }));
  annotations.set(FIXTURE.hubId, annotation(FIXTURE.hubId, HASH.hubBaseline, {
    annotation: { summary: 'Contract hub.', keyExports: { removedName: 'gone from the module' } },
  }));
  annotations.set(FIXTURE.staleModuleId, annotation(FIXTURE.staleModuleId, HASH.staleAnnotation));
  annotations.set(FIXTURE.templateId, annotation(FIXTURE.templateId, HASH.template, { nodeType: 'template' }));
  annotations.set(FIXTURE.infraId, annotation(FIXTURE.infraId, HASH.infra));
  annotations.set(FIXTURE.resourceId, annotation(FIXTURE.resourceId, HASH.resource, { nodeType: 'runtime-resource' }));
  const domainHash = resolveNodeContentHash(FIXTURE.domainId, {
    graph,
    snapshot,
    propagation: DEFAULT_PROPAGATION_CONFIG,
  });
  annotations.set(FIXTURE.domainId, annotation(FIXTURE.domainId, domainHash ?? 'unknown', { nodeType: 'domain' }));
  // Persist now so the debounced save timer cannot outlive the test worker.
  annotations.flush();
  const runtime: McpToolRuntime = {
    ...base,
    getState: () => ({ ...base.getState(), annotations }),
  };
  return { runtime, annotations };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function repoRoot(): string {
  return path.resolve(findFixturesRoot(), '..', '..');
}

type InspectedMeta = { fresh?: boolean; staleReason?: string; provenance?: { basis: string; method: string } };

async function inspectMeta(runtime: McpToolRuntime, nodeId: string): Promise<InspectedMeta | undefined> {
  const view = await buildInspectNodeDetail(runtime, { nodeId }) as { annotationMeta?: InspectedMeta };
  return view.annotationMeta;
}

describe('core-laws annotation freshness (one rule over every node kind)', () => {
  beforeAll(() => {
    annotationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-freshness-law-'));
  });

  afterAll(() => {
    fs.rmSync(annotationsDir, { recursive: true, force: true });
  });

  it('resolves a current hash for every kind in HASHED_NODE_KINDS, so no case below is vacuous', () => {
    const { graph, snapshot } = buildFreshnessFixture();
    for (const kind of HASHED_NODE_KINDS) {
      const node = NODE_BY_KIND[kind];
      expect(hashedNodeKind(graph, node.id)).toBe(kind);
      const resolved = resolveNodeContentHash(node.id, { graph, snapshot, propagation: DEFAULT_PROPAGATION_CONFIG });
      expect(typeof resolved).toBe('string');
      if (node.hash) expect(resolved).toBe(node.hash);
    }
    // A kind added to the list without a fixture node here would be skipped in silence.
    expect(Object.keys(NODE_BY_KIND).sort()).toEqual([...HASHED_NODE_KINDS].sort());
    // Kinds that carry no hash answer `undefined` rather than a value nothing produced.
    expect(hashedNodeKind(graph, 'pkg:app')).toBeUndefined();
    expect(resolveNodeContentHash('pkg:app', {
      graph,
      snapshot,
      propagation: DEFAULT_PROPAGATION_CONFIG,
    })).toBeUndefined();
  });

  it('judges every hashed kind by the same rule, schema gate included', () => {
    const { graph, snapshot } = buildFreshnessFixture();
    for (const kind of HASHED_NODE_KINDS) {
      const { id } = NODE_BY_KIND[kind];
      const currentHash = resolveNodeContentHash(id, { graph, snapshot, propagation: DEFAULT_PROPAGATION_CONFIG })!;
      expect(annotationFreshness({ annotation: annotation(id, currentHash), currentHash }))
        .toEqual({ state: 'fresh' });
      expect(annotationFreshness({ annotation: annotation(id, `${currentHash}-moved`), currentHash }))
        .toEqual({ state: 'stale', reason: 'content' });
      // The gate that used to run on two branches out of five.
      expect(annotationFreshness({
        annotation: annotation(id, currentHash, { schemaVersion: CURRENT_ANNOTATION_SCHEMA_VERSION - 1 }),
        currentHash,
      })).toEqual({ state: 'stale', reason: 'schema' });
      // Written with no hash to compare against, on a node that does hash.
      expect(annotationFreshness({ annotation: annotation(id, 'unknown'), currentHash }))
        .toEqual({ state: 'stale', reason: 'no-baseline' });
    }
  });

  it('reaches every state and every reason in the vocabulary, and publishes each one', () => {
    const currentHash = 'h-1';
    const byState: Record<FreshnessState, FreshnessVerdict> = {
      fresh: annotationFreshness({ annotation: annotation('mod:a', currentHash), currentHash }),
      stale: annotationFreshness({ annotation: annotation('mod:a', 'h-0'), currentHash }),
      'not-comparable': annotationFreshness({ annotation: annotation('mod:a', 'unknown'), currentHash: undefined }),
      unannotated: annotationFreshness({ annotation: undefined, currentHash }),
    };
    for (const state of FRESHNESS_STATES) expect(byState[state].state).toBe(state);
    expect(Object.keys(byState).sort()).toEqual([...FRESHNESS_STATES].sort());

    const byReason: Record<StaleReason, AnnotatedFreshnessVerdict> = {
      content: annotationFreshness({ annotation: annotation('mod:a', 'h-0'), currentHash }),
      schema: annotationFreshness({
        annotation: annotation('mod:a', currentHash, { schemaVersion: CURRENT_ANNOTATION_SCHEMA_VERSION - 1 }),
        currentHash,
      }),
      propagation: annotationFreshness({
        annotation: annotation('mod:a', currentHash),
        currentHash,
        propagationStale: true,
      }),
      'no-baseline': annotationFreshness({ annotation: annotation('mod:a', 'unknown'), currentHash }),
    };
    for (const reason of STALE_REASONS) {
      const verdict = byReason[reason];
      expect(verdict).toEqual({ state: 'stale', reason });
      // Every reason is work the queue can rank, and every one is published with its name.
      expect(classifyStale(verdict)?.status).toBe('stale');
      expect(annotationFreshnessMeta(verdict)).toMatchObject({ fresh: false, staleReason: reason });
    }
    expect(Object.keys(byReason).sort()).toEqual([...STALE_REASONS].sort());

    // The two states that are not work: one confirmed, one with nothing to confirm against.
    expect(classifyStale(byState.fresh)).toBeNull();
    expect(classifyStale(byState['not-comparable'])).toBeNull();
    expect(classifyStale(byState.unannotated)).toEqual({ status: 'unannotated' });
    const notComparable = annotationFreshness({ annotation: annotation('mod:a', 'unknown'), currentHash: undefined });
    expect(annotationFreshnessMeta(notComparable).fresh).toBeUndefined();
  });

  it('derives provenance from the verdict, so a reason cannot claim a comparison it did not make', () => {
    const currentHash = 'h-1';
    const propagation = annotationFreshness({
      annotation: annotation('mod:a', currentHash),
      currentHash,
      propagationStale: true,
    });
    const noBaseline = annotationFreshness({ annotation: annotation('mod:a', 'unknown'), currentHash });
    // Propagation is decided from stored import baselines, not from this node's own hash.
    expect(annotationFreshnessProvenance(propagation)).toEqual({ basis: 'computed', method: 'import-baseline' });
    // Nothing was compared: the stored side of the comparison is the `unknown` sentinel.
    expect(annotationFreshnessProvenance(noBaseline)).toEqual({ basis: 'absent', method: 'not-comparable' });
    expect(annotationFreshnessProvenance(
      annotationFreshness({ annotation: annotation('mod:a', 'h-0'), currentHash }),
    )).toEqual({ basis: 'computed', method: 'content-hash' });
  });

  it('answers a propagation-stale node the same way in inspect_node and in the queue', async () => {
    const { runtime, annotations } = freshnessRuntime();
    const { graph, snapshot } = runtime.getState();
    const queue = annotations.getQueue(graph, snapshot, { limit: 50, propagation: DEFAULT_PROPAGATION_CONFIG });
    const propagationStale = queue.filter(item => item.staleKind === 'propagation');
    // The defect this law exists for is only demonstrated when the fixture actually has one.
    expect(propagationStale.map(item => item.nodeId)).toEqual([FIXTURE.moduleId]);

    const meta = await inspectMeta(runtime, FIXTURE.moduleId);
    expect(meta).toMatchObject({
      fresh: false,
      staleReason: 'propagation',
      provenance: { basis: 'computed', method: 'import-baseline' },
    });
  });

  it('answers the same verdict in architecture detail as in inspect_node', async () => {
    const { runtime, annotations } = freshnessRuntime();
    const { graph, modulesById, snapshot } = runtime.getState();
    const freshnessOf = nodeFreshnessLookup({
      graph,
      modulesById,
      annotations,
      snapshot,
      propagation: DEFAULT_PROPAGATION_CONFIG,
      entrypoints: [],
    });
    for (const nodeId of Object.keys(annotations.getAll())) {
      const verdict = freshnessOf(nodeId);
      expect(verdict).toBeDefined();
      const meta = await inspectMeta(runtime, nodeId);
      expect(annotationFreshnessMeta(verdict!)).toEqual(meta && {
        ...(meta.fresh === undefined ? {} : { fresh: meta.fresh }),
        ...(meta.staleReason === undefined ? {} : { staleReason: meta.staleReason }),
        provenance: meta.provenance,
      });
    }
  });

  it('keeps inspect_node and the queue in agreement about every annotated node of the fixture', async () => {
    const { runtime, annotations } = freshnessRuntime();
    const { graph, snapshot } = runtime.getState();
    const queue = annotations.getQueue(graph, snapshot, { limit: 100, propagation: DEFAULT_PROPAGATION_CONFIG });
    const staleById = new Map(queue.filter(item => item.status === 'stale').map(item => [item.nodeId, item.staleKind]));
    // Both sides of the agreement are exercised: some nodes are stale, some are not.
    expect(staleById.size).toBeGreaterThan(0);

    let freshSeen = 0;
    for (const nodeId of Object.keys(annotations.getAll())) {
      const meta = await inspectMeta(runtime, nodeId);
      expect(meta).toBeDefined();
      const queued = staleById.get(nodeId);
      if (queued === undefined) {
        expect(meta!.fresh).toBe(true);
        freshSeen++;
        continue;
      }
      expect(meta!.fresh).toBe(false);
      const expectedKind = meta!.staleReason === 'propagation' ? 'propagation' : 'content';
      expect(queued).toBe(expectedKind);
    }
    expect(freshSeen).toBeGreaterThan(0);
  });

  it('resolves the current hash through one dispatcher: no site picks a per-kind resolver itself', () => {
    const dispatcher = path.join('src', 'annotations', 'content-hash.ts');
    const resolverHome = path.join('src', 'annotations', 'service-resource-hash.ts');
    // The per-kind resolvers a second dispatcher would have to call to answer for all five kinds.
    const perKindResolver = /\b(resolveModuleContentHash|resolveTemplateContentHash|resolveDomainContentHash|resolveServiceResourceContentHash|getResourceContentHashForServiceId)\b/;

    const offenders: string[] = [];
    const root = repoRoot();
    for (const file of sourceFiles(path.join(root, 'src'))) {
      const rel = path.relative(root, file);
      if (rel === dispatcher || rel === resolverHome) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        if (!perKindResolver.test(line)) return;
        offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('declares the freshness rule once: no other site compares a stored hash or the schema version', () => {
    const rule = path.join('src', 'annotations', 'freshness.ts');
    // A stored annotation hash compared for equality — the form every removed copy was written in.
    const storedHashCompare = /\b\w*(?:ann|annotation|note)\w*\.contentHash\s*[!=]==|[!=]==\s*\w*(?:ann|annotation|note)\w*\.contentHash/i;
    // The schema gate: only the rule decides what an outdated schema version means.
    const schemaGate = /[<>]=?\s*CURRENT_ANNOTATION_SCHEMA_VERSION|CURRENT_ANNOTATION_SCHEMA_VERSION\s*[<>]/;

    const offenders: string[] = [];
    const root = repoRoot();
    for (const file of sourceFiles(path.join(root, 'src'))) {
      const rel = path.relative(root, file);
      if (rel === rule) continue;
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        // Comment lines are prose: describing the comparison is not making it.
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        if (storedHashCompare.test(line) || schemaGate.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
