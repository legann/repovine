import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPluginSet } from '../../src/plugin-host/load.js';
import {
  buildDeclarationCatalog,
  catalogResourceKindMeta,
  catalogRuntimeActionNamespace,
  catalogTriggerTypeMeta,
  declarationCatalogIdentity,
} from '../../src/plugin-host/declaration-catalog.js';
import { pluginRuntimeIdentity } from '../../src/plugin-host/runtime.js';
import type { StampedDeclarationCatalog } from '@repovine/plugin-sdk';

/**
 * Law: a build's declarations are that build's, and a conflict is refused rather than resolved.
 *
 * Two failures this guards. The first is accumulation: a plugin loaded once used to leave its
 * metadata in a process-global map that no later build cleared, so a long-lived MCP server answered
 * a default build with an external plugin's facts. The second is last-write-wins: two plugins
 * claiming one key used to be settled by whichever was read first, which makes config order a
 * semantic input.
 */

const owner = (pluginId: string, packageVersion = '1.0.0'): StampedDeclarationCatalog['dirs'][number]['declaredBy'] =>
  ({ pluginId, packageName: `repovine-plugin-${pluginId}`, packageVersion });

function catalogOf(entries: Partial<StampedDeclarationCatalog>): StampedDeclarationCatalog {
  return {
    dirs: entries.dirs ?? [],
    values: entries.values ?? [],
    resourceKinds: entries.resourceKinds ?? [],
    triggerTypes: entries.triggerTypes ?? [],
    runtimeActions: entries.runtimeActions ?? [],
  };
}

const EDGE_FN = { namespace: 'edge', provider: 'edge', kind: 'edge-fn' };
const EDGE_HTTP = { type: 'edge-http', namespace: 'edge', provider: 'edge' };

