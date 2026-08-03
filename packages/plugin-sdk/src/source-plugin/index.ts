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
export { extractPackageName, mintModuleId, packageNameFromId, packageNodeId, toPosixPath } from './module-id.js';
/* ---- budgets a producer slices to and the host cites ---- */
export { CALL_INDEX_PER_DECLARATION_CAP } from './budgets.js';

export { HASH_WIDTH } from '../content-hash.js';
export type { HashWidth } from '../content-hash.js';

/* ---- the mechanics a producer does not write: discovery walk, prune rule, path vocabulary ---- */
export {
  classifyDiscoveryDir,
  readDirSorted,
  shouldWalkDiscoveryDir,
  walkRepository,
} from './discovery-walk.js';
export type { DirSkipReason, PrunedDir, WalkedFile, WalkRepositoryOptions } from './discovery-walk.js';
export { packageMarkersFor } from './dir-layout.js';
export type { DirLayoutTable } from './dir-layout.js';
export { moduleCandidateSuffixes, resolveByCandidates } from './resolve-candidates.js';
export { asHostPath, asPkgRelPath, asRepoRelPath } from '../path-contract.js';
export type { HostPath, PkgRelPath, RepoRelPath } from '../path-contract.js';
export { hostKeyedView, hostPathKey, lastPathSegment, normalizeRelPath, pathMatchKey, repoRelativePosix } from '../paths.js';
export { compareCodeUnits } from '../ordering.js';
export { compileGlob } from '../glob.js';
export type { GlobMatcher } from '../glob.js';
export {
  compileScanPatterns,
  shouldScanInfraPath,
  shouldScanSourcePath,
} from './scan-filters.js';

export { SEMANTIC_HINTS_VERSION, validateSemanticHints } from './semantic-hints-schema.js';
export type { SemanticHintsVersion, SemanticHintsValidationResult } from './semantic-hints-schema.js';

export { validateSemanticModuleDelta } from '../fact-schemas.js';
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
  SourceDiscoveryLogLevel,
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
  RouteDeclarationSite,
  RouteDeclarationSyntax,
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
