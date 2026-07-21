import { describe, expect, it } from '@jest/globals';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { findFixturesRoot, normalizeGraph } from './graph-law-helpers.js';

// Span the structural axes — code (TS), infra (IaC resources/links), and a hybrid mixing TS + Python
// + IaC — so within-process nondeterminism in any builder (e.g. Map iteration order in runtime-links
// or domain clustering), not just code-structure, is in scope.
describe('core-laws determinism (D1)', () => {
  it.each(['basic-typescript', 'sam-lambda-app', 'hybrid-monorepo'])(
    'builds the same normalized graph twice for %s within the same process',
    async fixture => {
      const fixtureRoot = path.join(findFixturesRoot(), fixture);
      const origLog = console.log;
      console.log = () => {};
      try {
        const first = composeRepositoryGraph(await collectRepositoryFactsAsync(fixtureRoot));
        const second = composeRepositoryGraph(await collectRepositoryFactsAsync(fixtureRoot));

        expect(normalizeGraph(second)).toEqual(normalizeGraph(first));
      } finally {
        console.log = origLog;
      }
    },
  );
});