describe('core-laws plugin declaration lifecycle (per-run catalog, no last-write-wins)', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function makeRepoWithPlugin(name: string, manifest: unknown, indexJs: string): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-decl-law-'));
    tmpRoots.push(repoRoot);
    const pkgDir = path.join(repoRoot, 'node_modules', name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name, version: '2.3.4', type: 'module', main: 'index.js', repovine: manifest,
    }));
    fs.writeFileSync(path.join(pkgDir, 'index.js'), indexJs);
    return repoRoot;
  }

  const IAC_PLUGIN_JS = `export default {
    id: 'edge',
    capabilities: {
      iac: { parsers: [{ kind: 'edge-infra', supports() { return false; }, parse() { return null; } }] },
    },
  };`;

  const EDGE_MANIFEST = {
    kind: 'plugin',
    id: 'edge',
    apiVersion: 1,
    entry: 'index.js',
    declarations: {
      ecosystem: 'edge',
      dirs: [{ name: '.edge-out', role: 'tool-output', because: 'edge build artifacts' }],
      resourceKinds: [{ namespace: 'edge', provider: 'edge', kind: 'edge-fn', hasCodeHandler: true }],
      triggerTypes: [{ type: 'edge-http', namespace: 'edge', provider: 'edge', entrypointKind: 'api' }],
    },
  };

  // GATE 4: an external build followed by a default build agrees with a cold default build.
  it('leaves nothing behind for the next build in the same process', async () => {
    const repoRoot = makeRepoWithPlugin('repovine-plugin-edge', EDGE_MANIFEST, IAC_PLUGIN_JS);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-decl-law-bare-'));
    tmpRoots.push(bare);

    // Cold default build, before any external plugin was ever loaded in this process.
    const cold = await loadPluginSet({ repoRoot: bare, config: { defaults: true, add: [], disable: [] } });

    const external = await loadPluginSet({
      repoRoot, config: { defaults: true, add: ['repovine-plugin-edge'], disable: [] },
    });
    expect(external.refused).toEqual([]);
    expect(catalogResourceKindMeta(external.runtime.catalog, EDGE_FN)).toEqual({ hasCodeHandler: true });

    // Default build again, in the same process, right after the external one.
    const after = await loadPluginSet({ repoRoot: bare, config: { defaults: true, add: [], disable: [] } });

    expect(declarationCatalogIdentity(after.runtime.catalog))
      .toEqual(declarationCatalogIdentity(cold.runtime.catalog));
    expect(pluginRuntimeIdentity(after.runtime)).toEqual(pluginRuntimeIdentity(cold.runtime));
    expect(catalogResourceKindMeta(after.runtime.catalog, EDGE_FN)).toBeUndefined();
    expect(catalogTriggerTypeMeta(after.runtime.catalog, EDGE_HTTP)).toBeUndefined();
  });

  it('is decided by the declaration set, not by the order plugins were read', () => {
    const first = catalogOf({
      resourceKinds: [{ namespace: 'a', provider: 'a', kind: 'queue', hasCodeHandler: false, declaredBy: owner('a') }],
    });
    const second = catalogOf({
      resourceKinds: [{ namespace: 'b', provider: 'b', kind: 'topic', hasCodeHandler: true, declaredBy: owner('b') }],
    });

    const forward = buildDeclarationCatalog({ catalogs: [first, second] });
    const reverse = buildDeclarationCatalog({ catalogs: [second, first] });
    expect(declarationCatalogIdentity(reverse)).toEqual(declarationCatalogIdentity(forward));
  });

  it('merges an identical declaration from two plugins and keeps both owners', () => {
    const dir = { name: 'dist', role: 'build-output' as const, because: 'compiler output' };
    const catalog = buildDeclarationCatalog({
      catalogs: [
        catalogOf({ dirs: [{ ...dir, declaredBy: owner('a') }] }),
        catalogOf({ dirs: [{ ...dir, declaredBy: owner('b') }] }),
      ],
    });

    expect(catalog.conflicts).toEqual([]);
    expect(catalog.dirs).toHaveLength(1);
    expect(catalog.dirs[0]!.declarations.map(d => d.declaredBy.pluginId)).toEqual(['a', 'b']);
  });

  it('refuses both sides when two plugins claim one key with different effects', () => {
    const catalog = buildDeclarationCatalog({
      catalogs: [
        catalogOf({ dirs: [{ name: 'out', role: 'build-output', because: 'compiler output', declaredBy: owner('a') }] }),
        catalogOf({ dirs: [{ name: 'out', role: 'tool-output', because: 'tool state', declaredBy: owner('b') }] }),
      ],
    });

    expect(catalog.dirs).toEqual([]);
    expect(catalog.conflicts).toHaveLength(1);
    expect(catalog.conflicts[0]!.sides.map(side => side.declaredBy.pluginId)).toEqual(['a', 'b']);
  });

  it('keeps one kind name declared by two ecosystems apart, and answers each on its own key', () => {
    const catalog = buildDeclarationCatalog({
      catalogs: [
        catalogOf({ resourceKinds: [{ namespace: 'a', provider: 'a', kind: 'queue', hasCodeHandler: true, declaredBy: owner('a') }] }),
        catalogOf({ resourceKinds: [{ namespace: 'b', provider: 'b', kind: 'queue', hasCodeHandler: false, declaredBy: owner('b') }] }),
      ],
    });

    // `queue`, `function` and `service` recur across ecosystems. The composite key is what lets both
    // stand, and each lookup answers from its own namespace and provider.
    expect(catalog.conflicts).toEqual([]);
    expect(catalog.resourceKinds).toHaveLength(2);
    expect(catalogResourceKindMeta(catalog, { namespace: 'a', provider: 'a', kind: 'queue' }))
      .toEqual({ hasCodeHandler: true });
    expect(catalogResourceKindMeta(catalog, { namespace: 'b', provider: 'b', kind: 'queue' }))
      .toEqual({ hasCodeHandler: false });
    expect(catalogResourceKindMeta(catalog, { namespace: 'c', provider: 'c', kind: 'queue' })).toBeUndefined();
  });

  it('keeps one kind name apart when a single ecosystem mints it in two namespaces', () => {
    const catalog = buildDeclarationCatalog({
      catalogs: [
        catalogOf({ resourceKinds: [{ namespace: 'a-fast', provider: 'a', kind: 'queue', hasCodeHandler: true, declaredBy: owner('a') }] }),
        catalogOf({ resourceKinds: [{ namespace: 'a-slow', provider: 'a', kind: 'queue', hasCodeHandler: false, declaredBy: owner('a') }] }),
      ],
    });

    // Provider and kind alone do not separate these: the namespace is the identity domain that
    // reaches the minted id, and it is what keeps one ecosystem's two queues apart.
    expect(catalog.conflicts).toEqual([]);
    expect(catalogResourceKindMeta(catalog, { namespace: 'a-fast', provider: 'a', kind: 'queue' }))
      .toEqual({ hasCodeHandler: true });
    expect(catalogResourceKindMeta(catalog, { namespace: 'a-slow', provider: 'a', kind: 'queue' }))
      .toEqual({ hasCodeHandler: false });
  });

  it('answers a trigger declared for a provider from every namespace that provider mints', () => {
    const catalog = buildDeclarationCatalog({
      catalogs: [
        catalogOf({ triggerTypes: [{ type: 'schedule', provider: 'a', entrypointKind: 'schedule', declaredBy: owner('a') }] }),
        catalogOf({ triggerTypes: [{ type: 'schedule', provider: 'b', entrypointKind: 'api', declaredBy: owner('b') }] }),
      ],
    });

    expect(catalog.conflicts).toEqual([]);
    expect(catalogTriggerTypeMeta(catalog, { type: 'schedule', namespace: 'a-queues', provider: 'a' }))
      .toEqual({ entrypointKind: 'schedule' });
    expect(catalogTriggerTypeMeta(catalog, { type: 'schedule', namespace: 'a-functions', provider: 'a' }))
      .toEqual({ entrypointKind: 'schedule' });
    expect(catalogTriggerTypeMeta(catalog, { type: 'schedule', provider: 'b' }))
      .toEqual({ entrypointKind: 'api' });
  });

  it('refuses both sides when two plugins send one runtime action to different namespaces', () => {
    const agree = buildDeclarationCatalog({
      catalogs: [
        catalogOf({ runtimeActions: [{ action: 'q.send', namespace: 'a-queues', declaredBy: owner('a') }] }),
        catalogOf({ runtimeActions: [{ action: 'q.send', namespace: 'a-queues', declaredBy: owner('b') }] }),
      ],
    });
    expect(catalogRuntimeActionNamespace(agree, 'q.send')).toBe('a-queues');

    const disagree = buildDeclarationCatalog({
      catalogs: [
        catalogOf({ runtimeActions: [{ action: 'q.send', namespace: 'a-queues', declaredBy: owner('a') }] }),
        catalogOf({ runtimeActions: [{ action: 'q.send', namespace: 'b-queues', declaredBy: owner('b') }] }),
      ],
    });
    expect(disagree.conflicts).toHaveLength(1);
    expect(catalogRuntimeActionNamespace(disagree, 'q.send')).toBeUndefined();
  });

  it('keeps declarations when a capability is disabled and drops them only on explicit retraction', async () => {
    const repoRoot = makeRepoWithPlugin('repovine-plugin-edge', EDGE_MANIFEST, IAC_PLUGIN_JS);

    // The parser capability is off; the pruning and metadata facts it shipped stay in force.
    const disabledParser = await loadPluginSet({
      repoRoot,
      config: { defaults: false, add: ['repovine-plugin-edge'], disable: [] },
    });
    expect(disabledParser.runtime.catalog.dirs.map(record => record.key)).toEqual(['dir:.edge-out']);
    expect(catalogResourceKindMeta(disabledParser.runtime.catalog, EDGE_FN)).toEqual({ hasCodeHandler: true });

    // An explicit retraction is the way to drop one, and it names what it removed.
    const retracted = await loadPluginSet({
      repoRoot,
      config: {
        defaults: true,
        add: ['repovine-plugin-edge'],
        disable: [],
        retract: ['dir:.edge-out', 'resource-kind:edge/edge/edge-fn'],
      },
    });
    // `defaults: true` brings the bundled plugins and the dirs they declare, so what the
    // retraction proves is that the named key left — not that nothing else is declared.
    expect(retracted.runtime.catalog.dirs.map(record => record.key)).not.toContain('dir:.edge-out');
    expect(catalogResourceKindMeta(retracted.runtime.catalog, EDGE_FN)).toBeUndefined();
    expect(retracted.runtime.catalog.retractions.map(r => r.removed)).toEqual([
      ['dir:.edge-out'],
      ['resource-kind:edge/edge/edge-fn'],
    ]);
    // The trigger type was not named, so it is untouched.
    expect(catalogTriggerTypeMeta(retracted.runtime.catalog, EDGE_HTTP)).toEqual({ entrypointKind: 'api' });
  });

  it('reports a retraction selector that matched nothing instead of ignoring it', () => {
    const catalog = buildDeclarationCatalog({ catalogs: [], retract: ['dir:never-declared'] });
    expect(catalog.retractions).toEqual([{ selector: 'dir:never-declared', removed: [] }]);
  });

  it('folds the catalog and the projector set into the reuse fingerprint input', () => {
    const base = buildDeclarationCatalog({ catalogs: [] });
    const withFact = buildDeclarationCatalog({
      catalogs: [catalogOf({ dirs: [{ name: 'out', role: 'build-output', because: 'x', declaredBy: owner('a') }] })],
    });
    expect(declarationCatalogIdentity(withFact)).not.toEqual(declarationCatalogIdentity(base));

    // A conflicting declaration produces a different build than an accepted one, so it moves the
    // identity too — otherwise a refused build could reuse an accepted build's snapshot.
    const conflicting = buildDeclarationCatalog({
      catalogs: [
        catalogOf({ dirs: [{ name: 'out', role: 'build-output', because: 'x', declaredBy: owner('a') }] }),
        catalogOf({ dirs: [{ name: 'out', role: 'tool-output', because: 'y', declaredBy: owner('b') }] }),
      ],
    });
    expect(declarationCatalogIdentity(conflicting)).not.toEqual(declarationCatalogIdentity(withFact));
  });
});
