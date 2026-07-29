import { asRepoRelPath } from '@repovine/plugin-sdk';
import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { AnnotationStore } from '../../src/annotations/store.js';
import {
  BACKLOG_PHASES,
  backlogKindCoverages,
  countBacklogPhases,
  needsWorkOf,
  rollUpCoverage,
  type KindCoverage,
  type QueuePhase,
} from '../../src/annotations/backlog.js';
import { buildOnboardingState } from '../../src/mcp/onboarding-state.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../../src/config.js';
import type {
  GraphEdge,
  GraphNode,
  InfraModuleInfo,
  ModuleInfo,
  RepositoryFactsSnapshot,
  RepositoryGraph,
  StoredAnnotation,
} from '../../src/types.js';
import type { RepovineState } from '../../src/mcp/types.js';
import { findRepovineRoot } from './core-schema.js';

// The queue answers "what next" and coverage answers "how much is current". They read the same
// nodes, so a node one of them calls work and the other calls done is a contradiction an agent
// cannot drain: it annotates until the queue is empty and watches coverage stay short.
//
// This law holds them to one walk. It checks agreement per node (each fixture node carries a
// private domain, so its `byDomain` bucket is that node alone), on the default staleness policy and
// on the policy that opts package domains back in — the axis where the two used to disagree.

const PRIVATE_DOMAIN_OF: Record<string, string> = {
  'mod:app/code': 'only-module',
  'template:app/page.html': 'only-template',
  'infra:sam:template.yaml': 'only-infra',
};

/**
 * Which nodes each private domain bucket holds. A runtime resource carries its parent IaC module's
 * domain tags rather than its own, so it shares the parent's bucket by construction.
 */
const BUCKET_MEMBERS: Record<string, string[]> = {
  'only-module': ['mod:app/code'],
  'only-template': ['template:app/page.html'],
  'only-infra': ['infra:sam:template.yaml', 'resource:aws-lambda:Worker'],
};

/** Every node the fixture expects the backlog to ask a freshness question about, and its hash. */
const ASKED_NODES: Array<{ nodeId: string; hash: string; nodeType: StoredAnnotation['nodeType'] }> = [
  { nodeId: 'mod:app/code', hash: 'code-h1', nodeType: 'module' },
  { nodeId: 'template:app/page.html', hash: 'page-h1', nodeType: 'template' },
  { nodeId: 'infra:sam:template.yaml', hash: 'infra-h1', nodeType: 'module' },
  { nodeId: 'resource:aws-lambda:Worker', hash: 'worker-h1', nodeType: 'runtime-resource' },
];

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): RepositoryGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.id, n);
  const outEdges = new Map<string, GraphEdge[]>();
  const inEdges = new Map<string, GraphEdge[]>();
  const byType = new Map<GraphNode['type'], Set<string>>();
  for (const e of edges) {
    (outEdges.get(e.from) ?? outEdges.set(e.from, []).get(e.from)!).push(e);
    (inEdges.get(e.to) ?? inEdges.set(e.to, []).get(e.to)!).push(e);
  }
  for (const n of nodes) {
    if (!byType.has(n.type)) byType.set(n.type, new Set());
    byType.get(n.type)!.add(n.id);
  }
  return { nodes: nodeMap, edges, outEdges, inEdges, byType };
}

function makeModule(id: string, contentHash: string): ModuleInfo {
  return {
    id,
    packageName: 'app',
    absPath: asHostPath(`/repo/${id}.ts`),
    pkgRelPath: asPkgRelPath(`${id}.ts`),
    contentHash,
    imports: [],
    exports: [],
  };
}

const INFRA: InfraModuleInfo = {
  id: 'infra:sam:template.yaml',
  kind: 'sam',
  absPath: asHostPath('/repo/template.yaml'),
  repoRelPath: asRepoRelPath('template.yaml'),
  contentHash: 'infra-h1',
  resources: [{
    id: 'Worker',
    kind: 'lambda',
    provider: 'aws',
    identity: { namespace: 'aws-lambda', localKey: 'Worker' },
    contentHash: 'worker-h1',
    attributes: {},
  }],
};

