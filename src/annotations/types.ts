/**
 * Annotation memory schema (stage 3, AI-generated). Split out of `src/types.ts`, which re-exports it
 * for compatibility.
 */
import type { SideEffect } from './side-effect-vocab.js';

/** Bump when adding new optional fields so old annotations re-enter the queue for backfill. */
export const CURRENT_ANNOTATION_SCHEMA_VERSION = 1;

/**
 * Standing risk on the owning node. `scope: "consumer"` marks risks importers must verify locally;
 * `scope: "boundary"` marks an off-limits surface importers must not edit in place.
 */
export type RiskEntry = string | { text: string; scope?: 'local' | 'consumer' | 'boundary' };

export interface AnnotationContent {
  summary: string;
  keyExports?: Record<string, string>;
  assumptions?: string[];
  sideEffects?: SideEffect[];
  risks?: RiskEntry[];
  patterns?: string[];
  flowDescription?: string;
  // domain-level only
  invariants?: string[];
  extensionPoints?: string[];
  // optional extensions (backfill via re-annotation)
  integrationPoints?: string | Record<string, string>;
  stateShape?: string | Record<string, string>;
  dataFlow?: string | Record<string, string>;
  envDependencies?: Record<string, string>;
  /** Audit trail for entrypoint-bounded derived review (optional). */
  propagationSlice?: {
    anchor: string;
    path: string[];
    entrypointId?: string;
    reviewedAt: string;
  };
}

export interface StoredAnnotation {
  nodeId: string;
  nodeType: 'module' | 'export-symbol' | 'domain' | 'runtime-resource' | 'template';
  contentHash: string;
  pass: number;
  updatedAt: string;
  annotation: AnnotationContent;
  /**
   * For code modules: contentHash snapshot of each direct import target at last
   * write/derived-review. Derived-stale when any import hash differs from graph.
   */
  importBaseline?: Record<string, string>;
  /** Schema version; if missing, treated as 1. Annotations with version < CURRENT are considered stale for queue. */
  schemaVersion?: number;
}
