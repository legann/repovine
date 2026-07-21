import type { ToolHandler } from '../types.js';
import { wireEmptyDiagnosticCollectors } from '../response/empty-diagnostics.js';
import { collectEntrypoints } from '../lib/entrypoints.js';
import { collectConfigSurface } from '../lib/config-surface.js';
import { handleSearchContext } from './search-context.js';
import { handleMapContext } from './map-context.js';
import { handleInspectNode } from './inspect-node.js';
import { handleGetEntrypoints } from './get-entrypoints.js';
import { handleTraceFlow } from './trace-flow.js';
import { handleAnalyzeDependencies } from './analyze-dependencies.js';
import { handleGetConfigSurface } from './get-config-surface.js';
import { handleAnalyzeArchitecture } from './analyze-architecture.js';
import { handleGetAnnotationStatus } from './annotations/status.js';
import { handleGetAnnotationMergeStatus, handleMergeAnnotations } from './annotations/merge.js';
import { handleValidateAnnotations } from './annotations/validate.js';
import { handleWriteAnnotation } from './annotations/write.js';
import { handleRefreshContext } from './annotations/refresh.js';
import { handleGetContextSessionQuality } from './context-session-quality.js';
import { handleDeclineAdvisory } from './decline-advisory.js';
import { handleSuggestDomainsConfig } from './suggest-domains-config.js';

wireEmptyDiagnosticCollectors({ collectEntrypoints, collectConfigSurface });

export const toolHandlers: Record<string, ToolHandler> = {
  search_context: handleSearchContext,
  map_context: handleMapContext,
  inspect_node: handleInspectNode,
  get_entrypoints: handleGetEntrypoints,
  trace_flow: handleTraceFlow,
  analyze_dependencies: handleAnalyzeDependencies,
  get_config_surface: handleGetConfigSurface,
  analyze_architecture: handleAnalyzeArchitecture,
  get_annotation_status: handleGetAnnotationStatus,
  get_annotation_merge_status: handleGetAnnotationMergeStatus,
  merge_annotations: handleMergeAnnotations,
  validate_annotations: handleValidateAnnotations,
  write_annotation: handleWriteAnnotation,
  refresh_context: handleRefreshContext,
  suggest_domains_config: handleSuggestDomainsConfig,
  decline_advisory: handleDeclineAdvisory,
  get_context_session_quality: handleGetContextSessionQuality,
};
