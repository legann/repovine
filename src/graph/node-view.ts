/**
 * MCP node-view projection types: the shape `buildNodeView` produces and MCP tools return. Split out
 * of `src/types.ts`, which re-exports it for compatibility. Lives beside the graph because the view
 * is built here (graph → view); MCP depends on this, not the reverse.
 */
import type { NodeType, EdgeKind, TagEdgeSource } from './model.js';
import type { FieldInfo, ParamInfo, SsrMarkers, SymbolKind, InternalInfo } from '@repovine/plugin-sdk';
import type { AnnotationContent } from '../annotations/types.js';

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
  drill_down: Array<{
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
    lineRange?: { start: number; end: number };
  }>;
  links?: Array<{ targetId: string; relation: EdgeKind; label: string; tagSource?: TagEdgeSource; /** Reasons to inspect the linked node before treating it unchanged. */ investigate?: InvestigateTag[] }>;
  /** Present when buildNodeView caps a high-fanout link set; use dependency tools for full traversal. */
  linksPagination?: {
    total: number;
    returned: number;
    offset: 0;
    truncated: true;
    hint: string;
  };
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
    fresh: boolean;
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
  grepMatches?: Array<{ line: number; text: string; isMatch: boolean }>;
  /** Total matches in the bounded input; see grepInputTruncated when long lines were capped. */
  grepTotalMatches?: number;
  grepError?: string;
  /** True when one or more source lines were tested only up to grepTestedLineCharLimit. */
  grepInputTruncated?: boolean;
  grepTruncatedLineCount?: number;
  grepTestedLineCharLimit?: number;
  /** True when only the first grepMatchLimit matching lines received context in grepMatches. */
  grepMatchesTruncated?: boolean;
  grepMatchLimit?: number;
  body?: string;
  bodyTotalChars?: number;
  bodyHasMore?: boolean;
  bodyNextOffset?: number;
  /** Set when file could not be read for includeBody or when parent module is missing. */
  bodyError?: string;
  /**
   * Count of affordances/exports on this node (mirrors `childPagination.total`). A per-node
   * enumeration floor: list each affordance and its capability gate before reporting the node
   * unchanged. Per-node completeness, not task completeness.
   */
  affordanceCount?: number;
  /** Set when the per-response `investigate` cap dropped tags from some refs. */
  investigateTruncated?: { shownRefs: number; totalRefs: number };
  /**
   * Targets named in this node's `integrationPoints` that it transitively depends on (bounded
   * forward-import closure) and that carry a consumer-scoped risk. A non-structural sibling of a
   * flagged `links`/`drill_down` ref: must-inspect under the same closure.
   */
  investigatePointers?: Array<{ id: string; investigate: InvestigateTag[]; via: 'integrationPoints'; hops: 1 }>;
}

/** One entry in drill_down[]; may include private/internal metadata from MCP options */
export type NodeViewChild = NodeView['drill_down'][number] & {
  access?: 'private' | 'protected' | 'public';
  internal?: boolean;
  internalKind?: InternalInfo['kind'];
};
