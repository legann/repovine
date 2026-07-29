/**
 * Thin engine barrel for the IaC registry and the document loaders the host provides.
 *
 * Built-in parsers ship as their own workspace packages under `packages/plugins/iac-*` and are
 * bootstrapped explicitly from `./bootstrap.ts`. Engine modules that need parsers to be registered
 * should `import './bootstrap.js'` (side-effect) rather than this barrel.
 */

export {
  getParsers,
  registerParser,
  parserMatchesFile,
  isInfraCandidate,
  resolveLoaderForFile,
  getDocumentLoader,
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

export { HOST_DOCUMENT_LOADERS, TAG_TOLERANT_YAML_SCHEMA } from './document-loaders.js';
