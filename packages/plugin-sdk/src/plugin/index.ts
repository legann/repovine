/**
 * Plugin authoring entrypoint: manifest, runtime descriptor, declarations, projection and identity.
 *
 * This subpath is the whole contract for a package that ships a plugin. The root barrel re-exports
 * it, so an author may import from either; nothing here reaches the graph model, its node types or
 * its edge kinds, which stay internal to the engine.
 *
 * Validators are published, the schemas behind them are not: a caller branches on a verdict, and
 * the schema stays free to change shape. The same applies to the id and path spelling rules — the
 * validators report what they refuse.
 */

export { PLUGIN_MANIFEST_KIND, validatePluginManifest } from './manifest.js';
export type { PluginManifest, PluginManifestKind, PluginManifestValidation } from './manifest.js';

export {
  PLUGIN_CAPABILITY_NAMES,
  definePlugin,
  validatePluginRuntimeDescriptor,
} from './descriptor.js';
export type {
  DescriptorValidation,
  IaCRuntimeCapability,
  PluginCapabilities,
  PluginCapabilityName,
  PluginRuntimeDescriptor,
  SourceRuntimeCapability,
} from './descriptor.js';

export { ECOSYSTEM_DIR_ROLES, resourceKindMetaKey, stampDeclarationCatalog } from './declarations.js';
export type {
  Declared,
  EcosystemDirFact,
  EcosystemDirRole,
  PluginDeclarationCatalog,
  PluginOwnerIdentity,
  PluginValueDeclaration,
  ResourceKindDeclaration,
  StampedDeclarationCatalog,
  TriggerTypeDeclaration,
} from './declarations.js';

export { ENTRYPOINT_CONTRIBUTION_KINDS, PROJECTION_REF_TYPES, SEMANTIC_LINK_RELATIONS } from './projection.js';
export type {
  ApiRouteEntrypointContribution,
  ConditionalRenderEntrypointContribution,
  ContributionProvenance,
  EntrypointContribution,
  EntrypointContributionKind,
  ExtensionRecord,
  FileRouteEntrypointContribution,
  NamespacedExtensionContribution,
  PluginProjectionBatch,
  PluginProjectionDelta,
  ProjectionContributor,
  ProjectionFactSelector,
  ProjectionRef,
  ProjectionRefType,
  ReadonlyFactRecord,
  ReadonlyFactView,
  ReadonlyModuleFact,
  ReadonlyProjectionInput,
  ResourceTriggerEntrypointContribution,
  RuntimeResourceContribution,
  SemanticLinkContribution,
  SemanticLinkRelation,
  UiRouteEntrypointContribution,
} from './projection.js';

export { PROJECTION_BUDGETS, checkProjectionRefs, validateProjectionBatch } from './projection-schema.js';
export type {
  AcceptedProjectionBatch,
  ProjectionRefProblem,
  ProjectionRefProblemReason,
  ProjectionValidation,
} from './projection-schema.js';

export type { DocumentLoader, DocumentLoadInput, LoadedDocument } from './document-loader.js';

export {
  RESOURCE_ID_PREFIX,
  makeResourceId,
  parseResourceId,
  resourceIdentityProblem,
} from './resource-identity.js';
export type { ResourceIdentity } from './resource-identity.js';

export { isJsonValue } from './json.js';
export type { JsonValue } from './json.js';

export { checkPluginConformance } from './conformance.js';
export type { PluginConformanceInput } from './conformance.js';
