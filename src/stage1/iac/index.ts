/**
 * Thin engine barrel for the IaC registry, shared utilities, and CloudFormation-safe YAML schema.
 *
 * Built-in parsers used to live here as side-effect registrations; they have moved into
 * `src/iac-plugins/<vendor>/` and are bootstrapped explicitly from `./bootstrap.ts`. Engine modules
 * that need parsers to be registered should `import './bootstrap.js'` (side-effect) rather than
 * this barrel.
 */

export {
  getParsers,
  registerParser,
  parserMatchesFile,
  isInfraCandidate,
  pickDocFormatForFile,
  setParsersForTest,
  registerInfraKindDomain,
  getInfraKindDomain,
  getAllRegisteredKindDomains,
  registerResourceKindMeta,
  getResourceKindMeta,
  registerTriggerTypeMeta,
  getTriggerTypeMeta,
} from './registry.js';
export type {
  InfraKindDomain,
  ResourceKindMeta,
  TriggerTypeMeta,
  TriggerEntryKind,
} from './registry.js';

export {
  hashResourcePayload,
  isRecord,
  attrValue,
  addAttr,
  pathBasedDomainsFromRelPath,
} from './utils.js';

export { CLOUDFORMATION_SAFE_SCHEMA } from './yaml-schema.js';
