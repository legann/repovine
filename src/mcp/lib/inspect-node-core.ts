import type { EdgeKind, NodeViewChild, NodeViewDetail, RepositoryGraph } from '../../types.js';
import { buildNodeView, forwardImportClosure } from '../../graph/index.js';
import {
    computeAnnotationQuality,
    resolveDomainContentHash,
    resolveTemplateContentHash,
  } from '../../annotations/store.js';
import { CURRENT_ANNOTATION_SCHEMA_VERSION } from '../../types.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../../config.js';
import { inferModuleKind } from '../../annotations/module-kind.js';
import { resolveServiceResourceContentHash } from '../../annotations/service-resource-hash.js';
import {
  DEFAULT_BODY_LIMIT,
  DEFAULT_INSPECT_CHILD_LIMIT,
  MAX_BODY_LIMIT,
  MAX_INSPECT_CHILD_LIMIT,
  namedLimitFrom,
  namedOffsetFrom,
  paginateNodeViewChildren,
} from '../response/pagination.js';
import { applyInvestigateTags, computeHubInDegreeThreshold, INVESTIGATE_DEP_GUARD_DEPTH } from './investigate-refs.js';
import { annotationFreshnessProvenance } from './annotation-freshness.js';
import { narrowTruncation, pageTruncation, unavailableTruncation } from '../../response/truncation.js';
import type { McpToolRuntime } from '../types.js';
import {
  GREP_EXECUTION_TIMEOUT_MS,
  isUnsafeRegexPattern,
  MAX_GREP_LINE_CHARS,
  MAX_GREP_MATCHES,
  readNodeBody,
  redactSecretLikeText,
  scanLinesWithRegex,
} from './node-body.js';

/**
 * 1-hop kind+direction edge count over a graph — the topology input for the `wiring`/`co-change`
 * mechanics. Same cost class as `importerCount`; no memoization.
 */
export function graphEdgeCount(graph: RepositoryGraph): (id: string, kind: EdgeKind, dir: 'in' | 'out') => number {
  return (id, kind, dir) => {
    let n = 0;
    for (const e of (dir === 'in' ? graph.inEdges : graph.outEdges).get(id) ?? []) if (e.kind === kind) n++;
    return n;
  };
}