/**
 * Every annotatable kind, each tagged to a domain of its own, plus the three shapes the backlog
 * asks nothing about: a package-only domain under path-only staleness, a runtime resource with no
 * hash source, and a template stage 1 discovered but no interpreter projected.
 */
function buildFixture(): { graph: RepositoryGraph; snapshot: RepositoryFactsSnapshot } {
  const nodes: GraphNode[] = [
    { id: 'mod:app/code', type: 'module', label: 'code', description: '' },
    { id: 'template:app/page.html', type: 'template', label: 'page.html', description: '', data: { relPath: 'app/page.html' } },
    { id: 'infra:sam:template.yaml', type: 'module', label: 'template.yaml', description: '' },
    {
      id: 'resource:aws-lambda:Worker',
      type: 'runtime-resource',
      label: 'Worker',
      description: '',
      data: { kind: 'lambda', provider: 'aws' },
    },
    {
      id: 'resource:k8s:Unhashed',
      type: 'runtime-resource',
      label: 'Unhashed',
      description: '',
      data: { kind: 'deployment', provider: 'k8s' },
    },
    { id: 'domain:packaged', type: 'domain', label: 'packaged', description: '' },
    ...Object.values(PRIVATE_DOMAIN_OF).map((label): GraphNode => ({
      id: `domain:${label}`,
      type: 'domain',
      label,
      description: '',
    })),
  ];
  const edges: GraphEdge[] = [
    { from: 'infra:sam:template.yaml', to: 'resource:aws-lambda:Worker', kind: 'contains' },
    { from: 'mod:app/code', to: 'domain:packaged', kind: 'tagged', metadata: { tagSource: 'package' } },
    ...Object.entries(PRIVATE_DOMAIN_OF).map(([nodeId, label]): GraphEdge => ({
      from: nodeId,
      to: `domain:${label}`,
      kind: 'tagged',
      metadata: { tagSource: 'path' },
    })),
  ];
  const snapshot: RepositoryFactsSnapshot = {
    repoRoot: '/repo',
    timestamp: '2024-01-01T00:00:00.000Z',
    packages: [],
    modules: [makeModule('mod:app/code', 'code-h1')],
    templates: [
      { id: 'template:app/page.html', relPath: 'app/page.html', contentHash: 'page-h1' },
      { id: 'template:app/unprojected.html', relPath: 'app/unprojected.html', contentHash: 'unprojected-h1' },
    ],
    infraModules: [INFRA],
  };
  return { graph: makeGraph(nodes, edges), snapshot };
}

function annotation(nodeId: string, contentHash: string, nodeType: StoredAnnotation['nodeType']): StoredAnnotation {
  return {
    nodeId,
    nodeType,
    contentHash,
    pass: 1,
    updatedAt: '2024-01-01T00:00:00.000Z',
    annotation: { summary: 'A note long enough to count as filled prose for scoring.' },
    schemaVersion: 1,
  };
}

