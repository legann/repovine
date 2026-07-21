/**
 * Public entry points for the refactoring module. The `analyze_architecture`
 * MCP tool in `src/mcp/tools/analyze-architecture.ts` wraps the functions
 * exposed here.
 *
 * Design note: this module does not depend on McpToolRuntime. It takes a small
 * state slice so it can be unit-tested and reused outside the MCP boundary.
 */

import type { RepositoryGraph, ModuleInfo, RepositoryFactsSnapshot } from '../../types.js';
import type { AnnotationStore } from '../../annotations/store.js';
import { computeEntrypointBoundedDerived } from '../../annotations/propagation.js';
import type { PropagationConfig } from '../../config.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../../config.js';
import type { EntrypointFragment } from '../../interpreter/types.js';
import type { DomainsConfig } from '../../stage2/domains.js';

import { DEFAULT_THRESHOLDS, type RefactoringThresholds } from './config.js';
import { scopedGraphIds } from './scope.js';
import {
  countFindingsByCategory,
  dedupeByCategoryAndPrimaryNode,
  refactoringCategoryFromFindingId,
  selectBalancedFindings,
  sortFindings,
} from './finding.js';
// Side-effect: populate the detector registry with all built-in detectors.
import './detector-bootstrap.js';
import { getDetectors, categoriesDisjoint, anyInScopeApplies } from './detector-registry.js';
import type { DetectorContext } from './detector-types.js';
import {
  affectedNodeEdges,
  refactoringCategoryDetail,
  refactoringNextCalls,
  refactoringNodeSummary,
} from './detail.js';
import {
  REFACTORING_CATEGORIES,
  type RefactoringCategory,
  type RefactoringFinding,
  type RefactoringScope,
} from './types.js';

export type {
  RefactoringCategory,
  RefactoringFinding,
  RefactoringScope,
} from './types.js';
export { REFACTORING_CATEGORIES } from './types.js';

export interface RefactoringState {
  graph: RepositoryGraph;
  modulesById: Map<string, ModuleInfo>;
  annotations: AnnotationStore;
  /**
   * Repository facts snapshot — needed by detectors that look at module contentHash
   * (e.g. annotation-risk's derived-stale propagation). Optional: detectors
   * gracefully degrade when missing.
   */
  snapshot?: RepositoryFactsSnapshot;
  domainsConfig: DomainsConfig | null;
  /**
   * Resolved thresholds from `repovine.config.json` →
   * `analyze_architecture.strictness` profile + per-knob
   * `analyze_architecture.thresholds.*` overrides. If omitted, the "normal"
   * profile is used.
   */
  refactoringThresholds?: RefactoringThresholds;
  /** Resolved annotations.propagation for derived/propagation-stale precompute. */
  propagation?: PropagationConfig;
  entrypoints?: readonly EntrypointFragment[];
}

export interface RefactoringReportArgs {
  scope?: string;
  categories?: RefactoringCategory[];
  minConfidence?: number;
  limit?: number;
  includeComponentEntrypoints?: boolean;
  /**
   * 'off' (default) → pure heuristic + already-baked annotation signals
   * (policy lexical tokens, annotation-risk quality scoring).
   *
   * 'on' → additionally attach `annotationContext` to findings whose verdict
   * depends on annotation comparison. The MCP does NOT call any LLM; the
   * caller (an agent in its conversation) reads the attached annotation
   * excerpts, answers `annotationContext.question`, and decides what to report.
   */
  annotationReasoning?: 'off' | 'on';
}

export interface RefactoringOpportunityDetailArgs {
  findingId: string;
  scope?: string;
  includeComponentEntrypoints?: boolean;
  maxNodes?: number;
  /**
   * Pass 'on' to receive the same annotationContext attached to the finding as
   * the original report would have. Mirrors `RefactoringReportArgs.annotationReasoning`.
   */
  annotationReasoning?: 'off' | 'on';
}

interface CollectedFindings {
  scope: RefactoringScope;
  requestedCategories: Set<RefactoringCategory>;
  minConfidence: number;
  annotationReasoning: boolean;
  /** Full sorted+deduped finding set, before any limit/balance cap. */
  sortedFindings: RefactoringFinding[];
}

