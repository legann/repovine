/**
 * IaC plugin authoring entrypoint.
 *
 * This subpath is a scoped barrel for authors who want to depend only on the
 * IaC-producer surface. The root package barrel remains the canonical SDK
 * entrypoint; this file is for discoverability and publish-time subpath imports.
 */

export { defineIaCParser, defineIaCPlugin } from '../factory.js';
export type { IaCPluginDescriptor } from '../factory.js';
export { PLUGIN_API_VERSION } from '../runtime.js';
export type { PluginApiVersion, PluginRequirements, PluginAvailability } from '../runtime.js';

export { validateSemanticInfraDelta } from '../fact-schemas.js';
export type { FactValidationResult } from '../fact-schemas.js';

/* ---- the one content hash a producer mints, and the canonicalization behind it ---- */
export { hashResourcePayload } from '../resource-hash.js';
export { HASH_WIDTH, sha256Hex } from '../content-hash.js';
export type { HashWidth } from '../content-hash.js';
export { lastPathSegment, normalizeRelPath, repoRelativePosix } from '../paths.js';
export { toPosixPath } from '../source-plugin/module-id.js';

export { checkIaCPluginConformance } from '../conformance.js';
export type { ConformanceCheck, ConformanceReport } from '../conformance.js';

export type {
  IaCParser,
  IaCDocFormat,
  IaCFileMatch,
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