describe('core-laws annotation backlog — one walk answers the queue and coverage', () => {
  let tmpDir: string;
  let store: AnnotationStore;
  let graph: RepositoryGraph;
  let snapshot: RepositoryFactsSnapshot;

  const PATH_ONLY = { ...DEFAULT_PROPAGATION_CONFIG };
  const PACKAGE_HARD_QUEUE = { ...DEFAULT_PROPAGATION_CONFIG, packageDomainHardQueue: true };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-backlog-law-'));
    store = AnnotationStore.createSync(tmpDir);
    ({ graph, snapshot } = buildFixture());
  });

  afterEach(() => {
    store.flush();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const queueRows = (propagation = PATH_ONLY) =>
    store.getQueuePage(graph, snapshot, { limit: Number.MAX_SAFE_INTEGER, propagation, entrypoints: [] });
  const coverage = (propagation = PATH_ONLY) =>
    store.getStats(graph, snapshot, { propagation, entrypoints: [] });

  it('exercises every backlog phase, so the agreement checks below are not vacuous', () => {
    const byType = countBacklogPhases(
      queueRows().items.map(item => ({ ...item, phase: item.context.annotationPhase! })) as never,
    );
    for (const phase of BACKLOG_PHASES) {
      expect({ phase, count: byType[phase] }).toEqual({ phase, count: expect.any(Number) });
      expect(byType[phase]).toBeGreaterThan(0);
    }
  });

  it.each([
    ['path-only (default)', PATH_ONLY],
    ['packageDomainHardQueue', PACKAGE_HARD_QUEUE],
  ])('agrees bucket by bucket between queue and coverage under %s', (_name, propagation) => {
    const queued = new Set(queueRows(propagation).items.map(item => item.nodeId));
    const byDomain = coverage(propagation).byDomain;
    for (const [label, members] of Object.entries(BUCKET_MEMBERS)) {
      const expected = members.filter(nodeId => queued.has(nodeId)).length;
      expect({ label, work: needsWorkOf(byDomain[label]!) }).toEqual({ label, work: expected });
    }
  });

  it('moves queue and coverage by the same one node when a single node is confirmed', () => {
    for (const { nodeId, hash, nodeType } of ASKED_NODES) {
      const before = { queue: queueRows().counts.needsWork, coverage: needsWorkOf(rollUpCoverage(coverage())) };
      expect(queueRows().items.map(i => i.nodeId)).toContain(nodeId);

      store.set(nodeId, annotation(nodeId, hash, nodeType));
      const after = { queue: queueRows().counts.needsWork, coverage: needsWorkOf(rollUpCoverage(coverage())) };

      expect({ nodeId, ...after }).toEqual({ nodeId, queue: before.queue - 1, coverage: before.coverage - 1 });
      expect(queueRows().items.map(i => i.nodeId)).not.toContain(nodeId);
      store.delete([nodeId]);
    }
  });

  it.each([
    ['path-only (default)', PATH_ONLY],
    ['packageDomainHardQueue', PACKAGE_HARD_QUEUE],
  ])('reports the same backlog size through every publisher under %s', (_name, propagation) => {
    const page = queueRows(propagation);
    const scan = store.scanAnnotationHealth(graph, snapshot, { propagation, entrypoints: [] });
    const rolled = rollUpCoverage(coverage(propagation));
    const perPhase = backlogKindCoverages(coverage(propagation)).reduce((n, kind) => n + needsWorkOf(kind), 0);

    expect(page.counts.needsWork).toBe(page.items.length);
    expect(scan.counts).toEqual(page.counts);
    expect(needsWorkOf(rolled)).toBe(page.counts.needsWork);
    expect(perPhase).toBe(page.counts.needsWork);
    expect(store.getQueue(graph, snapshot, { limit: Number.MAX_SAFE_INTEGER, propagation, entrypoints: [] }))
      .toHaveLength(page.counts.needsWork);
  });

  it('agrees per phase between queue rows and coverage buckets', () => {
    const page = queueRows();
    const cov = coverage();
    const byPhase: Record<QueuePhase, KindCoverage> = {
      module: cov.modules,
      template: cov.templates,
      infra: cov.infraModules,
      'runtime-resource': cov.services,
      domain: cov.domains,
    };
    for (const phase of BACKLOG_PHASES) {
      expect({ phase, work: needsWorkOf(byPhase[phase]) }).toEqual({ phase, work: page.byType[phase] });
    }
  });

  it('closes each coverage bucket over its verdicts', () => {
    for (const propagation of [PATH_ONLY, PACKAGE_HARD_QUEUE]) {
      const cov = coverage(propagation);
      for (const kind of [...backlogKindCoverages(cov), ...Object.values(cov.byDomain), rollUpCoverage(cov)]) {
        expect(kind.total).toBe(kind.fresh + kind.stale + kind.unannotated + kind.unconfirmable);
      }
    }
  });

  it('names the nodes it asks nothing about instead of counting them as work', () => {
    const cov = coverage();
    // No hash source for the k8s resource; no graph node for the unprojected template; the
    // package-only domain's roll-up is advisory under path-only staleness.
    expect(cov.services.unconfirmable).toBe(1);
    expect(cov.templates.unconfirmable).toBe(1);
    expect(cov.domains.unconfirmable).toBe(1);
    expect(queueRows().items.map(i => i.nodeId)).not.toContain('resource:k8s:Unhashed');
    expect(queueRows().items.map(i => i.nodeId)).not.toContain('template:app/unprojected.html');
    expect(queueRows().items.map(i => i.nodeId)).not.toContain('domain:packaged');

    // Opting package domains back in moves exactly that domain out of unconfirmable and into work.
    const opted = coverage(PACKAGE_HARD_QUEUE);
    expect(opted.domains.unconfirmable).toBe(0);
    expect(queueRows(PACKAGE_HARD_QUEUE).items.map(i => i.nodeId)).toContain('domain:packaged');
    expect(needsWorkOf(rollUpCoverage(opted))).toBe(needsWorkOf(rollUpCoverage(cov)) + 1);
  });

  it('keeps repo-wide totals counting nodes that need no work', () => {
    const before = coverage();
    store.set('mod:app/code', annotation('mod:app/code', 'code-h1', 'module'));
    const after = coverage();

    expect(after.modules.total).toBe(before.modules.total);
    expect(after.modules.fresh).toBe(1);
    expect(after.modules.unannotated).toBe(0);
    expect(needsWorkOf(after.modules)).toBe(0);
    expect(queueRows().items.map(i => i.nodeId)).not.toContain('mod:app/code');
  });

  it('reports the same backlog to onboarding state as to the queue', () => {
    store.set('mod:app/code', annotation('mod:app/code', 'code-h1', 'module'));
    const state = {
      graph,
      snapshot,
      annotations: store,
      builtAt: '2024-01-01T00:00:00.000Z',
      domainsSuggestions: { count: 0, declinedHidden: 0, axes: [] },
    } as unknown as RepovineState;

    const onboarding = buildOnboardingState(state).onboarding.annotations;
    expect(onboarding.queueTotal).toBe(queueRows().counts.needsWork);

    // The percentage converges with the queue: unconfirmable nodes are out of the denominator, so
    // draining the queue reaches 100 rather than stalling below it forever.
    const cov = coverage();
    const rolled = rollUpCoverage(cov);
    expect(onboarding.coveragePct)
      .toBe(Math.round((rolled.fresh / (rolled.total - rolled.unconfirmable)) * 100));
  });
});

