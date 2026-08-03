import { describe, expect, it } from '@jest/globals';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { validateGraphDelta } from '../../src/graph/delta.js';
import { findFixturesRoot } from './graph-law-helpers.js';

// applyValidated checks each delta before applying it, so a malformed contribution is dropped with
// a warning. This law covers what that check cannot see: the MATERIALIZED graph, which also carries
// nodes and edges stage2 adds outside the interpreter delta path. A first-party contributor that
// escapes the types (e.g. an `as EdgeKind` cast over runtime data) is caught per-delta at runtime;
// a core builder writing straight into the graph is caught here. Both are held to one schema
// (closed NodeType/EdgeKind + per-type node data). Fixtures span the structural axes: code (TS),
// infra (IaC), and a hybrid.
describe('core-laws first-party GraphDelta shape (built-in pipeline re-validation)', () => {
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
