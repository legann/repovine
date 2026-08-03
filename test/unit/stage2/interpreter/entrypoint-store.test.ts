import { describe, expect, it } from '@jest/globals';
import { createEmptyGraph } from '../../../../src/graph/index.js';
import {
  getInterpreterEntrypoints,
  rememberInterpreterEntrypoints,
} from '../../../../src/stage2/interpreter/entrypoint-store.js';

describe('stage2 layer entrypoint store', () => {
  it('returns an empty list for graphs with no remembered layer entrypoints', () => {
    expect(getInterpreterEntrypoints(createEmptyGraph())).toEqual([]);
  });

  it('remembers entrypoints by graph object without mutating graph shape', () => {
    const graph = createEmptyGraph();
    const beforeKeys = Object.keys(graph);
    const entry = { id: 'entrypoint:api:mod:a:/x:GET', kind: 'api', moduleId: 'mod:a' };

    rememberInterpreterEntrypoints(graph, [entry]);
    entry.id = 'changed';

    expect(Object.keys(graph)).toEqual(beforeKeys);
    expect(getInterpreterEntrypoints(graph)).toEqual([
      { id: 'entrypoint:api:mod:a:/x:GET', kind: 'api', moduleId: 'mod:a' },
    ]);
  });
});
