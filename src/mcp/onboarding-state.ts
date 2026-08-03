import * as fs from 'node:fs';
import * as path from 'node:path';
import { graphStats } from '../graph/index.js';
import { ARTIFACTS_DIR_NAME } from '../paths.js';
import type { RepovineState } from './types.js';
import type { DomainsAdvisorDeclinedState } from '../stage2/domains-advisor.js';
import { answerableOf, needsWorkOf, rollUpCoverage } from '../annotations/backlog.js';

export const ONBOARDING_STATE_FILENAME = 'onboarding-state.json';

export interface OnboardingStateFile {
  version: 1;
  graph: {
    status: 'ready';
    builtAt: string;
    nodes: number;
    edges: number;
    modules: number;
  };
  onboarding: {
    annotations: {
      coveragePct: number;
      queueTotal: number;
    };
    domains: {
      suggestions: number;
      declinedHidden: number;
      axes: string[];
      declined: string[];
    };
  };
}

export function onboardingStateFilePath(repoRoot: string): string {
  return path.join(repoRoot, ARTIFACTS_DIR_NAME, ONBOARDING_STATE_FILENAME);
}

export function readOnboardingState(repoRoot: string): OnboardingStateFile | undefined {
  try {
    const filePath = onboardingStateFilePath(repoRoot);
    if (!fs.existsSync(filePath)) return undefined;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<OnboardingStateFile>;
    if (raw.version !== 1 || !raw.graph || !raw.onboarding) return undefined;
    return raw as OnboardingStateFile;
  } catch {
    return undefined;
  }
}

export function readDeclinedDomainsSuggestions(repoRoot: string): DomainsAdvisorDeclinedState {
  return {
    declined: normalizeDeclinedIds(readOnboardingState(repoRoot)?.onboarding?.domains?.declined),
  };
}

export function mergeDeclinedDomainsSuggestions(repoRoot: string, ids: string[]): DomainsAdvisorDeclinedState {
  return {
    declined: normalizeDeclinedIds([
      ...readDeclinedDomainsSuggestions(repoRoot).declined,
      ...ids,
    ]),
  };
}

export function buildOnboardingState(
  state: RepovineState,
  declined: DomainsAdvisorDeclinedState = { declined: [] },
): OnboardingStateFile {
  const stats = graphStats(state.graph);
  const coverage = rollUpCoverage(state.annotations.getStats(state.graph, state.snapshot));
  // Nodes the backlog asks nothing of are out of the denominator, so this percentage reaches 100
  // exactly when queueTotal reaches 0 rather than stalling short of it forever.
  const answerable = answerableOf(coverage);

  return {
    version: 1,
    graph: {
      status: 'ready',
      builtAt: state.builtAt,
      nodes: stats.totalNodes,
      edges: stats.totalEdges,
      modules: state.snapshot.modules.length,
    },
    onboarding: {
      annotations: {
        coveragePct: answerable === 0 ? 100 : Math.round((coverage.fresh / answerable) * 100),
        queueTotal: needsWorkOf(coverage),
      },
      domains: {
        suggestions: state.domainsSuggestions.count,
        declinedHidden: state.domainsSuggestions.declinedHidden,
        axes: state.domainsSuggestions.axes,
        declined: normalizeDeclinedIds(declined.declined),
      },
    },
  };
}

export function writeOnboardingState(
  repoRoot: string,
  state: RepovineState,
  options: { declined?: DomainsAdvisorDeclinedState } = {},
): void {
  try {
    const filePath = onboardingStateFilePath(repoRoot);
    const declined = options.declined ?? readDeclinedDomainsSuggestions(repoRoot);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(buildOnboardingState(state, declined), null, 2)}\n`, 'utf-8');
  } catch (err) {
    console.error(`[WARN] Failed to write repovine onboarding state: ${(err as Error).message}`);
  }
}

function normalizeDeclinedIds(ids: unknown): string[] {
  return Array.isArray(ids)
    ? [...new Set(ids.filter((id): id is string => typeof id === 'string'))].sort()
    : [];
}
