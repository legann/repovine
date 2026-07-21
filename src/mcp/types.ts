/**
 * Shared MCP handler types and node-id resolution.
 */

import type {
  RepositoryGraph,
  RepositoryFactsSnapshot,
  ModuleInfo,
} from '../types.js';
import type { AnnotationStore } from '../annotations/store.js';
import type { DomainsConfig } from '../stage2/domains.js';
import type { DomainsSuggestion } from '../stage2/domains-advisor.js';
import type { RefactoringThresholds } from '../analysis/architecture/config.js';
import type { ContextSessionStore } from '../context-quality/session-store.js';
import type { SearchIndex } from './lib/search-index.js';
import type { SemanticIndex } from '../semantic/store.js';

export type { SearchIndex } from './lib/search-index.js';

/** Compact semantic-search sync outcome surfaced by refresh_context. */
export type SemanticSearchRefresh =
  | { status: 'disabled' }
  | { status: 'up_to_date'; total: number }
  | { status: 'updated'; embedded: number; total: number }
  | { status: 'failed'; total: number; error: string };

export interface RepovineState {
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  /** O(1) lookup by module id; built at same time as graph. */
  modulesById: Map<string, ModuleInfo>;
  /** Token index over graph nodes + annotation text; rebuilt after annotations load. */
  searchIndex: SearchIndex;
  /** Local semantic search embedding index over node cards; null when semantic_search_embeddings is false. */
  semanticIndex: SemanticIndex | null;
  /** Outcome of the last stage-3 semantic index sync (refresh_context reports this). */
  semanticSearchRefresh: SemanticSearchRefresh;
  annotations: AnnotationStore;
  /** Domains config (domain registry, aliases, infra filters); loaded once at state build. */
  domainsConfig: DomainsConfig | null;
  /** Additive domains-config suggestions derived from the current graph and declined cache. */
  domainsSuggestions: DomainsSuggestion;
  /** Refactoring thresholds resolved from strictness profile + per-knob overrides. */
  refactoringThresholds: RefactoringThresholds;
  builtAt: string;
}

export interface RefreshRepoStateOptions {
  /** Re-read repovine.config.json and rebuild with the newly resolved config. */
  reloadConfig?: boolean;
}

export interface RefreshRepoStateResult {
  /** True when the MCP controller replaced its runtime with one built from reloaded config. */
  configReloaded?: boolean;
}

export interface McpToolRuntime {
  /** Cooperative-cancel signal for THIS tool call, from the MCP request (aborted on the client's
   *  notifications/cancelled). Long-running ops (refresh rebuild, semantic embed, regex worker,
   *  build long-poll) honor it so a cancelled request stops work instead of running to completion. */
  signal?: AbortSignal;
  getState: () => RepovineState;
  /** Resolved repovine.config.json (includes annotations.propagation). */
  getConfig: () => import('../config.js').ResolvedConfig;
  /** Call to rebuild graph/snapshot/annotations; then getState() returns new state. */
  refreshRepoState: (options?: RefreshRepoStateOptions) =>
    void | RefreshRepoStateResult | Promise<void | RefreshRepoStateResult>;
  repoRoot: string;
  contextQualityStore?: ContextSessionStore;
  /** Resolved context-session id for THIS call (env override / contextSessionId / sessionId arg).
   *  Plumbed by executeTool because the raw args are stripped before handlers run. */
  contextSessionId?: string;
}

export function resolveNodeId(graph: RepositoryGraph, rawId: string): string | undefined {
  if (graph.nodes.has(rawId)) return rawId;
  const normalized = rawId
    .replace(/\.(tsx?|jsx?)$/, '')
    .replace(/\/index$/, '');
  return graph.nodes.has(normalized) ? normalized : undefined;
}

export type ToolHandler = (ctx: McpToolRuntime, args: Record<string, unknown>) => unknown | Promise<unknown>;
