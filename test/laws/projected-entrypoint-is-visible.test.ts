import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import { describe, expect, it } from '@jest/globals';
import { addNode, createEmptyGraph } from '../../src/graph/index.js';
import { collectEntrypoints } from '../../src/mcp/lib/entrypoints.js';
import { rememberInterpreterEntrypoints } from '../../src/stage2/interpreter/entrypoint-store.js';
import { LAYER_ENTRYPOINT_SLOT_KEY } from '../../src/stage2/interpreter/entrypoint-slots.js';
import { toEntrypointFragment } from '../../src/stage2/projection/entrypoints.js';
import type { EntrypointFragment } from '../../src/interpreter/types.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';
import type { ModuleInfo, RepositoryFactsSnapshot } from '../../src/types.js';

/**
 * Law: an entrypoint no pre-boundary layer produced is still an answer.
 *
 * The MCP shell replays entrypoints by the slot keys the built-in layers mint, which is how it keeps
 * their global order. An entrypoint from a plugin has no such slot, so replaying alone would leave it
 * in the store and out of every answer — collected, carried across the worker, and invisible.
 *
 * What the shell must not learn is who produced one. The append pass is keyed on "no replayed slot",
 * never on a producer id, and it orders by entrypoint id alone.
 */

function mod(id: string, semanticHints?: ModuleInfo['semanticHints']): ModuleInfo {
  return {
    id,
    packageName: 'shop',
    absPath: asHostPath(`/repo/${id}.go`),
    pkgRelPath: asPkgRelPath(`${id}.go`),
    contentHash: id,
    imports: [],
    exports: [],
    sourcePluginId: 'go',
    semanticHints,
  };
}

function runtime(modules: ModuleInfo[], fragments: EntrypointFragment[]): McpToolRuntime {
  const graph = createEmptyGraph();
  for (const module of modules) {
    addNode(graph, { id: module.id, type: 'module', label: module.pkgRelPath, description: 'module' });
  }
  const snapshot = { repoRoot: '/repo', timestamp: '', packages: [], modules } as unknown as RepositoryFactsSnapshot;
  rememberInterpreterEntrypoints(graph, fragments);
  return {
    getState: () => ({ graph, snapshot, modulesById: new Map(modules.map(m => [m.id, m])) }),
    refreshRepoState: () => undefined,
    repoRoot: '/repo',
  } as unknown as McpToolRuntime;
}

const projected = (moduleId: string, routePath: string, method: string): EntrypointFragment =>
  toEntrypointFragment({
    kind: 'api-route',
    moduleRef: { type: 'module', moduleId },
    path: routePath,
    method,
  });

describe('a projected entrypoint reaches the reader', () => {
  it('publishes an entrypoint that carries no legacy slot', () => {
    const modules = [mod('mod:shop/cmd/checkout/main')];
    const ctx = runtime(modules, [projected(modules[0]!.id, '/checkout', 'POST')]);

    const { items, total } = collectEntrypoints(ctx, {});
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      kind: 'api',
      layer: 'backend',
      path: '/checkout',
      method: 'POST',
      moduleId: 'mod:shop/cmd/checkout/main',
    });
  });

  it('orders appended entrypoints by id, whatever order they arrived in', () => {
    const modules = [mod('mod:shop/a'), mod('mod:shop/b')];
    const forward = collectEntrypoints(runtime(modules, [
      projected(modules[0]!.id, '/a', 'GET'),
      projected(modules[1]!.id, '/b', 'GET'),
    ]), {});
    const backward = collectEntrypoints(runtime(modules, [
      projected(modules[1]!.id, '/b', 'GET'),
      projected(modules[0]!.id, '/a', 'GET'),
    ]), {});

    expect(forward.items.map(i => i.id)).toEqual(backward.items.map(i => i.id));
  });

  it('does not publish a legacy-slotted entrypoint twice', () => {
    const modules = [mod('mod:shop/api', {
      hasRoutes: true,
      routes: [{ path: '/legacy', component: 'handler', declaredIn: 'code', syntax: 'call', kind: 'api', method: 'GET' }],
    })];
    const slotted: EntrypointFragment = {
      [LAYER_ENTRYPOINT_SLOT_KEY]: 'api-route',
      id: `entrypoint:api:${modules[0]!.id}:/legacy:GET`,
      kind: 'api',
      layer: 'backend',
      path: '/legacy',
      method: 'GET',
      moduleId: modules[0]!.id,
    } as unknown as EntrypointFragment;

    const { items } = collectEntrypoints(runtime(modules, [slotted]), {});
    expect(items.filter(i => i.path === '/legacy')).toHaveLength(1);
  });

  it('scopes and filters an appended entrypoint like any other', () => {
    const modules = [mod('mod:shop/a'), mod('mod:shop/b')];
    const ctx = runtime(modules, [
      projected(modules[0]!.id, '/a', 'GET'),
      projected(modules[1]!.id, '/b', 'GET'),
    ]);

    expect(collectEntrypoints(ctx, { kind: 'route' }).total).toBe(0);
    expect(collectEntrypoints(ctx, { scope: 'mod:shop/a' }).items.map(i => i.path)).toEqual(['/a']);
  });
});
