import { asRepoRelPath } from '@repovine/plugin-sdk';
import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import { describe, expect, it } from '@jest/globals';
import { addNode, createEmptyGraph } from '../../src/graph/index.js';
import { INTERNAL_INTERPRETERS } from '../../src/interpreters/index.js';
import { collectEntrypoints } from '../../src/mcp/lib/entrypoints.js';
import { composeInterpreters } from '../../src/stage2/interpreter/composer.js';
import { rememberInterpreterEntrypoints } from '../../src/stage2/interpreter/entrypoint-store.js';
import { toEntrypointFragment } from '../../src/stage2/projection/entrypoints.js';
import type { EntrypointFragment } from '../../src/interpreter/types.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';
import type { ModuleInfo, RepositoryFactsSnapshot, RouteInfo } from '../../src/types.js';

/**
 * Law: one normalized route, one canonical entrypoint, whoever produced it.
 *
 * A route hint is a normalized fact: it says where the route is declared and in what syntax, and it
 * does not say which ecosystem noticed it. Every interpreter downstream is gated and keyed on that
 * fact. Swap the producer id on an otherwise identical hint and the published entrypoint must not
 * move — not its id, not its kind, not its layer, and not the `source` label derived from the
 * declaration syntax.
 *
 * The fourth arm arrives by the other public road: a plugin that projects an entrypoint through the
 * SDK contract rather than publishing a route hint. That road carries its own producer-supplied
 * `source`, so parity there is the canonical shape — the id an entrypoint is addressed by, its kind,
 * its layer, and the module it anchors on.
 */

const MODULE_ID = 'mod:shop/checkout';

/** One normalized route: declared in code, carried by a decorator, POST /checkout. */
const ROUTE: RouteInfo = {
  path: '/checkout',
  component: 'CheckoutController.create',
  declaredIn: 'code',
  syntax: 'decorator',
  kind: 'api',
  method: 'POST',
};

function moduleWithRoute(sourcePluginId: string): ModuleInfo {
  return {
    id: MODULE_ID,
    packageName: 'shop',
    absPath: asHostPath(`/repo/checkout`),
    pkgRelPath: asPkgRelPath('checkout'),
    contentHash: 'checkout',
    imports: [],
    exports: [],
    sourcePluginId,
    semanticHints: { hasRoutes: true, routes: [ROUTE] },
  };
}

function runtime(module: ModuleInfo, fragments: EntrypointFragment[]): McpToolRuntime {
  const graph = createEmptyGraph();
  addNode(graph, { id: module.id, type: 'module', label: module.pkgRelPath, description: 'module' });
  const snapshot = {
    repoRoot: '/repo',
    timestamp: '',
    packages: [{ name: 'shop', repoRelDir: asRepoRelPath('.'), sourcePluginId: module.sourcePluginId }],
    modules: [module],
  } as unknown as RepositoryFactsSnapshot;
  rememberInterpreterEntrypoints(graph, fragments);
  return {
    getState: () => ({ graph, snapshot, modulesById: new Map([[module.id, module]]) }),
    refreshRepoState: () => undefined,
    repoRoot: '/repo',
  } as unknown as McpToolRuntime;
}

/** The published entrypoint for the route hint, as produced under one producer id. */
function publishedForProducer(sourcePluginId: string): Record<string, unknown> {
  const module = moduleWithRoute(sourcePluginId);
  const graph = createEmptyGraph();
  addNode(graph, { id: module.id, type: 'module', label: module.pkgRelPath, description: 'module' });
  const snapshot = {
    repoRoot: '/repo',
    timestamp: '',
    packages: [{ name: 'shop', repoRelDir: asRepoRelPath('.'), sourcePluginId }],
    modules: [module],
  } as unknown as RepositoryFactsSnapshot;

  const composed = composeInterpreters({
    graph,
    snapshot,
    modulesById: new Map([[module.id, module]]),
    interpreters: INTERNAL_INTERPRETERS,
  });
  const { items } = collectEntrypoints(runtime(module, composed.entrypoints), {});
  expect(items).toHaveLength(1);
  return items[0]!;
}

const canonicalShape = (entry: Record<string, unknown>): Record<string, unknown> => ({
  id: entry.id,
  kind: entry.kind,
  layer: entry.layer,
  path: entry.path,
  method: entry.method,
  moduleId: entry.moduleId,
});

describe('core-laws one normalized route, one canonical entrypoint', () => {
  it('publishes the identical entrypoint for TypeScript, Python and a producer the engine never heard of', () => {
    const typescript = publishedForProducer('typescript');
    const python = publishedForProducer('python');
    // Not a built-in and not registered anywhere: the only thing that reaches the interpreter is the
    // normalized hint, so an engine that still keyed on a known producer would answer nothing here.
    const go = publishedForProducer('go');

    expect(python).toEqual(typescript);
    expect(go).toEqual(typescript);
    // Asserted rather than assumed: an all-empty answer would satisfy the equalities above.
    expect(typescript).toMatchObject({
      id: `entrypoint:api:${MODULE_ID}:/checkout:POST`,
      kind: 'api',
      layer: 'backend',
      path: '/checkout',
      method: 'POST',
      moduleId: MODULE_ID,
      source: 'decorator-route',
    });
  });

  it('publishes no hidden slot marker on any of them', () => {
    for (const producer of ['typescript', 'python', 'go']) {
      expect(Object.keys(publishedForProducer(producer)).some(key => key.startsWith('__repovine'))).toBe(false);
    }
  });

  it('gives a projected entrypoint the same canonical shape as a hint-derived one', () => {
    const fromHint = publishedForProducer('typescript');
    const module = moduleWithRoute('go');
    const projected = toEntrypointFragment({
      kind: 'api-route',
      moduleRef: { type: 'module', moduleId: MODULE_ID },
      path: '/checkout',
      method: 'POST',
    });
    // The projected arm carries no route hint: the entrypoint arrives through the SDK contract, the
    // road an installed plugin uses.
    const projectedModule: ModuleInfo = { ...module, semanticHints: undefined };
    const { items } = collectEntrypoints(runtime(projectedModule, [projected]), {});

    expect(items).toHaveLength(1);
    expect(canonicalShape(items[0]!)).toEqual(canonicalShape(fromHint));
  });
});
