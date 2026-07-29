import {
  applyDomainsKeep,
  applyDomainsSuggestion,
  collectSuffixLabels,
  collectSuffixHistogram,
  computeDomainsSuggestion,
} from '../../../src/stage2/domains-advisor.js';
import { addEdge, addNode, createEmptyGraph } from '../../../src/graph/index.js';
import type { InfraModuleInfo, ModuleInfo, RepositoryFactsSnapshot, RepositoryGraph } from '../../../src/types.js';

/**
 * Build a graph that materializes runtime-resource nodes for `allLabels` with the structural
 * `contains`/`tagged` edges every resource gets, and an extra load-bearing `uses_env` edge for the
 * `witnessed` subset. Mirrors how pass2Infra wires nodes (resource id `resource:aws:<id>` for the
 * `kind:'other', provider:'aws'` resources the test factory produces).
 */
function makeGraphWith(allLabels: string[], witnessed: string[]): RepositoryGraph {
  const graph = createEmptyGraph();
  for (const label of allLabels) {
    const id = `resource:aws:${label}`;
    addNode(graph, { id, type: 'runtime-resource', label, description: '' });
    addEdge(graph, 'infra:cloudformation:mod', id, 'contains');
    addEdge(graph, id, 'domain:infra-aws', 'tagged');
    if (witnessed.includes(label)) addEdge(graph, id, 'resource:aws:SomeSecret', 'uses_env');
  }
  return graph;
}

function makeMod(id: string, relativeFilePath: string): ModuleInfo {
  return {
    id,
    packageName: 'pkg',
    filePath: `/repo/${relativeFilePath}`,
    relativeFilePath,
    contentHash: id,
    imports: [],
    exports: [],
  };
}

function makeInfraModule(relativeFilePath: string, resourceIds: string[]): InfraModuleInfo {
  return {
    id: `infra:cloudformation:${relativeFilePath}`,
    kind: 'cloudformation',
    filePath: `/repo/${relativeFilePath}`,
    relativeFilePath,
    contentHash: relativeFilePath,
    resources: resourceIds.map(id => ({
      id,
      kind: 'other',
      provider: 'aws',
      identity: { namespace: 'aws', localKey: id },
      contentHash: id,
      attributes: {},
    })),
  };
}

function makeSnapshot(modules: ModuleInfo[] = [], infraModules: InfraModuleInfo[] = []): RepositoryFactsSnapshot {
  return {
    repoRoot: '/tmp/never-exists',
    timestamp: '2026-01-01',
    packages: [],
    modules,
    infraModules,
  };
}

