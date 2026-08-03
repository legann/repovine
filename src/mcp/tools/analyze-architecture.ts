import {
  runRefactoringReport,
  runRefactoringOpportunityDetail,
  type RefactoringReportArgs,
  type RefactoringOpportunityDetailArgs,
  type RefactoringFinding,
} from '../../analysis/architecture/index.js';
import { isSingleNodeScope } from '../../analysis/architecture/scope.js';
import { getInterpreterEntrypoints } from '../../stage2/interpreter/entrypoint-store.js';
import type { ToolHandler } from '../types.js';
import { resolveScope, refactoringScopeArg } from '../scope/resolve.js';
import { scopeNavigation } from '../scope/navigation.js';
import { envelope, nav } from '../response/envelope.js';
import {
  limitFrom,
  DEFAULT_ARCHITECTURE_LIMIT,
  MAX_ARCHITECTURE_LIMIT,
} from '../response/pagination.js';
import { architectureEmptyDiagnostic } from '../response/empty-diagnostics.js';
import { argTruncation } from '../../response/truncation.js';

/** Report-mode finding nodes are a preview; the full set lives in detail mode (maxNodes-bounded). */
const REPORT_FINDING_NODE_PREVIEW = 10;

/**
 * What a single-node scope cannot reach, said whether or not it found anything.
 *
 * Detectors read the in-scope node set. With one node in it, per-node signals are answered in full
 * and comparisons between in-scope nodes have nothing to compare — a distinction an empty finding
 * list does not make on its own.
 */
const SINGLE_NODE_SCOPE_GAP =
  'This scope holds one node, so only per-node signals can be reported: a finding that compares '
  + 'several in-scope nodes has nothing to compare here. Use the owning package or domain scope for those.';

export const handleAnalyzeArchitecture: ToolHandler = (ctx, args) => {
  const scope = resolveScope(ctx, args.scope);
  const detailFindingId = (args.detailFindingId as string | undefined) ?? (args.findingId as string | undefined);
  const mode = detailFindingId ? 'detail' : ((args.mode as string | undefined) ?? 'report');
  const limit = limitFrom(args, DEFAULT_ARCHITECTURE_LIMIT, MAX_ARCHITECTURE_LIMIT);
  const baseArgs = {
    scope,
    categories: args.categories,
    minConfidence: args.minConfidence,
    limit,
    includeComponentEntrypoints: args.includeComponentEntrypoints,
    annotationReasoning: args.annotationReasoning,
  };
  const { graph, modulesById, annotations, snapshot, refactoringThresholds } = ctx.getState();
  const propagation = ctx.getConfig().annotations.propagation;
  const entrypoints = getInterpreterEntrypoints(graph);
  const state = { graph, modulesById, annotations, snapshot, refactoringThresholds, propagation, entrypoints };
  const result = mode === 'detail'
    ? runRefactoringOpportunityDetail(state, {
        ...baseArgs,
        findingId: detailFindingId,
        maxNodes: args.maxNodes,
      } as unknown as RefactoringOpportunityDetailArgs)
    : runRefactoringReport(state, baseArgs as RefactoringReportArgs);
  const navigation = scopeNavigation(scope);
  const responseResult = result as Record<string, unknown>;
  const findings = (responseResult as { findings?: Array<{ id: string }> }).findings ?? [];
  for (const f of findings.slice(0, 5)) {
    navigation.deeper.push(nav('analyze_architecture', {
      scope: refactoringScopeArg(scope),
      detailFindingId: f.id,
    }, 'Expand this architecture finding before recommending code movement.'));
  }
  const gaps = typeof responseResult.error === 'string' ? [responseResult.error] : [];
  if (isSingleNodeScope(scope.kind)) gaps.push(SINGLE_NODE_SCOPE_GAP);
  const totalFindings = responseResult.totalFindings;
  const returnedFindings = responseResult.returnedFindings;
  if (typeof totalFindings === 'number' && typeof returnedFindings === 'number' && totalFindings > returnedFindings) {
    // The report has no offset: a higher `limit` is what returns more, up to the report ceiling.
    responseResult.truncation = {
      findings: argTruncation({
        shown: returnedFindings,
        total: totalFindings,
        arg: 'limit',
        value: Math.min(MAX_ARCHITECTURE_LIMIT, totalFindings),
        hint: `Findings are capped at ${MAX_ARCHITECTURE_LIMIT} per report; narrow scope or categories when more than that matched.`,
      }),
    };
  }
  const emptyDiagnostic = architectureEmptyDiagnostic(ctx, scope, args, mode, responseResult);
  if (emptyDiagnostic && !gaps.length) gaps.push(emptyDiagnostic.message);
  const publicResult = publicArchitectureResult(responseResult, mode, emptyDiagnostic);
  return envelope(scope, mode === 'detail' ? 'Expanded architecture finding detail.' : 'Ran architecture analysis.', publicResult, {
    confidence: responseResult.error || emptyDiagnostic ? 'low' : 'medium',
    gaps,
    navigation,
  });
};

/**
 * One finding as the tool publishes it.
 *
 * `confidence` stays inside the analysis package so it can be recalibrated: the detector score
 * barely orders findings by whether they are true, and the 0.5 default filters nothing out of a real
 * report, so publishing it would state a precision it does not have. `preview` caps the
 * (graph-scaled) node list and reports what was cut; the full maxNodes-bounded enumeration is what
 * detail mode is for.
 */
function publicFinding(finding: RefactoringFinding, preview: boolean): Record<string, unknown> {
  const { confidence: _confidence, ...rest } = finding;
  if (!preview || finding.nodes.length <= REPORT_FINDING_NODE_PREVIEW) return rest;
  return {
    ...rest,
    nodes: finding.nodes.slice(0, REPORT_FINDING_NODE_PREVIEW),
    truncation: {
      nodes: argTruncation({
        shown: REPORT_FINDING_NODE_PREVIEW,
        total: finding.nodes.length,
        arg: 'detailFindingId',
        value: finding.id,
        hint: 'Report mode previews a finding\'s nodes; detail mode returns the full maxNodes-bounded set.',
      }),
    },
  };
}

/** The analysis payload projected to what the tool publishes: findings without their score, the
 *  top-level `minConfidence` field dropped, and the empty-result diagnostic folded in. An empty
 *  report still names the threshold, under `emptyDiagnostic.details.minConfidence`, because it is
 *  the reason the report is empty. */
function publicArchitectureResult(
  raw: Record<string, unknown>,
  mode: string,
  emptyDiagnostic: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const { minConfidence: _minConfidence, finding, findings, ...rest } = raw;
  const detail = mode === 'detail';
  return {
    ...rest,
    ...(detail && finding && typeof finding === 'object'
      ? { finding: publicFinding(finding as RefactoringFinding, false) }
      : finding !== undefined ? { finding } : {}),
    ...(!detail && Array.isArray(findings)
      ? { findings: (findings as RefactoringFinding[]).map(f => publicFinding(f, true)) }
      : findings !== undefined ? { findings } : {}),
    ...(emptyDiagnostic ? { emptyDiagnostic } : {}),
  };
}
