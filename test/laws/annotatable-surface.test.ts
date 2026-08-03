import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { addNode, createEmptyGraph } from '../../src/graph/index.js';
import { AnnotationStore } from '../../src/annotations/store.js';
import { buildOnboardingState } from '../../src/mcp/onboarding-state.js';
import { ANNOTATABLE_NODE_TYPES, ANNOTATION_EXEMPT_NODE_TYPES } from '../../src/annotations/format.js';
import { NODE_TYPES } from '../../src/types.js';
import type { ModuleInfo, RepositoryFactsSnapshot, RepositoryGraph } from '../../src/types.js';
import type { RepovineState } from '../../src/mcp/types.js';

type AnnotatableNodeType = typeof ANNOTATABLE_NODE_TYPES[number];

// schema-shape proves a new NodeType exists as a graph primitive; edge-witness-{producer,consumer}
// prove its edges have producer + consumer witnesses. NEITHER proves a new NodeType became a full
// AGENT-FACING ANNOTATION ANCHOR — declared annotatable AND walked by the unified backlog.
// `template` (2026-06-20 follow-up) exposed that gap: it was a live node + had renders/extends/
// includes witnesses, yet `queueTotal`/coverage silently undercounted it because nothing held the
// backlog walk to the annotatable set.
// These two laws close that contract: (1) every NodeType is annotate-or-exempt by construction;
// (2) every annotatable, queue-backed type actually moves the unified backlog when unannotated.

const emptySnapshot: RepositoryFactsSnapshot = {
  repoRoot: '/repo',
  timestamp: '2024-01-01T00:00:00.000Z',
  packages: [],
  modules: [],
};

function moduleInfo(id: string): ModuleInfo {
  return {
    id,
    packageName: 'app',
    absPath: asHostPath(`/repo/${id}.ts`),
    pkgRelPath: asPkgRelPath(`${id}.ts`),
    contentHash: `${id}:hash`,
    imports: [],
    exports: [],
  };
}

describe('core-laws annotation anchor partition (classification)', () => {
  it('classifies every NodeType exactly once: annotatable XOR explicitly exempt', () => {
    const annotatable = [...ANNOTATABLE_NODE_TYPES];
    const exempt = [...ANNOTATION_EXEMPT_NODE_TYPES];

    // Disjoint: a type is never both annotatable and exempt.
    expect(annotatable.filter(t => (exempt as readonly string[]).includes(t))).toEqual([]);
    // Covering: a new NodeType fails here until its author picks a side — no silent third state.
    expect([...annotatable, ...exempt].sort()).toEqual([...NODE_TYPES].sort());
  });
});

