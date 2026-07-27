/**
 * Registry-level unit tests. The findings-parity gate
 * (detector-registry-parity.test.ts) proves the refactor is output-identical on
 * the fixture corpus, but every frontend-class category emits ∅ there, so it
 * cannot distinguish "detector ran and returned ∅" from "detector was skipped".
 * These tests exercise the dispatch contract directly with synthetic probe
 * detectors installed via setDetectorsForTest:
 *
 *   - category → detector dispatch (run only when a category intersects)
 *   - appliesTo whole-detector skip on a pure-backend (Python) scope, and run on
 *     a frontend-capable (TypeScript) scope
 *   - detectDomainShape-style dual-category flags derived from requestedCategories
 *   - annotation-risk receives a precomputed derivedStaleSet (and undefined w/o snapshot)
 *   - an unknown/unhandled category does not throw
 *
 * Plus a structural check of the real built-in registry.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { collectRepositoryFactsAsync } from '../../../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../../../src/stage2/index.js';
import { AnnotationStore } from '../../../../src/annotations/store.js';
import {
  refactoringCategoriesFromFindingId,
  runRefactoringReport,
  type RefactoringState,
} from '../../../../src/analysis/architecture/index.js';
import { INTERNAL_DETECTOR_PACKS } from '../../../../src/analysis/architecture-detectors/index.js';
import {
  getDetectors,
  setDetectorsForTest,
} from '../../../../src/analysis/architecture/detector-registry.js';
import {
  uiSurfaceApplies,
  assertDetectorPacksRegistered,
} from '../../../../src/analysis/architecture/detector-bootstrap.js';
import type {
  ArchitectureDetector,
  DetectorContext,
  DetectorPack,
} from '../../../../src/analysis/architecture/detector-types.js';
import type { RefactoringCategory, RefactoringFinding } from '../../../../src/analysis/architecture/types.js';
import type { ModuleInfo } from '../../../../src/types.js';

function fixtureRoot(name: string): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'fixtures', name),
    path.resolve(process.cwd(), 'repovine', 'test', 'fixtures', name),
  ];
  const root = candidates.find(candidate => fs.existsSync(candidate));
  if (!root) throw new Error(`Could not find fixture ${name}. Tried: ${candidates.join(', ')}`);
  return root;
}

async function buildState(name: string): Promise<RefactoringState> {
  const snapshot = await collectRepositoryFactsAsync(fixtureRoot(name));
  const modulesById = new Map<string, ModuleInfo>();
  for (const m of snapshot.modules) modulesById.set(m.id, m);
  const graph = composeRepositoryGraph(snapshot, modulesById);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-registry-'));
  return { graph, modulesById, annotations: AnnotationStore.createSync(tmpDir), snapshot };
}

/** A finding shaped just enough to survive the report's category filter. */
function marker(category: RefactoringCategory, id: string): RefactoringFinding {
  return {
    id: `${category}:${id}`,
    category,
    title: 'probe',
    severity: 'low',
    impact: 'low',
    confidence: 1,
    nodes: [],
    evidence: [],
    suggestion: '',
  };
}

describe('refactoring detector registry — dispatch contract', () => {
  let tsState: RefactoringState;
  let pyState: RefactoringState;
  let restore: (() => void) | undefined;

  beforeAll(async () => {
    tsState = await buildState('basic-typescript');
    pyState = await buildState('basic-python');
  });

  afterEach(() => {
    if (restore) {
      restore();
      restore = undefined;
    }
  });

  it('runs a detector only when a requested category intersects its categories', () => {
    const ran: string[] = [];
    restore = setDetectorsForTest([
      {
        id: 'probe-boundary',
        categories: ['boundary'],
        run: () => { ran.push('boundary'); return [marker('boundary', 'm')]; },
      },
      {
        id: 'probe-god-module',
        categories: ['god-module'],
        run: () => { ran.push('god-module'); return [marker('god-module', 'm')]; },
      },
    ]);

    runRefactoringReport(tsState, { categories: ['boundary'], minConfidence: 0 });

    expect(ran).toEqual(['boundary']);
  });

  it('appliesTo skips the whole detector on a pure-backend scope but runs on a frontend scope', () => {
    const makeProbe = (ran: { value: boolean }): ArchitectureDetector => ({
      id: 'probe-frontend',
      categories: ['client-business-logic'],
      appliesTo: uiSurfaceApplies,
      run: () => { ran.value = true; return []; },
    });

    // TypeScript scope: typescript declares uiSurfaces → detector runs.
    const tsRan = { value: false };
    restore = setDetectorsForTest([makeProbe(tsRan)]);
    runRefactoringReport(tsState, { categories: ['client-business-logic'], minConfidence: 0 });
    restore();
    restore = undefined;
    expect(tsRan.value).toBe(true);

    // Python scope: python declares uiSurfaces:false → whole-detector skip.
    const pyRan = { value: false };
    restore = setDetectorsForTest([makeProbe(pyRan)]);
    runRefactoringReport(pyState, { categories: ['client-business-logic'], minConfidence: 0 });
    expect(pyRan.value).toBe(false);
  });

  it('a multi-category detector sees per-category flags from requestedCategories and the report keeps only requested categories', () => {
    let seen: { godDomain: boolean; lowCohesion: boolean } | undefined;
    restore = setDetectorsForTest([
      {
        id: 'probe-domain-shape',
        categories: ['god-domain', 'low-cohesion'],
        run: (ctx: DetectorContext) => {
          seen = {
            godDomain: ctx.requestedCategories.has('god-domain'),
            lowCohesion: ctx.requestedCategories.has('low-cohesion'),
          };
          return [marker('god-domain', 'd'), marker('low-cohesion', 'd')];
        },
      },
    ]);

    const report = runRefactoringReport(tsState, { categories: ['god-domain'], minConfidence: 0, limit: 200 });

    expect(seen).toEqual({ godDomain: true, lowCohesion: false });
    const categories = (report.findings as RefactoringFinding[]).map(f => f.category);
    expect(categories).toContain('god-domain');
    expect(categories).not.toContain('low-cohesion');
  });

  it('annotation-risk receives a precomputed derivedStaleSet when a snapshot is present, undefined otherwise', () => {
    const captured: Array<ReadonlySet<string> | undefined> = [];
    const probe: ArchitectureDetector = {
      id: 'probe-annotation-risk',
      categories: ['annotation-risk'],
      run: (ctx: DetectorContext) => { captured.push(ctx.derivedStaleSet); return []; },
    };

    restore = setDetectorsForTest([probe]);
    runRefactoringReport(tsState, { categories: ['annotation-risk'], minConfidence: 0 });
    restore();
    restore = undefined;

    restore = setDetectorsForTest([probe]);
    runRefactoringReport({ ...tsState, snapshot: undefined }, { categories: ['annotation-risk'], minConfidence: 0 });

    expect(captured).toHaveLength(2);
    expect(captured[0]).toBeInstanceOf(Set);
    expect(captured[1]).toBeUndefined();
  });

  it('does not throw when a requested category is handled by no registered detector', () => {
    restore = setDetectorsForTest([
      { id: 'probe-boundary', categories: ['boundary'], run: () => [] },
    ]);

    expect(() =>
      runRefactoringReport(tsState, { categories: ['unclear-architecture'], minConfidence: 0 }),
    ).not.toThrow();
  });
});

