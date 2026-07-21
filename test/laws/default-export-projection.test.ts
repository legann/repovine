import { describe, expect, it } from '@jest/globals';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { findFixturesRoot } from './graph-law-helpers.js';

/**
 * A default export that re-exports a NAMED local declaration is the module's whole contract for a
 * descriptor-style module (`const plugin = definePlugin({…}); export default plugin`). The
 * projection used to drop every signature-less default as noise, so such a module read as
 * exporting nothing at all — its `exportCount` was 0, which also suppressed the annotation
 * completeness gate that would have demanded `keyExports` for it.
 *
 * The filter is still right for a genuinely anonymous default: `export default { … }` would
 * project a node labelled `default` carrying no information. Both halves are pinned here.
 */
describe('core-laws default-export projection (G-default)', () => {
  const fixtureRoot = path.join(findFixturesRoot(), 'basic-typescript');

  const build = async (): Promise<ReturnType<typeof composeRepositoryGraph>> => {
    const log = console.log;
    console.log = () => {};
    try {
      return composeRepositoryGraph(await collectRepositoryFactsAsync(fixtureRoot));
    } finally {
      console.log = log;
    }
  };

  const exportIdsOf = (graph: Awaited<ReturnType<typeof build>>, moduleSuffix: string): string[] => {
    const moduleId = [...graph.nodes.keys()].find(id => id.startsWith('mod:') && id.endsWith(moduleSuffix));
    expect(moduleId).toBeDefined();
    return [...graph.nodes.keys()].filter(id => id.startsWith(`export:${moduleId!.slice(4)}/`));
  };

  it('keeps a default that re-exports a named local declaration', async () => {
    const graph = await build();
    const ids = exportIdsOf(graph, '/plugin-descriptor');

    expect(ids).toContain(
      `export:${[...graph.nodes.keys()].find(id => id.endsWith('/plugin-descriptor'))!.slice(4)}/default`,
    );

    const node = graph.nodes.get(ids.find(id => id.endsWith('/default'))!);
    expect(node).toBeDefined();
    // The local name has to reach the reader: a node labelled bare `default` is what made this
    // export unreadable in the first place.
    expect(node!.label).toBe('default (namedDescriptor)');
  });

  it('still drops an anonymous default', async () => {
    const graph = await build();
    const ids = exportIdsOf(graph, '/anonymous-default');

    expect(ids.some(id => id.endsWith('/default'))).toBe(false);
    // The module is not export-less — only its unnameable default is filtered.
    expect(ids.some(id => id.endsWith('/anonymousMarker'))).toBe(true);
  });

  it('extraction records the local declaration a default points at', async () => {
    const snapshot = await (async () => {
      const log = console.log;
      console.log = () => {};
      try {
        return await collectRepositoryFactsAsync(fixtureRoot);
      } finally {
        console.log = log;
      }
    })();

    const named = snapshot.modules.find(m => m.id.endsWith('/plugin-descriptor'));
    const anonymous = snapshot.modules.find(m => m.id.endsWith('/anonymous-default'));
    expect(named).toBeDefined();
    expect(anonymous).toBeDefined();

    // The snapshot always carried the default itself — only the graph projection dropped it. What
    // is new is the local name, which is the sole signal the projection can discriminate on.
    expect(named!.exports.some(e => e.isDefault && e.defaultLocalName === 'namedDescriptor')).toBe(true);
    expect(anonymous!.exports.some(e => e.isDefault && e.defaultLocalName === undefined)).toBe(true);
  });
});
