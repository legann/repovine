/**
 * Thin engine barrel for the active IaC set and the document loaders the host provides.
 *
 * Built-in parsers ship as their own workspace packages under `packages/plugins/iac-*` and reach the
 * engine through the one plugin loading path (`src/plugins/load.ts`), which installs the whole set.
 * Nothing registers itself by being imported.
 */

export {
  getParsers,
  parserMatchesFile,
  isInfraCandidate,
  resolveLoaderForFile,
  getDocumentLoader,
  setParsersForTest,
  getInfraKindDomain,
  getActiveKindDomains,
} from '../../plugins/iac-set.js';
export type {
  InfraKindDomain,
  TriggerEntryKind,
} from '../../plugins/iac-set.js';

export { HOST_DOCUMENT_LOADERS, TAG_TOLERANT_YAML_SCHEMA } from './document-loaders.js';
