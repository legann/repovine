import { describe, expect, it } from '@jest/globals';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { validateGraphDelta } from '../../src/graph/delta.js';
import { findFixturesRoot } from './graph-law-helpers.js';

// Built-in interpreter deltas are applied with `trusted: true` (composer → applyValidated), which
// SKIPS the Zod GraphDelta schema at runtime for performance. The shape contract for first-party
// contributors is therefore enforced by TypeScript types + this law, NOT a runtime gate — and a
// first-party interpreter that escapes the types (e.g. an `as EdgeKind` cast over runtime data)
// would land a malformed node/edge in the materialized graph unnoticed. This law re-validates the
// FULL built-in pipeline output through the same schema the untrusted path uses, so first-party
// output cannot silently diverge from the canonical GraphDelta shape (closed NodeType/EdgeKind +
// per-type node data). Fixtures span the structural axes: code (TS), infra (IaC), and a hybrid.
describe('core-laws first-party GraphDelta shape (D3 — built-in pipeline re-validation)', () => {
  it.each(['basic-typescript', 'sam-lambda-app', 'hybrid-monorepo'])(
    'every node/edge from the built-in interpreters validates against the canonical schema (%s)',
    async fixture => {
      const fixtureRoot = path.join(findFixturesRoot(), fixture);
      const origLog = console.log;
      console.log = () => {};
      try {
        const graph = composeRepositoryGraph(await collectRepositoryFactsAsync(fixtureRoot));
        const result = validateGraphDelta({ nodes: [...graph.nodes.values()], edges: graph.edges });

        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
      } finally {
        console.log = origLog;
      }
    },
  );
});