/**
 * Run the detector suite for a scope and return the complete sorted+deduped finding list — no
 * limit/balance cap. `runRefactoringReport` applies the display cap on top; detail mode consumes the
 * uncapped list directly so it can resolve a finding id past the report's page window.
 */
function collectSortedFindings(state: RefactoringState, args: RefactoringReportArgs): CollectedFindings {
  // Fail loud on a cold detector registry. Registration is a side-effect import of
  // './detector-bootstrap.js' (pulled in transitively by this module); a caller that
  // reaches analysis without it would otherwise get zero findings with no signal.
  if (getDetectors().length === 0) {
    throw new Error(
      'Architecture analysis has no registered detectors. The registry is populated by a side-effect '
      + "import of './detector-bootstrap.js' via src/analysis/architecture/index.ts — import the analysis "
      + 'entry before running a report. A cold registry would otherwise return zero findings silently.',
    );
  }
  const { graph, modulesById, annotations, domainsConfig } = state;
  const thresholds = state.refactoringThresholds ?? DEFAULT_THRESHOLDS;
  const scopeArg = args.scope ?? 'all';
  const requestedCategories = new Set(
    (args.categories ?? REFACTORING_CATEGORIES)
      .filter(c => REFACTORING_CATEGORIES.includes(c)),
  );
  const minConfidence = typeof args.minConfidence === 'number' ? args.minConfidence : 0.5;
  const includeComponentEntrypoints = args.includeComponentEntrypoints === true;
  const annotationReasoning = args.annotationReasoning === 'on';

  const scope = scopedGraphIds(graph, modulesById, domainsConfig, scopeArg);

  // Precompute the derived-stale set once per report so all in-scope modules
  // share a consistent view. Only annotation-risk consumes it; requires a
  // snapshot — gracefully degrade to undefined when missing or unused.
  let derivedStaleSet: ReadonlySet<string> | undefined;
  if (requestedCategories.has('annotation-risk') && state.snapshot) {
    const propagation = state.propagation ?? DEFAULT_PROPAGATION_CONFIG;
    const entrypoints = state.entrypoints ?? [];
    derivedStaleSet = computeEntrypointBoundedDerived({
      graph,
      snapshot: state.snapshot,
      annotations,
      entrypoints,
      propagation,
    });
  }

  const ctx: DetectorContext = {
    graph,
    modulesById,
    annotations,
    scope,
    snapshot: state.snapshot,
    thresholds,
    requestedCategories,
    annotationReasoning,
    includeComponentEntrypoints,
    derivedStaleSet,
  };

  // Registry dispatch: run a detector when any of its categories was requested
  // and, when it declares `appliesTo`, at least one in-scope module matches.
  // The whole-detector skip is safe because such detectors emit nothing when no
  // module matches. The per-category filter below then drops categories a
  // multi-category detector (domain-shape) produced but the caller didn't ask for.
  const appliesCache = new Map<(mod: ModuleInfo) => boolean, boolean>();
  const raw: RefactoringFinding[] = [];
  for (const det of getDetectors()) {
    if (categoriesDisjoint(det.categories, requestedCategories)) continue;
    if (det.appliesTo && !anyInScopeApplies(ctx, det.appliesTo, appliesCache)) continue;
    raw.push(...det.run(ctx));
  }

  const findings = raw.filter(f =>
    requestedCategories.has(f.category) && f.confidence >= minConfidence,
  );

  const sortedFindings = dedupeByCategoryAndPrimaryNode(sortFindings(findings));
  return { scope, requestedCategories, minConfidence, annotationReasoning, sortedFindings };
}

