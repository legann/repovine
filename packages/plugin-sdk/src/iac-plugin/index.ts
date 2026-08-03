/**
 * IaC plugin authoring entrypoint.
 *
 * This subpath is a scoped barrel for authors who want to depend only on the
 * IaC-producer surface. The root package barrel remains the canonical SDK
 * entrypoint; this file is for discoverability and publish-time subpath imports.
 */

export { defineIaCParser } from '../factory.js';
export { definePlugin } from '../plugin/descriptor.js';
export { makeResourceId, parseResourceId, resourceIdentityProblem } from '../plugin/resource-identity.js';
export type { ResourceIdentity } from '../plugin/resource-identity.js';
export type { DocumentLoader, DocumentLoadInput, LoadedDocument } from '../plugin/document-loader.js';
export type { PluginRuntimeDescriptor, IaCRuntimeCapability } from '../plugin/descriptor.js';
export { PLUGIN_API_VERSION } from '../runtime.js';
export type { PluginApiVersion, PluginRequirements, PluginAvailability } from '../runtime.js';

export { validateSemanticInfraDelta } from '../fact-schemas.js';
export type { FactValidationResult } from '../fact-schemas.js';

/* ---- the one content hash a producer mints, and the canonicalization behind it ---- */
export { hashResourcePayload } from '../resource-hash.js';
export { HASH_WIDTH } from '../content-hash.js';
export type { HashWidth } from '../content-hash.js';
export { asHostPath, asRepoRelPath } from '../path-contract.js';
export type { HostPath, RepoRelPath } from '../path-contract.js';
export { lastPathSegment, normalizeRelPath, repoRelativePosix } from '../paths.js';
export { toPosixPath } from '../source-plugin/module-id.js';

/* ---- folding a document value into the flat attribute map the contract accepts ---- */
export { addAttr, attrValue, isRecord, pathGroupingLabel } from './attributes.js';

export { checkIaCPluginConformance } from '../conformance.js';
export type { ConformanceCheck, ConformanceReport } from '../conformance.js';

export { DOCUMENT_CLAIMS } from '../types.js';
export type {
  IaCParser,
  DocumentClaim,
  IaCFileMatch,
  InfraProvider,
  KnownInfraProvider,
  InfraEnvRef,
  InfraKind,
  InfraKindDomain,
  InfraModuleInfo,
  InfraResource,
  InfraResourceKind,
  InfraTrigger,
  InfraTriggerType,
  KnownInfraKind,
  KnownInfraResourceKind,
  KnownInfraTriggerType,
  ResourceKindMeta,
  SemanticInfraDelta,
  TriggerEntryKind,
  TriggerTypeMeta,
} from '../types.js';
