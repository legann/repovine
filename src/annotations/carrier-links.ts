import { forwardImportClosure, owningModuleId } from '../graph/index.js';
import { compareCodeUnits } from '../platform/ordering.js';
import { NODE_ID_PREFIXES } from '../graph/node-ids.js';
import type { AnnotationContent, RepositoryGraph, StoredAnnotation } from '../types.js';
import { hasBoundaryScopedRisk, hasConsumerScopedRisk } from './format.js';
import { isRuntimeImportEdge } from '../analysis/architecture/heuristics.js';
import { nodeInScopeHints } from './scope-hints.js';

/** Forward-import-closure depth for carrier-link authoring advisories. */
export const CARRIER_LINK_DEP_GUARD_DEPTH = 4;
/** Max concrete carrier-link pairs returned in validation payloads. */
export const CARRIER_LINK_GAP_SAMPLE_LIMIT = 10;

/**
 * Node-id tokens the engine understands inside annotation prose (`mod:`, `export:`, etc.).
 *
 * Built from the declared prefix vocabulary: prose that names a node is read with the same list the
 * rest of the engine uses. Spelled out here, it had lost `pkg:` and read a package a caller had
 * named as ordinary text.
 */
export const NODE_ID_TOKEN_RE = new RegExp(`(?:${NODE_ID_PREFIXES.join('|')}):[A-Za-z0-9_./@:-]+`, 'g');

export type CarrierLinkGapKind = 'missing-carrier-link' | 'named-but-undeliverable';

export interface CarrierLinkGapSample {
  kind: CarrierLinkGapKind;
  importerId: string;
  targetId: string;
}

export interface CarrierLinkGaps {
  missingCarrierLinks: number;
  namedButUndeliverable: number;
  /** Consumer-risk targets excluded from the missing-carrier-link loop by reviewed suppression state. */
  suppressedTargets: number;
  sample: CarrierLinkGapSample[];
}

export const EMPTY_CARRIER_LINK_GAPS: CarrierLinkGaps = {
  missingCarrierLinks: 0,
  namedButUndeliverable: 0,
  suppressedTargets: 0,
  sample: [],
};

function emptyCarrierLinkGaps(): CarrierLinkGaps {
  return { ...EMPTY_CARRIER_LINK_GAPS, sample: [] };
}

function hasImportEdgeMaps(graph: RepositoryGraph): boolean {
  return graph.outEdges instanceof Map;
}

