import { describe, expect, it } from '@jest/globals';
import {
  ECOSYSTEM_DIR_ROLES,
  ENTRYPOINT_CONTRIBUTION_KINDS,
  PLUGIN_CAPABILITY_NAMES,
  PLUGIN_MANIFEST_KIND,
  PROJECTION_BUDGETS,
  PROJECTION_REF_TYPES,
  RESOURCE_ID_PREFIX,
  SEMANTIC_LINK_RELATIONS,
  TRIGGER_ENTRY_KINDS,
  checkPluginConformance,
  checkProjectionRefs,
  definePlugin,
  isJsonValue,
  makeResourceId,
  parseResourceId,
  resourceIdentityProblem,
  resourceKindMetaKey,
  stampDeclarationCatalog,
  validatePresetManifest,
  validateProjectionBatch,
  validatePluginManifest,
  validatePluginRuntimeDescriptor,
} from '@repovine/plugin-sdk';
import type {
  PluginProjectionBatch,
  ProjectionContributor,
  ReadonlyModuleFact,
} from '@repovine/plugin-sdk';
import { ENTRYPOINT_SCHEMA_KINDS } from '../../packages/plugin-sdk/src/plugin/projection-schema.js';

// The public plugin contract, checked at its two boundaries: what a package declares before any of
// its code runs (manifest + declarations) and what its code returns once it does (descriptor +
// projection batches). Every case here is something an untrusted package can actually ship.

const MODULES: ReadonlyModuleFact[] = [
  { moduleId: 'mod:app/index', packageName: 'app', relativeFilePath: 'src/index.ts' },
];

function projectorOf(batches: readonly unknown[]): ProjectionContributor {
  return { id: 'p', project: () => batches as readonly PluginProjectionBatch[] };
}

function descriptorWith(projector: ProjectionContributor): unknown {
  return definePlugin({ id: 'demo', capabilities: { projectors: [projector] } });
}

const MANIFEST = { kind: PLUGIN_MANIFEST_KIND, id: 'demo', apiVersion: 1 };

describe('plugin manifest', () => {
  it('accepts the one transport kind and both JSON spellings of the api version', () => {
    for (const apiVersion of [1, '1']) {
      const result = validatePluginManifest({ ...MANIFEST, apiVersion });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.manifest.apiVersion).toBe(1);
    }
  });

  it.each([
    ['a capability-shaped kind', { ...MANIFEST, kind: 'source-plugin' }, /kind/],
    ['a missing id', { kind: PLUGIN_MANIFEST_KIND, apiVersion: 1 }, /id/],
    ['an id carrying a key delimiter', { ...MANIFEST, id: 'demo:evil' }, /id must match/],
    ['an incompatible major', { ...MANIFEST, apiVersion: 2 }, /apiVersion 2 is incompatible/],
    ['an unknown field', { ...MANIFEST, trusted: true }, /trusted/],
  ])('refuses %s', (_name, manifest, expected) => {
    const result = validatePluginManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(expected);
  });

  it.each([
    ['an escaping segment', '../outside/index.js', /".." segment/],
    ['an absolute path', '/etc/passwd', /must not start with "\/"/],
    ['a drive letter', 'C:/plugin/index.js', /drive letter/],
    ['a Windows separator', 'dist\\index.js', /POSIX path/],
    ['a dot segment', './dist/index.js', /"." segment/],
  ])('refuses an entry with %s', (_name, entry, expected) => {
    const result = validatePluginManifest({ ...MANIFEST, entry });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(expected);
  });

  it('parses a valid entry into segments the host joins itself', () => {
    const result = validatePluginManifest({ ...MANIFEST, entry: 'dist/plugin/index.js' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entrySegments).toEqual(['dist', 'plugin', 'index.js']);
  });
});