export function runRefactoringReport(
  state: RefactoringState,
  args: RefactoringReportArgs,
): Record<string, unknown> {
  const { scope, requestedCategories, minConfidence, annotationReasoning, sortedFindings } =
    collectSortedFindings(state, args);
  const limit = Math.min(typeof args.limit === 'number' ? args.limit : 50, 200);
  const returned = selectBalancedFindings(sortedFindings, limit, requestedCategories);
  const summary = countFindingsByCategory(sortedFindings);
  const returnedSummary = countFindingsByCategory(returned);

  const note = annotationReasoning
    ? 'Heuristic + annotation-context report. Findings with `annotationContext` require YOU to read '
      + 'the listed annotation excerpts and answer `annotationContext.question` before reporting '
      + 'them to the user. Suppress, confirm, or boost based on what the annotations actually '
      + 'say — the MCP does no LLM reasoning. Never include `annotationContext` in your final '
      + 'response to the user; it is working material for you.'
    : 'Heuristic read-only report from graph + annotations only. Treat findings as review '
      + 'candidates, not automatic refactoring instructions.';

  return {
    scope: scope.scope,
    categories: [...requestedCategories],
    minConfidence,
    annotationReasoning: annotationReasoning ? 'on' : 'off',
    totalFindings: sortedFindings.length,
    returnedFindings: returned.length,
    summary,
    returnedSummary,
    findings: returned,
    note,
  };
}

export function runRefactoringOpportunityDetail(
  state: RefactoringState,
  args: RefactoringOpportunityDetailArgs,
): Record<string, unknown> {
  const findingId = args.findingId;
  if (!findingId) return { error: 'findingId is required' };
  const categories = refactoringCategoriesFromFindingId(findingId);
  if (categories.length === 0) {
    return { error: `Unknown refactoring finding category in id: ${findingId}`, knownCategories: REFACTORING_CATEGORIES };
  }

  // Search the full uncapped list (not runRefactoringReport's display page), so a valid finding id
  // that sorts past the report's balanced/limit window still resolves instead of erroring as "not found".
  const { scope, sortedFindings } = collectSortedFindings(state, {
    scope: args.scope ?? 'all',
    categories,
    minConfidence: 0,
    includeComponentEntrypoints: args.includeComponentEntrypoints === true,
    annotationReasoning: args.annotationReasoning === 'on' ? 'on' : 'off',
  });
  const finding = sortedFindings.find(item => item.id === findingId);
  if (!finding) {
    return {
      error: `Refactoring finding not found: ${findingId}`,
      hint: 'Run analyze_architecture with the same scope/options and pass an exact finding id as detailFindingId.',
      ...(categories.length === 1 ? { searchedCategory: categories[0] } : {}),
      searchedCategories: categories,
      searchedScope: scope.scope,
      returnedInCategory: sortedFindings.length,
      sampleFindingIds: sortedFindings.slice(0, 10).map(item => item.id),
    };
  }

  const { graph, modulesById, annotations } = state;
  const maxNodes = Math.min(typeof args.maxNodes === 'number' ? args.maxNodes : 30, 100);
  const affectedNodeIds = finding.nodes.slice(0, maxNodes);
  return {
    findingId,
    scope: scope.scope,
    finding,
    affectedNodes: affectedNodeIds.map(nodeId => refactoringNodeSummary(graph, modulesById, annotations, nodeId)),
    truncatedAffectedNodes: Math.max(0, finding.nodes.length - affectedNodeIds.length),
    relationships: {
      edgesBetweenAffectedNodes: affectedNodeEdges(graph, modulesById, affectedNodeIds),
    },
    categoryDetail: refactoringCategoryDetail(graph, modulesById, annotations, finding),
    nextCalls: refactoringNextCalls(graph, finding),
    note: 'Read-only detail from the existing graph and annotations. It does not read source files; use nextCalls for targeted follow-up.',
  };
}

/**
 * Resolve a detail id to the category set that must be rerun. Most finding ids start with their
 * category, but detector ids may be more specific (for example
 * `server-handler-orchestration` emits a `god-module` finding). The registry is the canonical
 * detector-id to category mapping, so new detector prefixes automatically round-trip.
 */
export function refactoringCategoriesFromFindingId(findingId: string): RefactoringCategory[] {
  const direct = refactoringCategoryFromFindingId(findingId);
  if (direct) return [direct];

  const detector = [...getDetectors()]
    .sort((a, b) => b.id.length - a.id.length)
    .find(candidate => findingId.startsWith(`${candidate.id}:`));
  return detector ? [...detector.categories] : [];
}