export async function buildInspectNodeDetail(ctx: McpToolRuntime, args: Record<string, unknown>): Promise<unknown> {
  const { graph, modulesById, annotations } = ctx.getState();
  const rawId = args.nodeId as string;
  const includeBody = args.includeBody === true;
  const bodyOffset = Math.max(0, (args.bodyOffset as number) ?? 0);
  const bodyLimit = (args.bodyLimit as number) ?? DEFAULT_BODY_LIMIT;
  const grepBody = args.grepBody as string | undefined;
  const includePrivate = args.includePrivate === true;
  const includeInternals = args.includeInternals === true;
  const exportLimit = namedLimitFrom(args, 'exportLimit', DEFAULT_INSPECT_CHILD_LIMIT, MAX_INSPECT_CHILD_LIMIT);
  const exportOffset = namedOffsetFrom(args, 'exportOffset');

  if (bodyLimit < 1 || bodyLimit > MAX_BODY_LIMIT) {
    return { error: `bodyLimit must be between 1 and ${MAX_BODY_LIMIT}` };
  }

  // Takes a resolved node id; the caller's string is read once, by resolveScope at the tool boundary.
  const nodeId = graph.nodes.has(rawId) ? rawId : undefined;
  if (!nodeId) return { error: `Node not found: ${rawId}` };
  const viewRaw = buildNodeView(graph, nodeId);
  if (!viewRaw) return { error: `Node not found: ${rawId}` };
  const view: NodeViewDetail = { ...viewRaw };
  const node = graph.nodes.get(nodeId);
  if (!node) return { error: `Node not found: ${rawId}` };

  if (includePrivate && node.type === 'export-symbol') {
    const members = node.data?.privateMembers;
    if (members?.length) {
      for (const m of members) {
        view.drillDown.push({
          id: `${nodeId}/${m.name}`,
          label: m.name,
          type: 'export-symbol',
          symbolKind: m.kind === 'method' ? 'function' : 'const',
          signature: m.signature,
          lineRange: m.lineRange,
          access: m.access,
        } as NodeViewChild);
      }
    }
  }

  if (includeInternals && node.type === 'export-symbol') {
    const internals = node.data?.internals;
    if (internals?.length) {
      for (const i of internals) {
        view.drillDown.push({
          id: `${nodeId}/#${i.name.replace(/,\s*/g, '_')}`,
          label: i.name,
          type: 'export-symbol',
          symbolKind: i.kind === 'function' ? 'function' : 'const',
          signature: i.signature,
          lineRange: i.lineRange,
          internal: true,
          internalKind: i.kind,
        } as NodeViewChild);
      }
    }
  }

  if (grepBody) {
    const MAX_GREP_PATTERN_LENGTH = 200;
    if (grepBody.length > MAX_GREP_PATTERN_LENGTH) {
      view.grepError = `Regex pattern too long (${grepBody.length} chars, max ${MAX_GREP_PATTERN_LENGTH})`;
    } else if (isUnsafeRegexPattern(grepBody)) {
      view.grepError = 'Regex pattern rejected as potentially unsafe';
    } else {
      try {
        // Compile before file IO so malformed patterns fail cheaply on the request thread. Pattern
        // length is capped above; execution happens in a killable worker below.
        new RegExp(grepBody, 'i');
        const bodyResult = await readNodeBody(graph, modulesById, ctx.repoRoot, nodeId, node.type, view.lineRange);
        if ('error' in bodyResult) {
          view.grepError = bodyResult.error;
          console.error(`[get_context_detail] grepBody: ${view.grepError}`);
        } else {
          const CONTEXT_LINES = 3;
          const scan = await scanLinesWithRegex(bodyResult.lines, grepBody, { signal: ctx.signal });
          if (scan.timedOut) {
            view.grepError = `Regex execution exceeded the ${GREP_EXECUTION_TIMEOUT_MS}ms deadline`;
          } else {
            if (scan.truncatedLineCount > 0) {
              // Long lines are clipped before the regex sees them, so a match past the cap was never
              // tested for. The untested tail is not retrievable through grep at any argument.
              view.truncation = {
                ...view.truncation,
                grepInput: unavailableTruncation({
                  shown: bodyResult.lines.length - scan.truncatedLineCount,
                  total: bodyResult.lines.length,
                  unit: 'line',
                  hint: `${scan.truncatedLineCount} line(s) longer than ${MAX_GREP_LINE_CHARS} chars were tested only up to that width; read the full text with includeBody and bodyOffset.`,
                }),
              };
            }
            if (scan.matchesTruncated) {
              view.truncation = {
                ...view.truncation,
                grepMatches: narrowTruncation({
                  shown: scan.matchIndices.length,
                  total: scan.totalMatches,
                  unit: 'match',
                  hint: `Context lines are attached to the first ${MAX_GREP_MATCHES} matching lines; narrow grepBody to reach the rest.`,
                }),
              };
            }
            const matches: Array<{ line: number; text: string; isMatch: boolean }> = [];
            const included = new Set<number>();
            for (const idx of scan.matchIndices) {
              const from = Math.max(0, idx - CONTEXT_LINES);
              const to = Math.min(bodyResult.lines.length - 1, idx + CONTEXT_LINES);
              for (let j = from; j <= to; j++) {
                if (!included.has(j)) {
                  included.add(j);
                  const line = bodyResult.lines[j];
                  const boundedLine = line.length > MAX_GREP_LINE_CHARS
                    ? `${line.slice(0, MAX_GREP_LINE_CHARS)}… [truncated]`
                    : line;
                  matches.push({
                    line: bodyResult.lineStart + j + 1,
                    text: redactSecretLikeText(boundedLine),
                    isMatch: j === idx,
                  });
                }
              }
            }
            matches.sort((a, b) => a.line - b.line);
            view.grepMatches = matches;
          }
        }
      } catch (error) {
        view.grepError = error instanceof SyntaxError
          ? `Invalid regex: ${grepBody}`
          : `Regex execution failed: ${(error as Error).message}`;
      }
    }
  }

  if (includeBody) {
    const bodyResult = await readNodeBody(graph, modulesById, ctx.repoRoot, nodeId, node.type, view.lineRange);
    if ('error' in bodyResult) {
      view.bodyError = bodyResult.error;
      console.error(`[get_context_detail] includeBody: ${view.bodyError}`);
    } else {
      const full = redactSecretLikeText(bodyResult.lines.join('\n'));
      const slice = full.slice(bodyOffset, bodyOffset + bodyLimit);
      view.body = slice;
      const body = pageTruncation({
        shown: slice.length,
        total: full.length,
        offset: bodyOffset,
        arg: 'bodyOffset',
        unit: 'char',
        noun: 'character',
        hint: 'Pass bodyOffset with the same bodyLimit for the next slice; a shorter bodyLimit narrows the window, it does not move it.',
      });
      if (body) view.truncation = { ...view.truncation, body };
    }
  }

  const ann = annotations.get(nodeId);
  if (ann) {
    const { snapshot } = ctx.getState();
    let fresh: boolean | undefined;
    const mod = modulesById.get(nodeId);
    if (mod) {
      fresh = ann.contentHash === mod.contentHash;
    } else if (nodeId.startsWith('infra:')) {
      const infraMod = snapshot.infraModules?.find(m => m.id === nodeId);
      fresh = !!infraMod && ann.contentHash === infraMod.contentHash;
      } else if (node.type === 'runtime-resource') {
        const resourceHash = resolveServiceResourceContentHash(graph, snapshot, nodeId);
        fresh = !!resourceHash && ann.contentHash === resourceHash;
      } else if (node.type === 'template') {
        const templateHash = resolveTemplateContentHash(snapshot, nodeId);
        fresh = !!templateHash
          && ann.contentHash === templateHash
          && (ann.schemaVersion ?? 1) >= CURRENT_ANNOTATION_SCHEMA_VERSION;
      } else if (node.type === 'domain') {
      // Domain freshness mirrors the queue/coverage path in annotations/store.ts: a domain
      // is fresh only when its content hash (the union of member module contentHashes) still
      // matches the stored annotation. Without this branch, domains fell through to the
      // `fresh = true` default and disagreed with get_annotation_status queue/coverage —
      // annotationMeta.fresh:true on a domain the queue reports as staleKind:content.
      const propagation = ctx.getConfig().annotations.propagation ?? DEFAULT_PROPAGATION_CONFIG;
      const currentHash = resolveDomainContentHash(graph, snapshot, nodeId, propagation);
      fresh = currentHash !== undefined
        && ann.contentHash === currentHash
        && (ann.schemaVersion ?? 1) >= CURRENT_ANNOTATION_SCHEMA_VERSION;
    } else {
      // No hash source for this node type. `write_annotation` stored `contentHash: 'unknown'` here,
      // so there is nothing to compare against and `fresh` is left unset rather than asserted.
      fresh = undefined;
    }
    // A stored 'unknown' hash cannot match anything meaningfully, whichever branch resolved above.
    if (ann.contentHash === 'unknown') fresh = undefined;
    view.annotation = ann.annotation;
    const meta: Record<string, unknown> = {
      pass: ann.pass,
      updatedAt: ann.updatedAt,
      ...(fresh === undefined ? {} : { fresh }),
      provenance: annotationFreshnessProvenance(fresh),
    };
    const moduleKind = inferModuleKind({ mod, node });
    if (moduleKind !== 'generic' || mod) meta.moduleKind = moduleKind;
    if (mod) {
      const maxLine = mod.exports.reduce((m, e) => Math.max(m, e.lineRange.end), 0);
      meta.quality = computeAnnotationQuality(ann.annotation, {
        exportCount: mod.exports.length,
        lineCount: maxLine,
        envVars: mod.semanticHints?.envVars,
        moduleKind,
      });
    } else if (nodeId.startsWith('infra:')) {
      const infraMod = snapshot.infraModules?.find(m => m.id === nodeId);
      if (infraMod) {
        meta.quality = computeAnnotationQuality(ann.annotation, {
          exportCount: infraMod.resources.length,
          lineCount: 0,
          moduleKind,
        });
      }
      } else if (node.type === 'domain' || node.type === 'runtime-resource' || node.type === 'template') {
        meta.quality = computeAnnotationQuality(ann.annotation, {
        exportCount: 0,
        lineCount: 0,
        moduleKind,
      });
    }
    view.annotationMeta = meta as NodeViewDetail['annotationMeta'];
  }
  // integrationPoints carrier channel: only the forward-import closure (bounded) is built, and only
  // when this node has integrationPoints, so the direction guard stays a cheap membership check.
  const selfAnnotation = ann?.annotation;
  let dependsOn: ((id: string) => boolean) | undefined;
  if (selfAnnotation?.integrationPoints !== undefined) {
    const closure = forwardImportClosure(graph, nodeId, INVESTIGATE_DEP_GUARD_DEPTH);
    dependsOn = (id) => closure.has(id);
  }
  // Adaptive `hub` threshold: computed once (O(N) over inEdges) and memoized on the graph, so the
  // per-inspect check stays 1-hop. Recomputed when the graph is rebuilt (a fresh graph object).
  const hubThreshold = (graph.hubInDegreeThreshold ??= computeHubInDegreeThreshold(graph));
  applyInvestigateTags(view, annotations, {
    selfAnnotation,
    dependsOn,
    nodeExists: (id) => graph.nodes.has(id),
    hubThreshold,
    // 1-hop importer count for the `hub` tag: count `imports` in-edges only, no traversal.
    importerCount: (id) => {
      const edges = graph.inEdges.get(id);
      if (!edges) return 0;
      let count = 0;
      for (const edge of edges) if (edge.kind === 'imports') count++;
      return count;
    },
    // 1-hop kind+direction edge count for the `wiring`/`co-change` tags.
    edgeCount: graphEdgeCount(graph),
  });
  // Affordance/export count: per-node enumeration floor, read before the page bounds the list. A
  // node with M affordances needs each enumerated with its gate; one gated affordance does not
  // close it.
  const affordanceCount = view.drillDown.length;
  const paginated = paginateNodeViewChildren(view, {
    limit: exportLimit,
    offset: exportOffset,
    summaryOnly: false,
    arg: 'exportOffset',
  });
  Object.assign(view, paginated);
  view.affordanceCount = affordanceCount;
  return view;
}
