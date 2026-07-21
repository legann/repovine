/**
 * Source plugin authoring entrypoint.
 *
 * This subpath is a scoped barrel for authors who want to depend only on the
 * source-producer surface. The root package barrel remains the canonical SDK
 * entrypoint; this file is for discoverability and publish-time subpath imports.
 */

export { defineSourcePlugin } from '../factory.js';
export { PLUGIN_API_VERSION } from '../runtime.js';
export type { PluginApiVersion, PluginRequirements, PluginAvailability } from '../runtime.js';

export { resolveDottedPathHandlerToModule } from './handler-resolver.js';

export { SEMANTIC_HINTS_VERSION, zSemanticHints, validateSemanticHints } from './semantic-hints-schema.js';
export type { SemanticHintsVersion, SemanticHintsValidationResult, ZSemanticHints } from './semantic-hints-schema.js';

export {
  zSemanticModuleDelta,
  validateSemanticModuleDelta,
} from '../fact-schemas.js';
export type { FactValidationResult } from '../fact-schemas.js';

export { checkSourcePluginConformance } from '../conformance.js';
export type { ConformanceCheck, ConformanceReport } from '../conformance.js';

export type {
  SourcePlugin,
  SourcePluginCapabilities,
  SourceFileMatch,
  SourceFileText,
  HandlerResolveContext,
  HandlerResolver,
  SourceDiscoveryOptions,
  SourceDiscoveryResult,
  SourceExtractInput,
  SourceExtractResult,
  CompiledScanPattern,
  CompiledScanPatterns,
  ScanPatternInput,
  ScanScope,
} from './types.js';

export type {
  ModuleInfo,
  PackageInfo,
  PendingModule,
  SemanticModuleDelta,
  ImportInfo,
  ExportInfo,
  ParamInfo,
  FieldInfo,
  MemberInfo,
  InternalInfo,
  SymbolKind,
  SemanticHints,
  KnownWebFramework,
  WebFramework,
  SsrMarkers,
  RouteInfo,
  ConditionalRender,
  RuntimeAction,
  SecuritySignal,
  UiHints,
  UiChildComponentHint,
  UiComponentHint,
  UiComponentLocalSignals,
  UiComponentPropHint,
  UiDataAccess,
  UiFramework,
  UiLifecycleEffect,
  UiNavigationAction,
  UiServiceWrapperHint,
  UiSignalBase,
  UiStateSignal,
  UiSubscriptionAction,
  UiTimerAction,
} from '../types.js';