describe('refactoring detector registry — built-in registration', () => {
  it('round-trips every registered detector id to its declared categories', () => {
    for (const detector of getDetectors()) {
      expect(refactoringCategoriesFromFindingId(`${detector.id}:sample`)).toEqual(detector.categories);
    }
  });

  it('registers all 26 detectors with the original if-chain order plus server-surface append', () => {
    const ids = getDetectors().map(d => d.id);
    expect(ids).toEqual([
      'duplicate-like',
      'boundary',
      'god-module',
      'domain-shape',
      'client-business-logic',
      'flow-convergence',
      'state-fragmentation',
      'effect-spaghetti',
      'prop-drilling-orchestration',
      'service-wrapper-explosion',
      'ui-domain-coupling',
      'route-convergence',
      'duplicated-client-policy',
      'design-system-leakage',
      'event-driven-boundary',
      'secret-config-boundary',
      'authorization-policy-drift',
      'trust-boundary-validation',
      'privileged-client-side-effect',
      'sensitive-browser-storage',
      'server-client-boundary',
      'source-disclosure-surface',
      'annotation-secret-hygiene',
      'annotation-risk',
      'unclear-architecture',
      'server-handler-orchestration',
    ]);
  });

  it('domain-shape maps to both god-domain and low-cohesion', () => {
    const domainShape = getDetectors().find(d => d.id === 'domain-shape');
    expect(domainShape?.categories).toEqual(['god-domain', 'low-cohesion']);
  });

  it('catalogues ui-surface and server-surface detector packs', () => {
    expect(INTERNAL_DETECTOR_PACKS.map(pack => pack.id)).toEqual(['ui-surface', 'server-surface']);
    expect(INTERNAL_DETECTOR_PACKS.find(pack => pack.id === 'server-surface')?.detectors.map(det => det.id))
      .toEqual(['server-handler-orchestration']);
  });

  // Step 5 (registration policy) locks the catalog↔registration boundary: packs are
  // identity/grouping, detector-bootstrap owns the order, and this drift guard is the only tie
  // between them. The guard runs at import (a real mismatch would crash the suite), so these tests
  // pin its behavior on both paths via injected lists.
  it('drift guard accepts the real catalog and throws when a pack declares an unregistered detector', () => {
    expect(() => assertDetectorPacksRegistered()).not.toThrow();

    const orphanPack: DetectorPack = { id: 'phantom-surface', detectors: [{ id: 'phantom-detector', categories: ['boundary'], run: () => [] }] };
    expect(() => assertDetectorPacksRegistered(getDetectors(), [orphanPack]))
      .toThrow(/pack "phantom-surface" declares detector "phantom-detector" that is not registered/);
  });

  it('attaches the capability appliesTo gate to exactly the surface-class detectors', () => {
    const gated = getDetectors().filter(d => d.appliesTo).map(d => d.id).sort();
    expect(gated).toEqual([
      'client-business-logic',
      'duplicated-client-policy',
      'effect-spaghetti',
      'privileged-client-side-effect',
      'prop-drilling-orchestration',
      'sensitive-browser-storage',
      'server-client-boundary',
      'server-handler-orchestration',
      'state-fragmentation',
    ]);
  });
});