describe('core-laws annotatable backlog differential (anchor consumer)', () => {
  let tmpDir: string;
  let store: AnnotationStore;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-annotatable-law-'));
    // No annotations are ever written; the store stays empty so every node reads as unannotated.
    store = AnnotationStore.createSync(tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The load-bearing consumer: SessionStart / build-status `queueTotal`, whose per-type sum in
  // onboarding-state.ts has no compile guard. Witnessing through it catches both a missing
  // getStats bucket AND a missing term in that sum.
  function queueTotal(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): number {
    const state = {
      graph,
      snapshot,
      annotations: store,
      builtAt: '2024-01-01T00:00:00.000Z',
      domainsSuggestions: { count: 0, declinedHidden: 0, axes: [] },
    } as unknown as RepovineState;
    return buildOnboardingState(state).onboarding.annotations.queueTotal;
  }

  const baseline = (): number => queueTotal(createEmptyGraph(), emptySnapshot);

  type Witness = (() => void) | 'carveout';

  /**
   * Registry keyed by AnnotatableNodeType. A `function` asserts that one unannotated node of that
   * type strictly increases the unified backlog. `'carveout'` declares a type the backlog walk
   * never visits — only `export-symbol` qualifies: `write_annotation` accepts an `export:` id, and
   * no queue phase or coverage bucket reads one. The meta-test below pins this registry to exactly
   * ANNOTATABLE_NODE_TYPES, so a new annotatable type cannot be added without choosing one.
   */
  const WITNESSES: Record<AnnotatableNodeType, Witness> = {
    'export-symbol': 'carveout',
    module: () => {
      const graph = createEmptyGraph();
      addNode(graph, { id: 'mod:law/x', type: 'module', label: 'x.ts', description: 'module' });
      const snapshot: RepositoryFactsSnapshot = { ...emptySnapshot, modules: [moduleInfo('mod:law/x')] };
      expect(queueTotal(graph, snapshot)).toBeGreaterThan(baseline());
    },
    template: () => {
      const graph = createEmptyGraph();
      addNode(graph, {
        id: 'template:law/x.html',
        type: 'template',
        label: 'x.html',
        description: 'template',
        data: { relPath: 'law/x.html' },
      });
      const snapshot: RepositoryFactsSnapshot = {
        ...emptySnapshot,
        templates: [{ id: 'template:law/x.html', relPath: 'law/x.html', contentHash: 'h' }],
      };
      expect(queueTotal(graph, snapshot)).toBeGreaterThan(baseline());
    },
    'runtime-resource': () => {
      const graph = createEmptyGraph();
      addNode(graph, {
        id: 'resource:aws-lambda:Fn',
        type: 'runtime-resource',
        label: 'Fn',
        description: 'Lambda',
        // A resource with no hash source carries no freshness question, so it is coverage's
        // `unconfirmable`, never backlog work. The witness needs one the queue can actually rank.
        data: { kind: 'lambda', provider: 'aws', contentHash: 'fn-h1' },
      });
      expect(queueTotal(graph, emptySnapshot)).toBeGreaterThan(baseline());
    },
    domain: () => {
      const graph = createEmptyGraph();
      addNode(graph, { id: 'domain:law', type: 'domain', label: 'law', description: 'domain' });
      expect(queueTotal(graph, emptySnapshot)).toBeGreaterThan(baseline());
    },
  };

  const CARVEOUTS = ['export-symbol'] as const;
  const entries = Object.entries(WITNESSES) as Array<[AnnotatableNodeType, Witness]>;
  const witnessedKinds = entries.filter(([, w]) => typeof w === 'function').map(([k]) => k);

  /**
   * A carveout states a fact about the backlog, so it is witnessed like a queue-backed type — in
   * the negative. `Record<carveout>` forces a new carveout to bring its own fixture, and the
   * assertion fails the moment the backlog starts ranking that type, which is the point at which
   * it belongs in WITNESSES instead.
   */
  const CARVEOUT_WITNESSES: Record<typeof CARVEOUTS[number], () => void> = {
    'export-symbol': () => {
      const graph = createEmptyGraph();
      addNode(graph, {
        id: 'export:mod:law/x/doThing',
        type: 'export-symbol',
        label: 'doThing',
        description: 'exported symbol',
      });
      expect(queueTotal(graph, emptySnapshot)).toBe(baseline());
    },
  };

  it('covers every annotatable NodeType as a backlog witness or explicit carveout', () => {
    const carveouts = entries.filter(([, w]) => w === 'carveout').map(([k]) => k).sort();
    // Only roll-up types may skip the differential; nothing queue-backed hides as a carveout.
    expect(carveouts).toEqual([...CARVEOUTS].sort());
    // Registry spans exactly the annotatable set (also pinned at compile time by Record<…>).
    expect([...carveouts, ...witnessedKinds].sort()).toEqual([...ANNOTATABLE_NODE_TYPES].sort());
  });

  it.each(witnessedKinds)('%s moves the unified annotation backlog (queueTotal) when unannotated', kind => {
    (WITNESSES[kind] as () => void)();
  });

  it.each([...CARVEOUTS])('%s leaves the unified annotation backlog (queueTotal) unchanged', kind => {
    CARVEOUT_WITNESSES[kind]();
  });
});