describe('declaration catalog', () => {
  const catalog = {
    ecosystem: 'demo',
    dirs: [{ name: '.demo-out', role: 'tool-output' as const, because: 'demo build output' }],
    values: [{ axis: 'demo/framework', value: 'demoframework', because: 'demo web framework' }],
    resourceKinds: [{ namespace: 'demo', provider: 'demo', kind: 'queue', hasCodeHandler: false }],
    triggerTypes: [{ type: 'demo-http', namespace: 'demo', entrypointKind: 'api' as const }],
  };

  it('names only roles the host knows how to act on', () => {
    expect([...ECOSYSTEM_DIR_ROLES]).toEqual(['dependencies', 'build-output', 'tool-output', 'test-layout']);
    const result = validatePluginManifest({
      ...MANIFEST,
      declarations: { dirs: [{ name: 'x', role: 'whatever', because: 'why' }] },
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a directory fact with no stated reason', () => {
    const result = validatePluginManifest({
      ...MANIFEST,
      declarations: { dirs: [{ name: '.demo-out', role: 'tool-output' }] },
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a payload that claims its own owner', () => {
    const result = validatePluginManifest({
      ...MANIFEST,
      declarations: {
        dirs: [{ ...catalog.dirs[0]!, declaredBy: { pluginId: 'typescript', packageName: 'x', packageVersion: '1' } }],
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/declaredBy/);
  });

  it('stamps one owner onto every entry', () => {
    const owner = { pluginId: 'demo', packageName: 'repovine-plugin-demo', packageVersion: '1.2.3' };
    const stamped = stampDeclarationCatalog(catalog, owner);
    const entries = [...stamped.dirs, ...stamped.values, ...stamped.resourceKinds, ...stamped.triggerTypes];
    expect(entries).toHaveLength(4);
    for (const entry of entries) expect(entry.declaredBy).toEqual(owner);
  });

  it('keeps one kind per provider apart in the metadata key', () => {
    const aws = { namespace: 'aws', provider: 'aws', kind: 'queue' };
    const gcp = { namespace: 'gcp', provider: 'gcp', kind: 'queue' };
    expect(resourceKindMetaKey(aws)).not.toBe(resourceKindMetaKey(gcp));
    expect(resourceKindMetaKey(aws)).toBe(resourceKindMetaKey({ ...aws }));
    // A separator inside `kind` cannot make two different triples spell one key.
    expect(resourceKindMetaKey({ namespace: 'a', provider: 'b', kind: 'c d' }))
      .not.toBe(resourceKindMetaKey({ namespace: 'a', provider: 'b c', kind: 'd' }));
  });

  it('accepts every trigger entry kind the host projects', () => {
    for (const entrypointKind of TRIGGER_ENTRY_KINDS) {
      const result = validatePluginManifest({
        ...MANIFEST,
        declarations: { triggerTypes: [{ type: 'demo-t', entrypointKind }] },
      });
      expect(result.ok).toBe(true);
    }
  });
});

describe('runtime descriptor', () => {
  it('names every capability it declares, in contract order', () => {
    const result = validatePluginRuntimeDescriptor(definePlugin({
      id: 'demo',
      capabilities: {
        source: {
          discover: () => ({ packages: [], pendingByPath: new Map() }),
          extract: () => ({ deltas: [], reused: 0, rescanned: 0 }),
        },
        iac: { parsers: [{ kind: 'demo', loaderId: 'demo-json', supports: () => false, parse: () => null }] },
        loaders: [{ id: 'demo-json', load: () => [] }],
        projectors: [projectorOf([])],
      },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.declared).toEqual([...PLUGIN_CAPABILITY_NAMES]);
  });

  it.each([
    ['a non-object export', 'not-a-descriptor', /not a plugin descriptor/],
    ['no capability at all', { id: 'demo', capabilities: {} }, /no capability/],
    ['a source capability without extract', { id: 'demo', capabilities: { source: { discover: () => ({}) } } }, /discover\(\) and extract\(\)/],
    ['an empty IaC parser list', { id: 'demo', capabilities: { iac: { parsers: [] } } }, /non-empty parsers/],
    ['a projector without project()', { id: 'demo', capabilities: { projectors: [{ id: 'p' }] } }, /missing project/],
  ])('refuses %s', (_name, descriptor, expected) => {
    const result = validatePluginRuntimeDescriptor(descriptor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(expected);
  });
});

describe('projection batches', () => {
  const resource = {
    namespace: 'demo',
    localKey: 'queue/orders',
    provider: 'demo',
    kind: 'queue',
    contentHash: 'abc123',
  };

  it('accepts a batch that states resources, links, entrypoints and extensions', () => {
    const result = validateProjectionBatch({
      batchId: 'stack.json',
      delta: {
        resources: [resource],
        links: [{
          from: { type: 'module', moduleId: 'mod:app/index' },
          to: { type: 'resource', namespace: 'demo', localKey: 'queue/orders' },
          relation: 'publishes',
        }],
        entrypoints: [{ kind: 'api-route', moduleRef: { type: 'module', moduleId: 'mod:app/index' }, path: '/o', method: 'GET' }],
        extensions: [{ schema: 'demo/stack@1', localKey: 'orders', payload: { retries: 3 } }],
      },
    }, { pluginId: 'demo' });
    expect(result.ok).toBe(true);
  });

  it('publishes exactly the reference forms the schema accepts', () => {
    expect([...PROJECTION_REF_TYPES]).toEqual(['module', 'resource', 'extension']);
    const raw = validateProjectionBatch({
      batchId: 'b',
      delta: {
        links: [{
          from: { type: 'node', id: 'resource:demo:queue/orders' },
          to: { type: 'module', moduleId: 'mod:app/index' },
          relation: 'consumes',
        }],
      },
    });
    expect(raw.ok).toBe(false);
  });

  it('refuses a minted node id where an identity component belongs', () => {
    const result = validateProjectionBatch({
      batchId: 'b',
      delta: { resources: [{ ...resource, localKey: makeResourceId({ namespace: 'demo', localKey: 'queue/orders' }) }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a minted node id/);
  });

  it('refuses an extension published under another owner', () => {
    const batch = {
      batchId: 'b',
      delta: { extensions: [{ schema: 'typescript/routes@1', localKey: 'k', payload: {} }] },
    };
    expect(validateProjectionBatch(batch, { pluginId: 'demo' }).ok).toBe(false);
    // Ownership is only checkable when the caller says who is contributing.
    expect(validateProjectionBatch(batch).ok).toBe(true);
  });

  it('refuses an unknown field and a relation with no canonical meaning', () => {
    expect(validateProjectionBatch({ batchId: 'b', delta: { resources: [{ ...resource, trusted: true }] } }).ok).toBe(false);
    expect(validateProjectionBatch({
      batchId: 'b',
      delta: {
        links: [{
          from: { type: 'module', moduleId: 'm' },
          to: { type: 'module', moduleId: 'n' },
          relation: 'sort-of-related',
        }],
      },
    }).ok).toBe(false);
    expect([...SEMANTIC_LINK_RELATIONS]).toContain('publishes');
  });

  // The overflow sizes are pinned here, not read from PROJECTION_BUDGETS. A test that sized its
  // input from the same constant the validator enforces would stay green for any ceiling and prove
  // only that the two agree.
  const PINNED_BUDGETS = { maxResourcesPerBatch: 2_000, maxExtensionPayloadChars: 65_536 };

  it('publishes the budgets it enforces', () => {
    expect(PROJECTION_BUDGETS.maxResourcesPerBatch).toBe(PINNED_BUDGETS.maxResourcesPerBatch);
    expect(PROJECTION_BUDGETS.maxExtensionPayloadChars).toBe(PINNED_BUDGETS.maxExtensionPayloadChars);
  });

  it('refuses a delta over budget', () => {
    const atCeiling = Array.from({ length: PINNED_BUDGETS.maxResourcesPerBatch }, (_, i) => ({
      ...resource,
      localKey: `queue/${i}`,
    }));
    expect(validateProjectionBatch({ batchId: 'b', delta: { resources: atCeiling } }).ok).toBe(true);
    expect(validateProjectionBatch({
      batchId: 'b',
      delta: { resources: [...atCeiling, { ...resource, localKey: 'queue/over' }] },
    }).ok).toBe(false);

    const huge = 'x'.repeat(PINNED_BUDGETS.maxExtensionPayloadChars + 1);
    expect(validateProjectionBatch({
      batchId: 'b',
      delta: { extensions: [{ schema: 'demo/stack@1', localKey: 'k', payload: { huge } }] },
    }).ok).toBe(false);
  });

  it('refuses a payload that is not JSON', () => {
    expect(isJsonValue({ ok: [1, 'two', null] })).toBe(true);
    expect(isJsonValue({ fn: () => 1 })).toBe(false);
    expect(validateProjectionBatch({
      batchId: 'b',
      delta: { extensions: [{ schema: 'demo/stack@1', localKey: 'k', payload: { when: new Date() } }] },
    }).ok).toBe(false);
  });

  it('validates every canonical entrypoint kind the contract publishes', () => {
    // Two independently written lists: the DTO union a consumer types against, and the
    // discriminators the validator accepts.
    expect([...ENTRYPOINT_CONTRIBUTION_KINDS].sort()).toEqual([...ENTRYPOINT_SCHEMA_KINDS].sort());
  });
});

describe('reference resolution', () => {
  const accepted = (batch: unknown, contributorId = 'p') => ({
    pluginId: 'demo',
    contributorId,
    batch: batch as PluginProjectionBatch,
  });

  it('resolves a reference to a contribution made by a later contributor', () => {
    const consumer = accepted({
      batchId: 'first',
      delta: {
        links: [{
          from: { type: 'module', moduleId: 'mod:app/index' },
          to: { type: 'resource', namespace: 'demo', localKey: 'queue/orders' },
          relation: 'publishes',
        }],
      },
    }, 'early');
    const producer = accepted({
      batchId: 'second',
      delta: {
        resources: [{
          namespace: 'demo',
          localKey: 'queue/orders',
          provider: 'demo',
          kind: 'queue',
          contentHash: 'h',
        }],
      },
    }, 'late');
    const knownModuleIds = new Set(MODULES.map(m => m.moduleId));

    // Registration order is not an input: both orders resolve identically.
    expect(checkProjectionRefs({ accepted: [consumer, producer], knownModuleIds })).toEqual([]);
    expect(checkProjectionRefs({ accepted: [producer, consumer], knownModuleIds })).toEqual([]);
  });

  it('names the owner of a dangling reference', () => {
    const problems = checkProjectionRefs({
      accepted: [accepted({
        batchId: 'b',
        delta: {
          entrypoints: [{
            kind: 'api-route',
            moduleRef: { type: 'module', moduleId: 'mod:nowhere/absent' },
            path: '/x',
            method: 'GET',
          }],
        },
      })],
      knownModuleIds: new Set(MODULES.map(m => m.moduleId)),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ pluginId: 'demo', contributorId: 'p', batchId: 'b', reason: 'unknown-module' });
  });

  it('refuses a reference to an extension owned by a plugin that contributed none', () => {
    const problems = checkProjectionRefs({
      accepted: [accepted({
        batchId: 'b',
        delta: {
          extensions: [{
            schema: 'demo/stack@1',
            localKey: 'k',
            subjectRef: { type: 'extension', pluginId: 'typescript', schema: 'typescript/routes@1', localKey: 'r' },
            payload: {},
          }],
        },
      })],
      knownModuleIds: new Set(),
    });
    expect(problems.map(p => p.reason)).toEqual(['unknown-extension']);
  });
});

describe('resource identity', () => {
  // The ids annotations are keyed on. Encoding is identity on all of them, byte for byte.
  it.each([
    ['resource:aws-lambda:OrdersApi', 'aws-lambda', 'OrdersApi'],
    ['resource:k8s:default/Deployment/web', 'k8s', 'default/Deployment/web'],
    ['resource:k8s:_/StatefulSet/db', 'k8s', '_/StatefulSet/db'],
    ['resource:vercel:function:api/hello', 'vercel', 'function:api/hello'],
    ['resource:generic:examples/agent-harness-demo/Dockerfile', 'generic', 'examples/agent-harness-demo/Dockerfile'],
  ])('mints and recovers %s', (id, namespace, localKey) => {
    expect(makeResourceId({ namespace, localKey })).toBe(id);
    expect(parseResourceId(id)).toEqual({ namespace, localKey });
    expect(id.startsWith(`${RESOURCE_ID_PREFIX}:`)).toBe(true);
  });

  it('is injective: two identities never mint one id', () => {
    const pairs = [
      { namespace: 'a', localKey: 'b:c' },
      { namespace: 'a', localKey: 'b' },
      { namespace: 'a-b', localKey: 'c' },
      { namespace: 'a', localKey: 'b/c' },
    ];
    const ids = pairs.map(makeResourceId);
    expect(new Set(ids).size).toBe(pairs.length);
    for (const pair of pairs) expect(parseResourceId(makeResourceId(pair))).toEqual(pair);
  });

  it('refuses an identity that would make the id ambiguous or unreadable', () => {
    expect(resourceIdentityProblem({ namespace: 'aws:lambda', localKey: 'X' })).toMatch(/namespace must match/);
    expect(resourceIdentityProblem({ namespace: 'aws', localKey: '' })).toMatch(/non-empty/);
    expect(resourceIdentityProblem({ namespace: 'aws', localKey: 'a\nb' })).toMatch(/control characters/);
    expect(() => makeResourceId({ namespace: 'aws/lambda', localKey: 'X' })).toThrow();
    expect(parseResourceId('mod:app/index')).toBeUndefined();
    expect(parseResourceId('resource:aws-lambda:')).toBeUndefined();
  });
});

describe('conformance kit', () => {
  const honest = definePlugin({
    id: 'demo',
    capabilities: {
      projectors: [{
        id: 'demo-projector',
        project: () => [{
          batchId: 'one',
          delta: { extensions: [{ schema: 'demo/stack@1', localKey: 'k', payload: { a: 1 } }] },
        }],
      }],
    },
  });

  it('passes a plugin whose manifest, descriptor and batches agree', () => {
    const report = checkPluginConformance({ manifest: MANIFEST, descriptor: honest, modules: MODULES });
    expect(report.checks.filter(c => !c.ok)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('fails when the descriptor claims an id the manifest does not', () => {
    const report = checkPluginConformance({
      manifest: { ...MANIFEST, id: 'other' },
      descriptor: honest,
      modules: MODULES,
    });
    expect(report.passed).toBe(false);
    expect(report.checks.find(c => !c.ok)?.name).toMatch(/id/);
  });

  it.each([
    ['an invalid batch', [{ batchId: 'b', delta: { resources: [{ namespace: 'demo' }] } }]],
    ['duplicate batch ids', [{ batchId: 'b', delta: {} }, { batchId: 'b', delta: {} }]],
    ['a dangling reference', [{
      batchId: 'b',
      delta: {
        links: [{
          from: { type: 'module', moduleId: 'mod:nowhere/absent' },
          to: { type: 'module', moduleId: 'mod:app/index' },
          relation: 'consumes',
        }],
      },
    }]],
  ])('fails a plugin that emits %s', (_name, batches) => {
    const report = checkPluginConformance({
      manifest: MANIFEST,
      descriptor: descriptorWith(projectorOf(batches)),
      modules: MODULES,
    });
    expect(report.passed).toBe(false);
  });

  it('fails a projector whose output changes between identical runs', () => {
    let calls = 0;
    const report = checkPluginConformance({
      manifest: MANIFEST,
      descriptor: descriptorWith({
        id: 'drifting',
        project: () => [{ batchId: `run-${calls++}`, delta: {} }],
      }),
      modules: MODULES,
    });
    expect(report.passed).toBe(false);
    expect(report.checks.find(c => !c.ok)?.name).toMatch(/deterministic/);
  });
});

describe('preset manifest', () => {
  const PRESET = {
    kind: 'preset',
    id: 'default',
    apiVersion: 1,
    plugins: ['@repovine/plugin-source-typescript', '@repovine/plugin-iac-sam'],
  };

  it('accepts a preset that names its packages', () => {
    const validated = validatePresetManifest(PRESET);
    expect(validated.ok && validated.manifest.plugins).toEqual(PRESET.plugins);
  });

  it('refuses a plugin manifest read as a preset', () => {
    // Both schemas pin `kind` to a literal, so one package is readable as one transport and never
    // as both. Without that, a plugin package with a stray `plugins` array would be selected as a
    // preset and its own capabilities would never load.
    const validated = validatePresetManifest({
      kind: PLUGIN_MANIFEST_KIND,
      id: 'typescript',
      apiVersion: 1,
      plugins: ['@repovine/plugin-source-typescript'],
    });
    expect(validated.ok).toBe(false);
  });

  it('refuses a preset that names one package twice', () => {
    const validated = validatePresetManifest({ ...PRESET, plugins: [PRESET.plugins[0], PRESET.plugins[0]] });
    expect(validated.ok ? '' : validated.error).toMatch(/twice/);
  });

  it('refuses a preset on another api version', () => {
    const validated = validatePresetManifest({ ...PRESET, apiVersion: 2 });
    expect(validated.ok).toBe(false);
  });
});

describe('iac capability metadata', () => {
  const parser = { kind: 'brick', loaderId: 'yaml', supports: () => false, parse: () => null };

  it('accepts kind domains beside the parsers that emit those kinds', () => {
    const validated = validatePluginRuntimeDescriptor(definePlugin({
      id: 'brick',
      capabilities: {
        iac: {
          parsers: [parser],
          kindDomains: [{ kind: 'brick', meta: { domainId: 'domain:infra-brick', label: 'infra-brick', description: 'x' } }],
        },
      },
    }));
    expect(validated.ok && validated.declared).toEqual(['iac']);
  });

  it('refuses a kind domain with no domain id', () => {
    // The entry becomes a graph domain node. One with an undefined id mints a node nothing can
    // reference, which reads downstream as a domain that lost its members.
    const validated = validatePluginRuntimeDescriptor({
      id: 'brick',
      capabilities: {
        iac: { parsers: [parser], kindDomains: [{ kind: 'brick', meta: { label: 'infra-brick' } }] },
      },
    });
    expect(validated.ok ? '' : validated.error).toMatch(/domainId/);
  });

  it('refuses a kind domain with no kind', () => {
    const validated = validatePluginRuntimeDescriptor({
      id: 'brick',
      capabilities: {
        iac: {
          parsers: [parser],
          kindDomains: [{ meta: { domainId: 'domain:infra-brick', label: 'infra-brick' } }],
        },
      },
    });
    expect(validated.ok ? '' : validated.error).toMatch(/kind/);
  });
});
