import { describe, expect, it } from '@jest/globals';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { inferFileBasedRoutes } from '../../src/mcp/lib/entrypoints.js';
import { detectPython } from '../../packages/plugins/source-python/src/discover.js';
import { frontendHintLeaks, phantomFrontendHints } from '../helpers/semantic-hints-tiers.js';
import { findFixturesRoot } from './graph-law-helpers.js';

const PYTHON_AVAILABLE = detectPython() !== null;
const d = PYTHON_AVAILABLE ? describe : describe.skip;

d('core-laws honest-empty', () => {
  it('checks only real semanticHints slots (runtime phantom-lock)', () => {
    // The checked frontend-only names must all be real schema slots, so the list cannot drift onto a
    // phantom field (the prior hand-list vacuously checked a non-existent `frontend` and missed `ui`).
    expect(phantomFrontendHints()).toEqual([]);
  });

  it.each(['basic-python', 'basic-python-web'])(
    'builds a non-empty Python graph (%s) with frontend-only hints absent by construction',
    async fixture => {
      const fixtureRoot = path.join(findFixturesRoot(), fixture);
      const origLog = console.log;
      console.log = () => {};
      try {
        const snapshot = await collectRepositoryFactsAsync(fixtureRoot);
        const graph = composeRepositoryGraph(snapshot);

        expect(snapshot.modules.length).toBeGreaterThan(0);
        expect(graph.nodes.size).toBeGreaterThan(0);
        expect(snapshot.packages.every(pkg => pkg.sourcePluginId === 'python')).toBe(true);
        expect(snapshot.modules.every(mod => mod.sourcePluginId === 'python')).toBe(true);
        // File-based frontend route inference is TS/JS-only; any Python routes arrive via
        // semanticHints.routes (backend, AST-derived), never from file conventions.
        expect(inferFileBasedRoutes(snapshot)).toEqual([]);

        // Non-vacuous: at least one module carries hints, so the absence check actually runs — even on
        // the web fixture, which does emit backend hints, proving this is *frontend* Tier-3 absence.
        expect(snapshot.modules.some(mod => mod.semanticHints)).toBe(true);
        expect(frontendHintLeaks(snapshot.modules)).toEqual([]);
      } finally {
        console.log = origLog;
      }
    },
  );
});
