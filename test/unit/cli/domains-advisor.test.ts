import { asRepoRelPath } from '@repovine/plugin-sdk';
import { asHostPath } from '@repovine/plugin-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { runDomainsAdvisorAfterBuild } from '../../../src/cli/domains-advisor.js';
import { createEmptyGraph } from '../../../src/graph/index.js';
import { computeDomainsSuggestion } from '../../../src/stage2/domains-advisor.js';
import type { InfraModuleInfo, RepositoryFactsSnapshot } from '../../../src/types.js';
import type { RepovineState } from '../../../src/mcp/types.js';
import { backlogCoverage } from '../../helpers/backlog.js';

function makeInfraModule(relativeFilePath: string, resourceIds: string[]): InfraModuleInfo {
  return {
    id: `infra:cloudformation:${relativeFilePath}`,
    kind: 'cloudformation',
    absPath: asHostPath(`/repo/${relativeFilePath}`),
    repoRelPath: asRepoRelPath(relativeFilePath),
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

function makeSnapshot(repoRoot: string): RepositoryFactsSnapshot {
  return {
    repoRoot,
    timestamp: '2026-01-01',
    packages: [],
    modules: [],
    infraModules: [
      makeInfraModule('infrastructure/helm/a.yaml', ['UsersLogGroup', 'UsersPolicy']),
      makeInfraModule('infrastructure/helm/b.yaml', ['OrdersLogGroup', 'OrdersPolicy']),
    ],
  };
}

function makeState(repoRoot: string): RepovineState {
  const graph = createEmptyGraph();
  const snapshot = makeSnapshot(repoRoot);
  const domainsSuggestions = computeDomainsSuggestion(snapshot, graph, {}, { declined: [] });
  return {
    graph,
    snapshot,
    modulesById: new Map(),
    searchIndex: {} as RepovineState['searchIndex'],
    semanticIndex: null,
    semanticSearchRefresh: { status: 'disabled' },
    annotations: {
      getStats: () => backlogCoverage(),
    } as unknown as RepovineState['annotations'],
    domainsConfig: null,
    domainsSuggestions,
    refactoringThresholds: {} as RepovineState['refactoringThresholds'],
    builtAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('runDomainsAdvisorAfterBuild', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reviews interactive suggestions one by one: accept, skip-hide, and quit', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'domains-advisor-cli-'));
    const state = makeState(repoRoot);
    const answers = ['y', 's', 'q'];
    const prompts: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = runDomainsAdvisorAfterBuild(repoRoot, state, {
        interactive: true,
        prompt: (prompt) => {
          prompts.push(prompt);
          return answers.shift() ?? 'n';
        },
      });

      expect(prompts).toHaveLength(3);
      expect(result).toEqual(expect.objectContaining({
        count: 3,
        applied: true,
        declined: true,
        acceptedCount: 1,
        declinedCount: 1,
        pendingCount: 1,
      }));
      expect(prompts[0]).toContain('Apply? [y]es / [k]eep-committed / [s]kip-hide / [q]uit domains advisor:');
      expect(JSON.parse(fs.readFileSync(path.join(repoRoot, 'repovine.domains.json'), 'utf-8'))).toEqual(
        expect.objectContaining({
          infra: expect.objectContaining({ excludeSuffixes: ['LogGroup'] }),
        }),
      );
      expect(fs.readFileSync(path.join(repoRoot, 'repovine.domains.json'), 'utf-8')).not.toContain('Policy');
      expect(JSON.parse(fs.readFileSync(path.join(repoRoot, '.repovine', 'onboarding-state.json'), 'utf-8'))).toEqual(
        expect.objectContaining({
          onboarding: expect.objectContaining({
            domains: expect.objectContaining({
              suggestions: 1,
              declined: ['infra.excludeSuffixes:Policy'],
            }),
          }),
        }),
      );
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('1 suggestion(s) skipped and hidden for this repo.');
      expect(output).toContain('1 suggestion(s) left pending for later.');
      expect(output).toContain('hide runtime-resource nodes whose labels end with "LogGroup"');
      expect(output).toContain('tag matching modules as domain "infra-helm"; this does not move files or merge modules');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('keep-committed writes an infra.keep marker instead of an exclude', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'domains-advisor-keep-'));
    const state = makeState(repoRoot);
    const answers = ['k', 'q'];
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const result = runDomainsAdvisorAfterBuild(repoRoot, state, {
        interactive: true,
        prompt: () => answers.shift() ?? 'q',
      });

      expect(result).toEqual(expect.objectContaining({ keptCount: 1, acceptedCount: 0, declinedCount: 0 }));
      const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'repovine.domains.json'), 'utf-8'));
      // The first suggestion (LogGroup, alphabetically before Policy) was kept, not excluded.
      expect(config.infra?.keep?.suffixes).toEqual(['LogGroup']);
      expect(config.infra?.excludeSuffixes ?? []).not.toContain('LogGroup');
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('keep marker(s)');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
