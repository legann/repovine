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
 * Projection is public through restricted DTOs (`./plugin`): a plugin states contributions and
 * structured references. The graph ontology itself — RepositoryGraph, GraphDelta, NodeType,
 * EdgeKind, Interpreter — stays core-only, so a contribution never freezes the internal model.
 */

/* ---- unified plugin contract: manifest, descriptor, declarations, projection, identity ---- */
export * from './plugin/index.js';

/* ---- runtime primitives (apiVersion + graceful-degradation shape) ---- */
export { PLUGIN_API_VERSION } from './runtime.js';
export type { PluginApiVersion, PluginRequirements, PluginAvailability } from './runtime.js';

/* ---- authoring factories ---- */
export { defineSourcePlugin, defineIaCParser } from './factory.js';

/* ---- source-plugin contract ---- */
export type {
  SourcePlugin,
  SourcePluginCapabilities,
  SourceFileMatch,
  SourceFileText,
  HandlerResolveContext,
  HandlerResolver,
  SourceDiscoveryLogLevel,
  SourceDiscoveryOptions,
  SourceDiscoveryResult,
  SourceExtractInput,
  SourceExtractResult,
  ModuleIdNormalize,
} from './source-plugin/types.js';

export { resolveDottedPathHandlerToModule } from './source-plugin/handler-resolver.js';
export { extractPackageName, mintModuleId, packageNameFromId, packageNodeId, toPosixPath } from './source-plugin/module-id.js';

/* ---- the path vocabulary a producer shares with the engine ---- */
export { hostKeyedView, hostPathKey, lastPathSegment, normalizeRelPath, pathMatchKey, repoRelativePosix } from './paths.js';
export { compareCodeUnits } from './ordering.js';

/* ---- build.scan: the glob dialect and the include/exclude verdict, one per side of the boundary ---- */
export { compileGlob } from './glob.js';
export type { GlobMatcher } from './glob.js';
export {
  compileScanPatterns,
  isScanExcluded,
  isScanIncluded,
  shouldScanInfraPath,
  shouldScanSourcePath,
} from './source-plugin/scan-filters.js';

/* ---- import resolution: the map key convention, and the ladder built from declared facts ---- */
export { moduleCandidateSuffixes, resolveByCandidates } from './source-plugin/resolve-candidates.js';

/* ---- discovery walk: the traversal every producer runs, and where it stops ---- */
export {
  readDirSorted,
  shouldWalkDiscoveryDir,
  walkRepository,
} from './source-plugin/discovery-walk.js';
export type { WalkedFile, WalkRepositoryOptions } from './source-plugin/discovery-walk.js';
export {
  BASE_DIR_LAYOUT,
  currentDirLayoutTable,
  installDirLayoutTable,
} from './source-plugin/dir-layout.js';
export type { DirLayoutTable } from './source-plugin/dir-layout.js';

/* ---- budgets a producer slices to and the host cites ---- */
export { CALL_INDEX_PER_DECLARATION_CAP } from './source-plugin/budgets.js';

/* ---- content hashing (the width a producer's contentHash must carry) ---- */
export { HASH_WIDTH, sha256Hex } from './content-hash.js';

// Shortening a shown value, and the one marker that says it continues.
export { SHORTENED_MARKER, shortenText } from './text.js';

/* ---- the one content hash a producer mints: IaC resource payload ---- */
export { hashResourcePayload } from './resource-hash.js';
export { canonicalJson } from './canonical-json.js';
export type { HashWidth } from './content-hash.js';

/* ---- semanticHints schema (versioned producer↔consumer contract) ---- */
export { SEMANTIC_HINTS_VERSION, zSemanticHints, validateSemanticHints } from './source-plugin/semantic-hints-schema.js';
export type { SemanticHintsVersion, ZSemanticHints, SemanticHintsValidationResult } from './source-plugin/semantic-hints-schema.js';

/* ---- producer-output fact validation (untrusted-plugin boundary + conformance gate) ----
 * The validators, not the schemas behind them: a caller gets a verdict it can branch on, and the
 * schema stays free to change shape. */
export { validateSemanticModuleDelta, validateSemanticInfraDelta } from './fact-schemas.js';
export type { FactValidationResult } from './fact-schemas.js';

/* ---- conformance kit (a plugin runs this to claim SDK compatibility) ---- */
export { checkSourcePluginConformance, checkIaCPluginConformance } from './conformance.js';
export type { ConformanceCheck, ConformanceReport } from './conformance.js';

/* ---- folding a document value into the flat attribute map the IaC contract accepts ---- */
export { addAttr, attrValue, isRecord, pathGroupingLabel } from './iac-plugin/attributes.js';

/* ---- IaC-parser contract + registry metadata ---- */
export { DOCUMENT_CLAIMS } from './types.js';
export type {
  IaCParser,
  DocumentClaim,
  IaCFileMatch,
  InfraProvider,
  KnownInfraProvider,
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

export { TRIGGER_ENTRY_KINDS } from './types.js';
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
  RouteDeclarationSite,
  RouteDeclarationSyntax,
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
  KnownUiFramework,
  KnownUiLifecycleEffectKind,
  KnownUiStateSignalKind,
  UiFramework,
  UiLifecycleEffect,
  UiLifecycleEffectKind,
  UiNavigationAction,
  UiServiceWrapperHint,
  UiSignalBase,
  UiStateSignal,
  UiStateSignalKind,
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