/** Parse nodeId tokens out of an `integrationPoints` value, keeping graph hits when requested. */
export function parseIntegrationPointTargets(
  integrationPoints: AnnotationContent['integrationPoints'],
  options: { nodeExists?: (id: string) => boolean } = {},
): string[] {
  if (!integrationPoints) return [];
  const text = typeof integrationPoints === 'string'
    ? integrationPoints
    : Object.entries(integrationPoints).flat().join(' ');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(NODE_ID_TOKEN_RE)) {
    // Trim trailing punctuation captured from prose (ids end in a word char or `_`).
    const id = match[0].replace(/[^A-Za-z0-9_]+$/, '');
    if (seen.has(id) || (options.nodeExists && !options.nodeExists(id))) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function containedExportIds(graph: RepositoryGraph, moduleId: string): string[] {
  const out: string[] = [];
  for (const edge of graph.outEdges.get(moduleId) ?? []) {
    if (edge.kind !== 'contains') continue;
    const node = graph.nodes.get(edge.to);
    if (node?.type === 'export-symbol') out.push(edge.to);
  }
  return out;
}

function equivalentCarrierIds(graph: RepositoryGraph, nodeId: string): string[] {
  const out = [nodeId];
  const owner = owningModuleId(nodeId);
  if (owner) out.push(owner);
  const node = graph.nodes.get(nodeId);
  if (node?.type === 'module') out.push(...containedExportIds(graph, nodeId));
  return out;
}

function namedMatchesTarget(graph: RepositoryGraph, namedIds: Set<string>, targetId: string): boolean {
  if (namedIds.has(targetId)) return true;
  const owner = owningModuleId(targetId);
  if (owner && namedIds.has(owner)) return true;
  for (const namedId of namedIds) {
    if (owningModuleId(namedId) === targetId) return true;
  }
  return equivalentCarrierIds(graph, targetId).some((id) => namedIds.has(id));
}

function closureHasCarrierTarget(graph: RepositoryGraph, closure: Set<string>, targetId: string): boolean {
  if (closure.has(targetId)) return true;
  const owner = owningModuleId(targetId);
  if (owner && closure.has(owner)) return true;
  return containedExportIds(graph, targetId).some((id) => closure.has(id));
}

function targetDependsOnImporter(graph: RepositoryGraph, targetId: string, importerId: string): boolean {
  const starts = new Set<string>([targetId]);
  const owner = owningModuleId(targetId);
  if (owner) starts.add(owner);
  for (const start of starts) {
    if (!graph.nodes.has(start)) continue;
    if (forwardImportClosure(graph, start, CARRIER_LINK_DEP_GUARD_DEPTH).has(importerId)) return true;
  }
  return false;
}

function annotationForCarrierId(
  graph: RepositoryGraph,
  annotations: Record<string, StoredAnnotation>,
  nodeId: string,
  predicate: (content: AnnotationContent | undefined) => boolean,
): StoredAnnotation | undefined {
  for (const id of equivalentCarrierIds(graph, nodeId)) {
    const annotation = annotations[id];
    if (predicate(annotation?.annotation)) return annotation;
  }
  return undefined;
}

function directImportTargets(graph: RepositoryGraph, importerId: string): Set<string> {
  const out = new Set<string>();
  for (const edge of graph.outEdges.get(importerId) ?? []) {
    if (edge.kind === 'imports') out.add(edge.to);
  }
  return out;
}

/**
 * Delegation predicate for missing-carrier-link candidates: some runtime intermediate `M`
 * (`I → M → T`, both hops value imports, `M` outside the target's equivalence set) reaches the
 * target. A type import cannot delegate behavior; deeper (3–4 hop) chains are not a delegation
 * shape — each hop already gets the structural 1-hop `risk` tag at its own boundary.
 */
function hasRuntimeTwoHopDelegation(
  graph: RepositoryGraph,
  importerId: string,
  targetEquivalents: ReadonlySet<string>,
): boolean {
  for (const first of graph.outEdges.get(importerId) ?? []) {
    if (!isRuntimeImportEdge(first) || targetEquivalents.has(first.to)) continue;
    for (const second of graph.outEdges.get(first.to) ?? []) {
      if (isRuntimeImportEdge(second) && targetEquivalents.has(second.to)) return true;
    }
  }
  return false;
}

function structuralCarrierTargets(graph: RepositoryGraph, importerId: string): Set<string> {
  return new Set<string>([
    ...directImportTargets(graph, importerId),
    ...containedExportIds(graph, importerId),
  ]);
}

function carrierSampleSort(a: CarrierLinkGapSample, b: CarrierLinkGapSample): number {
  if (a.kind !== b.kind) return a.kind === 'missing-carrier-link' ? -1 : 1;
  return compareCodeUnits(a.importerId, b.importerId) || compareCodeUnits(a.targetId, b.targetId);
}

function consumerRiskTargets(graph: RepositoryGraph, annotations: Record<string, StoredAnnotation>): string[] {
  const out: string[] = [];
  for (const [nodeId, ann] of Object.entries(annotations)) {
    if (!hasConsumerScopedRisk(ann.annotation)) continue;
    const node = graph.nodes.get(nodeId);
    if (node?.type === 'module' || node?.type === 'export-symbol') out.push(nodeId);
  }
  return out.sort();
}

function isCarrierImporter(graph: RepositoryGraph, nodeId: string): boolean {
  const node = graph.nodes.get(nodeId);
  return node?.type === 'module' || node?.type === 'template';
}

export function computeCarrierLinkGaps(input: {
  graph: RepositoryGraph;
  annotations: Record<string, StoredAnnotation>;
  scopeHints?: string[];
  depth?: number;
  sampleLimit?: number;
  /** Target node ids reviewed as "not a gap" (hash-validated by the caller); excluded from the
   *  missing-carrier-link loop and reported via `suppressedTargets`. */
  suppressedTargetIds?: ReadonlySet<string>;
}): CarrierLinkGaps {
  if (!hasImportEdgeMaps(input.graph)) return emptyCarrierLinkGaps();
  const depth = input.depth ?? CARRIER_LINK_DEP_GUARD_DEPTH;
  const sampleLimit = input.sampleLimit ?? CARRIER_LINK_GAP_SAMPLE_LIMIT;
  const suppressed = input.suppressedTargetIds;
  const samples: CarrierLinkGapSample[] = [];
  let missingCarrierLinks = 0;
  let namedButUndeliverable = 0;
  const consumerTargets = consumerRiskTargets(input.graph, input.annotations);
  const suppressedTargets = suppressed ? consumerTargets.filter((id) => suppressed.has(id)).length : 0;
  const candidateTargets = suppressed ? consumerTargets.filter((id) => !suppressed.has(id)) : consumerTargets;
  const equivalentsByTarget = new Map<string, Set<string>>(
    candidateTargets.map((id) => [id, new Set(equivalentCarrierIds(input.graph, id))]),
  );

  for (const [importerId, importerAnnotation] of Object.entries(input.annotations).sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (!isCarrierImporter(input.graph, importerId)) continue;
    if (!nodeInScopeHints(importerId, input.scopeHints)) continue;

    const structural = structuralCarrierTargets(input.graph, importerId);
    const namedTargets = parseIntegrationPointTargets(importerAnnotation.annotation.integrationPoints, {
      nodeExists: (id) => input.graph.nodes.has(id),
    });
    const named = new Set(namedTargets);

    for (const targetId of candidateTargets) {
      const equivalents = equivalentsByTarget.get(targetId);
      if (!equivalents) continue;
      // An importer cannot be its own delegation SSOT: in a runtime import cycle (I ⇄ M) the 2-hop
      // walk returns to the importer. The replaced closure gate excluded the start node; keep that.
      if (equivalents.has(importerId)) continue;
      let structuralOwnsDelivery = false;
      for (const id of equivalents) {
        if (structural.has(id)) { structuralOwnsDelivery = true; break; }
      }
      if (structuralOwnsDelivery) continue;
      if (namedMatchesTarget(input.graph, named, targetId)) continue;
      if (!hasRuntimeTwoHopDelegation(input.graph, importerId, equivalents)) continue;
      missingCarrierLinks++;
      samples.push({ kind: 'missing-carrier-link', importerId, targetId });
    }

    if (namedTargets.length > 0) {
      const closure = forwardImportClosure(input.graph, importerId, depth);
      for (const targetId of namedTargets) {
        if (closureHasCarrierTarget(input.graph, closure, targetId)) continue;
        if (targetDependsOnImporter(input.graph, targetId, importerId)) continue;
        const hasDeliveryIntent = annotationForCarrierId(
          input.graph,
          input.annotations,
          targetId,
          (content) => hasConsumerScopedRisk(content) || hasBoundaryScopedRisk(content),
        );
        if (!hasDeliveryIntent) continue;
        namedButUndeliverable++;
        samples.push({ kind: 'named-but-undeliverable', importerId, targetId });
      }
    }
  }

  return {
    missingCarrierLinks,
    namedButUndeliverable,
    suppressedTargets,
    sample: samples.sort(carrierSampleSort).slice(0, sampleLimit),
  };
}
