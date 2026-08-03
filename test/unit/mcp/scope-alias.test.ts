import { describe, it, expect } from '@jest/globals';
import { createEmptyGraph, addNode } from '../../../src/graph/index.js';
import {
  resolvePackageId,
  resolveResourceInfraAlias,
  resolveScope,
} from '../../../src/mcp/scope/resolve.js';
import type { McpToolRuntime } from '../../../src/mcp/types.js';
import type { RepositoryGraph } from '../../../src/types.js';

type PkgSpec = string | { name: string; plugin?: string };

function graphWithPackages(specs: PkgSpec[]): RepositoryGraph {
  const g = createEmptyGraph();
  for (const spec of specs) {
    const name = typeof spec === 'string' ? spec : spec.name;
    const plugin = typeof spec === 'string' ? 'typescript' : spec.plugin ?? 'typescript';
    addNode(g, {
      id: `pkg:${name}`,
      type: 'package',
      label: name,
      description: '',
      data: { sourcePluginId: plugin },
    });
  }
  return g;
}

function ctxFor(graph: RepositoryGraph): McpToolRuntime {
  return {
    getState: () => ({ graph, modulesById: new Map(), domainsConfig: undefined }),
  } as unknown as McpToolRuntime;
}

describe('package scope alias: mechanical name noise', () => {
  it('resolves pkg:backend to a scope-only npm name @backend', () => {
    const g = graphWithPackages(['@backend', '@frontend']);
    expect(resolvePackageId(g, 'pkg:backend')).toBe('pkg:@backend');
  });

  it('resolves the reverse direction: pkg:@shared to a bare name shared', () => {
    const g = graphWithPackages(['shared', 'other']);
    expect(resolvePackageId(g, 'pkg:@shared')).toBe('pkg:shared');
  });

  it('treats -, _ and . as interchangeable for python packages (PEP 503)', () => {
    const g = graphWithPackages([{ name: 'my-package', plugin: 'python' }]);
    expect(resolvePackageId(g, 'pkg:my_package')).toBe('pkg:my-package');
    expect(resolvePackageId(g, 'pkg:My.Package')).toBe('pkg:my-package');
  });

  it('does NOT cross-match separators for npm/TS packages (ecosystem isolation)', () => {
    // In npm, foo.bar and foo-bar are distinct identities — python mechanics must not leak.
    const g = graphWithPackages(['lodash.merge', 'foo-bar']);
    expect(resolvePackageId(g, 'pkg:lodash-merge')).toBeUndefined();
    expect(resolvePackageId(g, 'pkg:foo_bar')).toBeUndefined();
    expect(resolvePackageId(g, 'pkg:lodash.merge')).toBe('pkg:lodash.merge');
  });

  it('prefers the literal match when both literal and relaxed candidates exist', () => {
    const g = graphWithPackages(['backend', '@backend']);
    expect(resolvePackageId(g, 'pkg:backend')).toBe('pkg:backend');
  });

  it('stays unresolved when relaxation is ambiguous', () => {
    const g = graphWithPackages([
      { name: 'my-pkg', plugin: 'python' },
      { name: 'my_pkg', plugin: 'python' },
    ]);
    expect(resolvePackageId(g, 'pkg:my.pkg')).toBeUndefined();
  });

  it('keeps the existing strict suffix alias working', () => {
    const g = graphWithPackages(['@acme/client-ui']);
    expect(resolvePackageId(g, 'pkg:client-ui')).toBe('pkg:@acme/client-ui');
  });

  it('resolves a scoped suffix typed with a stray leading @', () => {
    const g = graphWithPackages(['@acme/client-ui']);
    expect(resolvePackageId(g, 'pkg:@client-ui')).toBe('pkg:@acme/client-ui');
  });
});

describe('resource/infra scope alias', () => {
  function graphWithResources(): RepositoryGraph {
    const g = createEmptyGraph();
    addNode(g, { id: 'resource:aws-lambda:TenantSecretsFn', type: 'runtime-resource', label: 'TenantSecretsFn', description: '' });
    addNode(g, { id: 'resource:aws-sqs:JobsQueue', type: 'runtime-resource', label: 'JobsQueue', description: '' });
    addNode(g, { id: 'mod:app/worker', type: 'module', label: 'worker', description: '' });
    addNode(g, { id: 'export:app/worker/run', type: 'export-symbol', label: 'run', description: '' });
    // IaC infra nodes are stored with graph type 'module'; the id prefix marks them.
    addNode(g, { id: 'infra:dockerfile:services/api/Dockerfile', type: 'module', label: 'Dockerfile', description: '' });
    return g;
  }

  it('resolves the bare resource name without the provider infix', () => {
    const g = graphWithResources();
    expect(resolveResourceInfraAlias(g, 'resource:TenantSecretsFn')).toBe('resource:aws-lambda:TenantSecretsFn');
  });

  it('resolves case-only mismatches of the full id', () => {
    const g = graphWithResources();
    expect(resolveResourceInfraAlias(g, 'resource:aws-lambda:tenantsecretsfn')).toBe('resource:aws-lambda:TenantSecretsFn');
  });

  it('stays unresolved when the bare name is ambiguous', () => {
    const g = graphWithResources();
    addNode(g, { id: 'resource:k8s:_/Deployment/TenantSecretsFn', type: 'runtime-resource', label: 'TenantSecretsFn', description: '' });
    expect(resolveResourceInfraAlias(g, 'resource:TenantSecretsFn')).toBeUndefined();
  });

  it('does not cross node types: infra: alias never matches a runtime resource', () => {
    const g = graphWithResources();
    expect(resolveResourceInfraAlias(g, 'infra:TenantSecretsFn')).toBeUndefined();
    expect(resolveResourceInfraAlias(g, 'infra:Dockerfile')).toBe('infra:dockerfile:services/api/Dockerfile');
  });

  it('resolveScope returns the aliased node with the right kind', () => {
    const g = graphWithResources();
    const scope = resolveScope(ctxFor(g), 'resource:JobsQueue');
    expect(scope).toMatchObject({ kind: 'runtime-resource', nodeId: 'resource:aws-sqs:JobsQueue', resolvedScope: 'resource:aws-sqs:JobsQueue' });
  });

  it('resolveScope still reports unknown for a real miss', () => {
    const g = graphWithResources();
    const scope = resolveScope(ctxFor(g), 'resource:NoSuchThing');
    expect(scope.kind).toBe('unknown');
  });

  it('does not resolve legacy cap: or service: prefixes as graph scopes', () => {
    const g = graphWithResources();

    const legacyExport = resolveScope(ctxFor(g), 'cap:app/worker/run');
    expect(legacyExport).toMatchObject({
      raw: 'cap:app/worker/run',
      resolvedScope: 'query:cap:app/worker/run',
      kind: 'query',
      query: 'cap:app/worker/run',
    });
    expect(legacyExport.nodeId).toBeUndefined();

    const legacyResource = resolveScope(ctxFor(g), 'service:JobsQueue');
    expect(legacyResource).toMatchObject({
      raw: 'service:JobsQueue',
      resolvedScope: 'query:service:JobsQueue',
      kind: 'query',
      query: 'service:JobsQueue',
    });
    expect(legacyResource.nodeId).toBeUndefined();
  });
});

describe('resolveScope package integration', () => {
  it('pkg:backend resolves to pkg:@backend end-to-end', () => {
    const g = graphWithPackages(['@backend']);
    const scope = resolveScope(ctxFor(g), 'pkg:backend');
    expect(scope).toMatchObject({ kind: 'package', packageId: 'pkg:@backend' });
  });
});
