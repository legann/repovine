import {
  runRefactoringReport,
  runRefactoringOpportunityDetail,
  type RefactoringReportArgs,
  type RefactoringOpportunityDetailArgs,
  type RefactoringFinding,
} from '../../analysis/architecture/index.js';
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

/** Report-mode finding nodes are a preview; the full set lives in detail mode (maxNodes-bounded). */
const REPORT_FINDING_NODE_PREVIEW = 10;

export const handleAnalyzeArchitecture: ToolHandler = (ctx, args) => {
  const scope = resolveScope(ctx, args.scope);
  const detailFindingId = (args.detailFindingId as string | undefined) ?? (args.findingId as string | undefined);
  const mode = detailFindingId ? 'detail' : ((args.mode as string | undefined) ?? 'report');
  const limit = limitFrom(args, DEFAULT_ARCHITECTURE_LIMIT, MAX_ARCHITECTURE_LIMIT);
  const baseArgs = {
    scope: refactoringScopeArg(scope),
    categories: args.categories,
    minConfidence: args.minConfidence,
    limit,
    includeComponentEntrypoints: args.includeComponentEntrypoints,
    annotationReasoning: args.annotationReasoning,
  };
  const { graph, modulesById, annotations, snapshot, domainsConfig, refactoringThresholds } = ctx.getState();
  const propagation = ctx.getConfig().annotations.propagation;
  const entrypoints = getInterpreterEntrypoints(graph);
  const state = { graph, modulesById, annotations, snapshot, domainsConfig, refactoringThresholds, propagation, entrypoints };
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
  const totalFindings = responseResult.totalFindings;
  const returnedFindings = responseResult.returnedFindings;
  if (typeof totalFindings === 'number' && typeof returnedFindings === 'number' && totalFindings > returnedFindings) {
    gaps.push(`${totalFindings} architecture finding(s) matched; showing ${returnedFindings}. Narrow scope/categories or pass a higher limit when you need more.`);
  }
  const emptyDiagnostic = architectureEmptyDiagnostic(ctx, scope, args, mode, responseResult);
  if (emptyDiagnostic) {
    responseResult.emptyDiagnostic = emptyDiagnostic;
    if (!gaps.length) gaps.push(emptyDiagnostic.message);
  }
  // The detector confidence score barely orders findings by whether they are true, and the 0.5
  // default filters nothing out of a real report. It stays inside the analysis package so it can
  // be recalibrated, but publishing it here would state a precision it does not have.
  delete responseResult.minConfidence;
  if (mode === 'detail' && responseResult.finding && typeof responseResult.finding === 'object') {
    const publicFinding = { ...(responseResult.finding as Record<string, unknown>) };
    delete publicFinding.confidence;
    responseResult.finding = publicFinding;
  }
  // Report mode: each finding is a summary, so cap its (possibly graph-scaled) node list to a
  // preview and report nodeCount/truncatedNodes. The full, maxNodes-bounded enumeration is the
  // job of detail mode (detailFindingId). Keeps per-finding payload brief, not graph-scaled.
  if (mode !== 'detail' && Array.isArray(responseResult.findings)) {
    responseResult.findings = (responseResult.findings as RefactoringFinding[]).map(f => {
      const publicFinding: Record<string, unknown> = f.nodes.length <= REPORT_FINDING_NODE_PREVIEW
        ? { ...f }
        : {
        ...f,
        nodes: f.nodes.slice(0, REPORT_FINDING_NODE_PREVIEW),
        nodeCount: f.nodes.length,
        truncatedNodes: f.nodes.length - REPORT_FINDING_NODE_PREVIEW,
      };
      delete publicFinding.confidence;
      return publicFinding;
    });
  }
  return envelope(scope, mode === 'detail' ? 'Expanded architecture finding detail.' : 'Ran architecture analysis.', responseResult, {
    confidence: responseResult.error || emptyDiagnostic ? 'low' : 'medium',
    gaps,
    navigation,
  });
};