describe('domains advisor', () => {
  it('collects suffix histogram before domain config exclusion', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/a.yaml', ['UsersAlarm', 'UsersLogGroup']),
      makeInfraModule('infrastructure/sam/b.yaml', ['OrdersAlarm', 'OrdersFunction']),
    ]);

    expect(collectSuffixHistogram(snapshot)).toEqual({ Alarm: 2, LogGroup: 1 });
    expect(collectSuffixLabels(snapshot)).toEqual({
      Alarm: ['OrdersAlarm', 'UsersAlarm'],
      LogGroup: ['UsersLogGroup'],
    });
  });

  it('dedups a resource id that appears in more than one infra module', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/parent.yaml', ['SharedPolicy', 'APolicy']),
      makeInfraModule('infrastructure/sam/nested.yaml', ['SharedPolicy', 'BPolicy']),
    ]);

    expect(collectSuffixLabels(snapshot)).toEqual({ Policy: ['APolicy', 'BPolicy', 'SharedPolicy'] });

    // The dedup carries through to the suggestion: count sees each label once.
    const graph = makeGraphWith(['SharedPolicy', 'APolicy', 'BPolicy'], []);
    const suggestion = computeDomainsSuggestion(snapshot, graph, {}, { declined: [] });
    const policy = suggestion.additions.find(addition => addition.axis === 'infra.excludeSuffixes');
    expect(policy).toMatchObject({ value: 'Policy', count: 3 });
  });

  it('matches longer overlapping infra suffixes first', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/a.yaml', ['UsersRolePolicy', 'OrdersRolePolicy', 'LegacyPolicy']),
    ]);

    expect(collectSuffixHistogram(snapshot)).toEqual({ RolePolicy: 2, Policy: 1 });
  });

  it('suggests only missing infra suffixes and hides declined ids', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/a.yaml', ['UsersAlarm', 'UsersLogGroup']),
      makeInfraModule('infrastructure/sam/b.yaml', ['OrdersAlarm', 'OrdersLogGroup']),
    ]);

    const suggestion = computeDomainsSuggestion(
      snapshot,
      createEmptyGraph(),
      { domains: { 'infra-sam': { paths: ['^infrastructure/sam'] } }, infra: { excludeSuffixes: ['Alarm'] } },
      { declined: ['infra.excludeSuffixes:LogGroup'] },
    );

    expect(suggestion.count).toBe(0);
    expect(suggestion.declinedHidden).toBe(1);
  });

  it('proposes a blanket excludeSuffixes only when every label under the suffix is inert', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/a.yaml', ['UsersAlarm', 'OrdersAlarm']),
    ]);
    const graph = makeGraphWith(['UsersAlarm', 'OrdersAlarm'], []);

    const suggestion = computeDomainsSuggestion(snapshot, graph, {}, { declined: [] });

    expect(suggestion.additions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'infra.excludeSuffixes:Alarm', axis: 'infra.excludeSuffixes', value: 'Alarm' }),
    ]));
    expect(suggestion.additions.some(addition => addition.axis === 'infra.excludePatterns')).toBe(false);
  });

  it('stays silent for a single inert label (below the 2-label threshold)', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/a.yaml', ['UsersAlarm']),
    ]);
    const graph = makeGraphWith(['UsersAlarm'], []);

    const suggestion = computeDomainsSuggestion(snapshot, graph, {}, { declined: [] });

    // One inert label under the suffix is below threshold: no blanket suffix, no anchored pattern.
    expect(suggestion.additions.some(addition =>
      addition.axis === 'infra.excludeSuffixes' || addition.axis === 'infra.excludePatterns')).toBe(false);
  });

  it('suggests at exactly two inert labels (the threshold boundary)', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/a.yaml', ['UsersAlarm', 'OrdersAlarm']),
    ]);
    const graph = makeGraphWith(['UsersAlarm', 'OrdersAlarm'], []);

    const suggestion = computeDomainsSuggestion(snapshot, graph, {}, { declined: [] });

    // Two inert labels meets the threshold: a blanket suffix exclude is proposed.
    expect(suggestion.additions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'infra.excludeSuffixes:Alarm',
        axis: 'infra.excludeSuffixes',
        value: 'Alarm',
        count: 2,
      }),
    ]));
  });

  it('spares witnessed resources: a mixed suffix yields an anchored excludePatterns over inert labels only', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/a.yaml', ['WebsitePolicy', 'HstsPolicy', 'ManagedPolicy']),
    ]);
    // Only ManagedPolicy carries a load-bearing edge (uses_env); the other two are inert plumbing.
    const graph = makeGraphWith(['WebsitePolicy', 'HstsPolicy', 'ManagedPolicy'], ['ManagedPolicy']);

    const suggestion = computeDomainsSuggestion(snapshot, graph, {}, { declined: [] });

    expect(suggestion.additions).toEqual([
      expect.objectContaining({
        id: 'infra.excludePatterns:^(HstsPolicy|WebsitePolicy)$',
        axis: 'infra.excludePatterns',
        value: '^(HstsPolicy|WebsitePolicy)$',
        labels: ['HstsPolicy', 'WebsitePolicy'],
        spared: ['ManagedPolicy'],
      }),
    ]);
    expect(suggestion.additions.some(addition => addition.axis === 'infra.excludeSuffixes')).toBe(false);
    expect(suggestion.mergedConfig.infra?.excludePatterns).toEqual(['^(HstsPolicy|WebsitePolicy)$']);
  });

  it('infra.keep.suffixes silences the advisor for that suffix', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/a.yaml', ['UsersAlarm', 'OrdersAlarm']),
    ]);
    const graph = makeGraphWith(['UsersAlarm', 'OrdersAlarm'], []);

    const suggestion = computeDomainsSuggestion(
      snapshot,
      graph,
      { infra: { keep: { suffixes: ['Alarm'] } } },
      { declined: [] },
    );

    expect(suggestion.additions.some(addition =>
      addition.axis === 'infra.excludeSuffixes' || addition.axis === 'infra.excludePatterns')).toBe(false);
  });

  it('a kept label forces a pattern over the remaining inert labels instead of a blanket suffix', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/a.yaml', ['AAlarm', 'BAlarm', 'CAlarm']),
    ]);
    const graph = makeGraphWith(['AAlarm', 'BAlarm', 'CAlarm'], []);

    const suggestion = computeDomainsSuggestion(
      snapshot,
      graph,
      { infra: { keep: { patterns: ['^AAlarm$'] } } },
      { declined: [] },
    );

    expect(suggestion.additions).toEqual([
      expect.objectContaining({ axis: 'infra.excludePatterns', value: '^(BAlarm|CAlarm)$', labels: ['BAlarm', 'CAlarm'] }),
    ]);
  });

  it('suppresses infra-noise suggestions when infra.pruneInert is on (the gate handles them)', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/a.yaml', ['UsersAlarm', 'OrdersAlarm']),
    ]);
    const graph = makeGraphWith(['UsersAlarm', 'OrdersAlarm'], []);

    const suggestion = computeDomainsSuggestion(snapshot, graph, { infra: { pruneInert: true } }, { declined: [] });

    expect(suggestion.additions.some(addition =>
      addition.axis === 'infra.excludeSuffixes' || addition.axis === 'infra.excludePatterns')).toBe(false);
  });

  it('applyDomainsKeep writes keep suffixes/patterns without clobbering excludes', () => {
    const merged = applyDomainsKeep(
      { infra: { excludeSuffixes: ['Alarm'], keep: { suffixes: ['Role'] } } },
      [
        {
          id: 'infra.excludeSuffixes:LogGroup',
          axis: 'infra.excludeSuffixes',
          value: 'LogGroup',
          count: 2,
          labels: ['XLogGroup', 'YLogGroup'],
          reason: 'test',
        },
        {
          id: 'infra.excludePatterns:^(APolicy|BPolicy)$',
          axis: 'infra.excludePatterns',
          value: '^(APolicy|BPolicy)$',
          count: 2,
          labels: ['APolicy', 'BPolicy'],
          spared: ['CPolicy'],
          reason: 'test',
        },
      ],
    );

    expect(merged.infra?.keep?.suffixes).toEqual(['Role', 'LogGroup']);
    expect(merged.infra?.keep?.patterns).toEqual(['^(APolicy|BPolicy)$']);
    expect(merged.infra?.excludeSuffixes).toEqual(['Alarm']);
  });

  it('proposes nothing when every label under a suffix is witnessed', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/a.yaml', ['AFunctionRole', 'BFunctionRole']),
    ]);
    const graph = makeGraphWith(['AFunctionRole', 'BFunctionRole'], ['AFunctionRole', 'BFunctionRole']);

    const suggestion = computeDomainsSuggestion(snapshot, graph, {}, { declined: [] });

    expect(suggestion.additions.some(addition =>
      addition.axis === 'infra.excludeSuffixes' || addition.axis === 'infra.excludePatterns')).toBe(false);
  });

  it('applies accepted additions additively without clobbering existing domains', () => {
    const merged = applyDomainsSuggestion(
      {
        domains: { existing: { paths: ['^src/existing'], aliases: ['old'] } },
        infra: { excludeSuffixes: ['Alarm'] },
      },
      [
        {
          id: 'infra.excludeSuffixes:LogGroup',
          axis: 'infra.excludeSuffixes',
          value: 'LogGroup',
          count: 3,
          labels: ['AFunctionLogGroup', 'BFunctionLogGroup', 'CFunctionLogGroup'],
          reason: 'test',
        },
        {
          id: 'domains:infra-sam:^infrastructure/sam',
          axis: 'domains',
          domain: 'infra-sam',
          paths: ['^infrastructure/sam'],
          count: 2,
          reason: 'test',
        },
      ],
    );

    expect(merged.infra?.excludeSuffixes).toEqual(['Alarm', 'LogGroup']);
    expect(merged.domains?.existing?.aliases).toEqual(['old']);
    expect(merged.domains?.['infra-sam']?.paths).toEqual(['^infrastructure/sam']);
  });

  it('suggests PascalCase reject only when unset and common enough', () => {
    const modules = Array.from({ length: 12 }, (_, i) => makeMod(`mod:p/src/Button${i}`, `src/Button${i}.tsx`));
    const suggestion = computeDomainsSuggestion(makeSnapshot(modules), createEmptyGraph(), {}, { declined: [] });

    expect(suggestion.additions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'basename.pascalCase:reject', axis: 'basename.pascalCase' }),
    ]));
  });

  it('does not count camelCase basenames as PascalCase', () => {
    const modules = Array.from({ length: 12 }, (_, i) => makeMod(`mod:p/src/httpClient${i}`, `src/httpClient${i}.ts`));
    const suggestion = computeDomainsSuggestion(makeSnapshot(modules), createEmptyGraph(), {}, { declined: [] });

    expect(suggestion.additions.some(addition => addition.id === 'basename.pascalCase:reject')).toBe(false);
  });

  it('suggests infra path domains only for new domain ids', () => {
    const snapshot = makeSnapshot([], [
      makeInfraModule('infrastructure/sam/a.yaml', ['AFunction']),
      makeInfraModule('infrastructure/sam/b.yaml', ['BFunction']),
      makeInfraModule('infrastructure/helm/a.yaml', ['HelmThing']),
      makeInfraModule('infrastructure/helm/b.yaml', ['HelmThingTwo']),
    ]);

    const suggestion = computeDomainsSuggestion(
      snapshot,
      createEmptyGraph(),
      { domains: { 'infra-sam': { paths: ['^infrastructure/sam'] } } },
      { declined: [] },
    );

    expect(suggestion.additions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'domains:infra-helm:^infrastructure/helm',
        axis: 'domains',
        domain: 'infra-helm',
      }),
    ]));
    expect(suggestion.additions.some(addition => addition.id === 'domains:infra-sam:^infrastructure/sam')).toBe(false);
  });
});
