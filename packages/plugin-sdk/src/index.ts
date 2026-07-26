/**
 * `@repovine/plugin-sdk` — the public plugin contract. Third parties and built-ins write FACTS
 * through this surface and never name the graph ontology.
 *
 * It deliberately exposes only layer-1 (facts) + authoring machinery:
 *   - factories: defineSourcePlugin / defineIaCParser / defineIaCPlugin
 *   - the source-plugin contract (discover/extract shapes, capabilities, handler resolution)
 *   - the IaC-parser contract (+ the declarative plugin descriptor and registry metadata types)
 *   - the fact types a producer emits (ModuleInfo/SemanticModuleDelta/InfraResource/…)
 *   - the versioned semanticHints schema (the real producer↔consumer coupling surface)
 *   - the runtime primitives: apiVersion, requires, available (graceful degradation)
 *
 * It deliberately does NOT export the projection/ontology layers (GraphDelta, RepositoryGraph,
 * NodeType/EdgeKind, Interpreter) — those are core-only. A plugin that needs one of
 * those is doing layer-2/3 work, which stays in the engine.
 */

/* ---- runtime primitives (apiVersion + graceful-degradation shape) ---- */
export { PLUGIN_API_VERSION } from './runtime.js';
export type { PluginApiVersion, PluginRequirements, PluginAvailability } from './runtime.js';

/* ---- authoring factories ---- */
export { defineSourcePlugin, defineIaCParser, defineIaCPlugin } from './factory.js';
export type { IaCPluginDescriptor } from './factory.js';

/* ---- source-plugin contract ---- */
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
  ModuleIdNormalize,
} from './source-plugin/types.js';

export { resolveDottedPathHandlerToModule } from './source-plugin/handler-resolver.js';
export { mintModuleId } from './source-plugin/module-id.js';

/* ---- semanticHints schema (versioned producer↔consumer contract) ---- */
export { SEMANTIC_HINTS_VERSION, zSemanticHints, validateSemanticHints } from './source-plugin/semantic-hints-schema.js';
export type { SemanticHintsVersion, ZSemanticHints, SemanticHintsValidationResult } from './source-plugin/semantic-hints-schema.js';

/* ---- producer-output fact schemas (untrusted-plugin boundary + conformance gate) ---- */
export {
  zSemanticModuleDelta,
  zSemanticInfraDelta,
  validateSemanticModuleDelta,
  validateSemanticInfraDelta,
} from './fact-schemas.js';
export type { FactValidationResult } from './fact-schemas.js';

/* ---- conformance kit (a plugin runs this to claim SDK compatibility) ---- */
export { checkSourcePluginConformance, checkIaCPluginConformance } from './conformance.js';
export type { ConformanceCheck, ConformanceReport } from './conformance.js';

/* ---- IaC-parser contract + registry metadata ---- */
export type {
  IaCParser,
  IaCDocFormat,
  IaCFileMatch,
  InfraAccessMode,
  InfraEnvRef,
  InfraKind,
  InfraModuleInfo,
  InfraResource,
  InfraResourceKind,
  InfraTrigger,
  InfraTriggerType,
  KnownInfraKind,
  KnownInfraResourceKind,
  KnownInfraTriggerType,
  SemanticInfraDelta,
} from './types.js';

export type {
  InfraKindDomain,
  ResourceKindMeta,
  TriggerTypeMeta,
  TriggerEntryKind,
} from './types.js';

/* ---- source fact types a producer emits ---- */
export type {
  ModuleInfo,
  PackageInfo,
  PendingModule,
  PendingModuleDraft,
  SemanticModuleDelta,
  ImportInfo,
  ReExportInfo,
  ExportInfo,
  ParamInfo,
  FieldInfo,
  MemberInfo,
  InternalInfo,
  SymbolKind,
} from './types.js';

/* ---- semanticHints fact types (the slots a producer fills) ---- */
export type {
  SemanticHints,
  KnownWebFramework,
  WebFramework,
  SsrMarkers,
  RouteInfo,
  ConditionalRender,
  RuntimeAction,
  SecuritySignal,
  // `ui` slot detail types. The schema validates `ui` loosely (passthrough), so these describe a
  // producer's optional rich UI facts; they are exposed so a plugin can type what it emits.
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
} from './types.js';

/* ---- scan-filter types referenced by the discover() contract ---- */
export type {
  CompiledScanPattern,
  CompiledScanPatterns,
  ScanPatternInput,
  ScanScope,
} from './source-plugin/types.js';
