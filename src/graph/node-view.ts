/**
 * MCP node-view projection types: the shape `buildNodeView` produces and MCP tools return. Split out
 * of `src/types.ts`, which re-exports it for compatibility. Lives beside the graph because the view
 * is built here (graph → view); MCP depends on this, not the reverse.
 */
import type { NodeType, EdgeKind, TagEdgeSource } from './model.js';
import type { ExtensionRecord, FieldInfo, ParamInfo, SsrMarkers, SymbolKind, InternalInfo } from '@repovine/plugin-sdk';
import type { AnnotationContent } from '../annotations/types.js';
import type { StaleReason } from '../annotations/freshness.js';
import type { TruncationMap } from '../response/truncation.js';
import type { Provenance } from '../response/provenance.js';

/**
 * Reasons a 1-hop reference is worth inspecting before treating its target unchanged. Each tag has a
 * structured source: `risk` (consumer-scoped risk), `boundary` (boundary-scoped risk — off-limits
 * surface), `effect` (declared persistent side effect), `wiring` (runtime `infra`/`binds_to` edges —
 * deployed topology attaches to the target), `co-change` (`implements` edges — contract and
 * implementations move together), `hub` (≥ HUB_IMPORTER_FLOOR import in-edges).
 * `unannotated` is reserved. Tags are a floor: presence is must-inspect, absence is not absence of work.
 */
export type InvestigateTag = 'risk' | 'boundary' | 'effect' | 'unannotated' | 'wiring' | 'co-change' | 'hub';

export interface NodeView {
  id: string;
  level: number;
  label: string;
  description: string;
  content?: string;
  drillDown: Array<{
    id: string;
    label: string;
    type: NodeType;
    /** Reasons to inspect this child before treating it unchanged. A floor: presence flags must-inspect, absence is not absence of work. */
    investigate?: InvestigateTag[];
    signature?: string;
    symbolKind?: SymbolKind;
    typeValue?: string;
    fields?: FieldInfo[];
    implementsInterfaces?: string[];
    calls?: string[];
    /** Bounds that bit on this child preview: `calls` when the extraction cap dropped callee names. */
    truncation?: TruncationMap;
    lineRange?: { start: number; end: number };
  }>;
  links?: Array<{ targetId: string; relation: EdgeKind; label: string; tagSource?: TagEdgeSource; /** Reasons to inspect the linked node before treating it unchanged. */ investigate?: InvestigateTag[] }>;
  /**
   * Bounds that bit on this view, keyed by what they bounded: `links` when the link set was capped,
   * `children` when the child page did not reach the end, `calls` when the extraction cap dropped
   * callee names, and on a detail view `body`, `grepMatches`, `grepInput`, `investigateRefs`.
   */
  truncation?: TruncationMap;
  // symbol detail (level 4, only for export-symbol nodes)
  signature?: string;
  params?: ParamInfo[];
  returnType?: string;
  typeValue?: string;
  fields?: FieldInfo[];
  implementsInterfaces?: string[];
  calls?: string[];
  lineRange?: { start: number; end: number };
  symbolKind?: SymbolKind;
  // content-based enrichments (module nodes)
  envVars?: string[];
  hasRoutes?: boolean;
  ssr?: SsrMarkers;
  /** Source plugin that produced this module node ('typescript' | 'python' | …). */
  sourcePluginId?: string;
  // annotation note (AI-generated, from annotation store)
  annotation?: AnnotationContent;
  annotationMeta?: {
    pass: number;
    updatedAt: string;
    /**
     * Whether the annotation is still confirmed for this node: its content hash matches, its schema
     * is current, and no module it imports drifted since the note was written. Omitted for a node
     * kind that carries no hash at all, where reporting either value would state a verification that
     * never ran. Read together with `staleReason` and `provenance`.
     */
    fresh?: boolean;
    /** Which check decided `fresh: false`; always present when `fresh` is `false`. */
    staleReason?: StaleReason;
    /** How `fresh` was decided, or why it is absent. */
    provenance?: Provenance;
    /** Inferred module kind (types/ui/api-handler/adapter/service-mgr/infra/runtime-resource/template/domain/generic). */
    moduleKind?: string;
    /** Annotation quality scoring (omitted for non-module nodes that lack export/line metrics). */
    quality?: {
      score: number;
      tier: 'minimal' | 'basic' | 'detailed' | 'comprehensive';
      missingFields: string[];
      moduleKind?: string;
    };
  };
}

/** Node view with optional MCP enrichments (body, grep, etc.) */
export interface NodeViewDetail extends NodeView {
  /** Matching lines with surrounding context; a matching line carries `isMatch`. */
  grepMatches?: Array<{ line: number; text: string; isMatch: boolean }>;
  grepError?: string;
  body?: string;
  /** Set when file could not be read for includeBody or when parent module is missing. */
  bodyError?: string;
  /**
   * Namespaced extensions a plugin attached to this node, with owner and provenance.
   *
   * These are echoed, not interpreted: no traversal, dependency or architecture answer reads a
   * payload, and an extension is never presented as a canonical graph fact. Omitted when the node
   * carries none.
   */
  extensions?: ExtensionRecord[];
  /**
   * Count of affordances/exports on this node. A per-node enumeration floor: list each affordance
   * and its capability gate before reporting the node unchanged. Per-node completeness, not task
   * completeness.
   */
  affordanceCount?: number;
  /**
   * Targets named in this node's `integrationPoints` that it transitively depends on (bounded
   * forward-import closure) and that carry a consumer-scoped risk. A non-structural sibling of a
   * flagged `links`/`drillDown` ref: must-inspect under the same closure.
   *
   * Membership is decided by a closure of depth {@link INVESTIGATE_DEP_GUARD_DEPTH}, which records
   * no per-target distance, so no hop count is emitted.
   */
  investigatePointers?: Array<{ id: string; investigate: InvestigateTag[]; via: 'integrationPoints' }>;
}

/** One entry in drillDown[]; may include private/internal metadata from MCP options */
export type NodeViewChild = NodeView['drillDown'][number] & {
  access?: 'private' | 'protected' | 'public';
  internal?: boolean;
  internalKind?: InternalInfo['kind'];
};