describe('core-laws annotation backlog — no second walk, no derived bucket', () => {
  const SRC_DIR = path.join(findRepovineRoot(), 'src');
  const WALK_MODULE = path.join(SRC_DIR, 'annotations', 'backlog.ts');

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out.sort();
  }

  // What these two guards do NOT catch: a second walk that reads only some of the populations (it
  // is a walk of one kind, not of the surface), a walk assembled from helpers in another module,
  // and a bucket derived through intermediate variables rather than one subtraction expression.
  // Those are held by the agreement checks above, which compare the published numbers rather than
  // the text that produces them — a partial walk that disagrees fails there, and one that agrees is
  // dead weight rather than a contradiction.

  /**
   * Reading every annotatable population in one file is the shape of a backlog walk.
   *
   * Graph populations are named through `nodesOfType`, the one enumeration helper; the token is the
   * call, not the index access, because reading `graph.byType` directly is itself guarded elsewhere.
   */
  const POPULATIONS = [
    'snapshot.modules',
    'snapshot.templates',
    'snapshot.infraModules',
    "nodesOfType(graph, 'runtime-resource')",
    "nodesOfType(graph, 'domain')",
  ];

  it('walks the annotatable surface in exactly one module', () => {
    const walkers = sourceFiles(SRC_DIR).filter(file => {
      const text = fs.readFileSync(file, 'utf-8');
      return POPULATIONS.every(token => text.includes(token));
    });
    expect(walkers).toEqual([WALK_MODULE]);
  });

  /** `total - annotated` and `annotated - fresh` are how a coverage reader re-derives the backlog. */
  const PATH = String.raw`(?:[A-Za-z_$][\w$]*\s*\.\s*)*`;
  const DERIVED_BUCKET = [
    new RegExp(String.raw`\b(?:total|totalDomains|totalModules)\b\s*-\s*${PATH}\b(?:annotated|fresh)\b`),
    new RegExp(String.raw`\bannotated\b\s*-\s*${PATH}\bfresh\b`),
  ];

  it('derives no backlog bucket by subtracting coverage fields', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      for (const [index, line] of fs.readFileSync(file, 'utf-8').split('\n').entries()) {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
        if (DERIVED_BUCKET.some(re => re.test(line))) {
          offenders.push(`${path.relative(SRC_DIR, file)}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
