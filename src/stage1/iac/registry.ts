import type { IaCParser } from '../../types.js';
import type {
  DocumentLoader,
  IaCPluginDescriptor,
  ResourceKindMeta,
  TriggerEntryKind,
  TriggerTypeMeta,
} from '@repovine/plugin-sdk';
import { compareCodeUnits } from '@repovine/plugin-sdk';
import { domainNodeId } from '../../graph/node-ids.js';
import { domainLabelSlug } from '../../stage2/domain-slug.js';
import { HOST_DOCUMENT_LOADERS } from './document-loaders.js';

/**
 * Mutable registry of IaC parsers and the document loaders that decode their files.
 *
 * Registration order is an inventory, not a precedence: a document is offered to every parser whose
 * `fileMatch` and `supports()` claim it, and a disagreement is reported rather than settled by
 * whoever registered first.
 */
const parsers: IaCParser[] = [];

export function registerParser(parser: IaCParser): void {
  parsers.push(parser);
}

export function getParsers(): readonly IaCParser[] {
  return parsers;
}

/** Parsers registered by each IaC plugin id, so the loader can remove a plugin's parsers on
 *  `plugins.disable` / `plugins.defaults:false`. Kind/resource/trigger metadata is left registered:
 *  it is additive and inert when no parser emits the matching kind, and an external plugin may rely
 *  on a built-in's resource meta (e.g. lambda `hasCodeHandler`) even when that built-in is disabled. */
const parsersByPluginId = new Map<string, IaCParser[]>();

/**
 * Document loaders by id: the three the host provides, plus whatever plugins registered.
 *
 * A loader id is a shared name — a parser names one to say how its files decode — so two plugins
 * claiming one id is a conflict. The first registration stands and the second is refused, because
 * silently replacing a decoder would change how every other plugin's files are read.
 */
const documentLoaders = new Map<string, { loader: DocumentLoader; ownerPluginId: string }>();
const loaderRegistrationConflicts: LoaderRegistrationConflict[] = [];

export interface LoaderRegistrationConflict {
  loaderId: string;
  /** The plugin whose loader is in use, then the one that was refused. */
  heldBy: string;
  refused: string;
}

function resetDocumentLoaders(): void {
  documentLoaders.clear();
  loaderRegistrationConflicts.splice(0, loaderRegistrationConflicts.length);
  for (const loader of HOST_DOCUMENT_LOADERS) {
    documentLoaders.set(loader.id, { loader, ownerPluginId: '<host>' });
  }
}

resetDocumentLoaders();

export function getDocumentLoader(id: string): DocumentLoader | undefined {
  return documentLoaders.get(id)?.loader;
}

/** Loader ids two plugins claimed. Read by the scan so a refused registration is reported once. */
export function getLoaderRegistrationConflicts(): readonly LoaderRegistrationConflict[] {
  return loaderRegistrationConflicts;
}

/**
 * Register a declarative IaC plugin descriptor (from `defineIaCPlugin`) as a unit: its loaders, its
 * parsers, then its kind/resource/trigger metadata. This is the engine-side counterpart to the
 * authoring factory — built-in bootstrap and the external loader both go through here, so a plugin
 * author never calls the individual `register*` functions directly (keeps the SDK boundary clean).
 */
export function registerIaCPlugin(descriptor: IaCPluginDescriptor): void {
  for (const loader of descriptor.loaders ?? []) {
    const held = documentLoaders.get(loader.id);
    if (held) {
      loaderRegistrationConflicts.push({
        loaderId: loader.id,
        heldBy: held.ownerPluginId,
        refused: descriptor.id,
      });
      continue;
    }
    documentLoaders.set(loader.id, { loader, ownerPluginId: descriptor.id });
  }
  const owned = parsersByPluginId.get(descriptor.id) ?? [];
  for (const parser of descriptor.parsers) {
    registerParser(parser);
    owned.push(parser);
  }
  parsersByPluginId.set(descriptor.id, owned);
  for (const { kind, meta } of descriptor.kindDomains ?? []) registerInfraKindDomain(kind, meta);
  for (const { kind, meta } of descriptor.resourceKindMeta ?? []) registerResourceKindMeta(kind, meta);
  for (const { type, meta } of descriptor.triggerTypeMeta ?? []) registerTriggerTypeMeta(type, meta);
}

/** Remove all parsers registered by an IaC plugin id (loader: disable / defaults:false). Returns
 *  true when the plugin had registered parsers. Metadata is intentionally not removed (see above). */
export function unregisterIaCPlugin(id: string): boolean {
  const owned = parsersByPluginId.get(id);
  if (!owned || owned.length === 0) return false;
  for (const parser of owned) {
    const idx = parsers.indexOf(parser);
    if (idx !== -1) parsers.splice(idx, 1);
  }
  parsersByPluginId.delete(id);
  return true;
}

/** Ids of IaC plugins that currently have registered parsers, in first-registration order. */
export function getRegisteredIaCPluginIds(): string[] {
  return [...parsersByPluginId.keys()];
}

/** Clear all registered parsers, per-plugin tracking and plugin-registered loaders (kind/resource/
 *  trigger metadata is left in place — it is additive/inert). The loader uses this via the IaC
 *  bootstrap to rebuild a clean built-in baseline before applying `plugins.{defaults,add,disable}`
 *  on each build. */
export function resetIaCParsers(): void {
  parsers.splice(0, parsers.length);
  parsersByPluginId.clear();
  resetDocumentLoaders();
}

/** Test-only: replace all registered parsers. Returns a restore callback. */
export function setParsersForTest(next: IaCParser[]): () => void {
  const prev = parsers.splice(0, parsers.length, ...next);
  return () => {
    parsers.splice(0, parsers.length, ...prev);
  };
}

/* ---------------------- file claims ---------------------- */

/**
 * How specifically a parser's `fileMatch` claimed a file.
 *
 * A selector that names the file (`fileNames`, `fileNamePatterns`) says more about it than one that
 * names the format it is written in (`extensions`). The distinction only decides which loader
 * decodes a file two parsers want read differently; it never decides who gets to parse.
 */
export type FileClaimSpecificity = 'by-name' | 'by-extension';

/** How this parser's fileMatch claims (base, ext), or undefined when it does not. */
export function parserFileClaim(
  parser: IaCParser,
  base: string,
  ext: string,
): FileClaimSpecificity | undefined {
  const fm = parser.fileMatch;
  // No selector means the parser asked to see every infra candidate, which is the weakest claim
  // there is: it says nothing about this file in particular.
  if (!fm) return 'by-extension';
  if (fm.fileNames?.includes(base)) return 'by-name';
  if (fm.fileNamePatterns?.some(re => re.test(base))) return 'by-name';
  if (fm.extensions?.includes(ext)) return 'by-extension';
  return undefined;
}

/** Return true when (base, ext) is matched by parser.fileMatch, or parser has no fileMatch. */
export function parserMatchesFile(parser: IaCParser, base: string, ext: string): boolean {
  return parserFileClaim(parser, base, ext) !== undefined;
}

/** True when at least one registered parser claims this file via its fileMatch. */
export function isInfraCandidate(base: string, ext: string): boolean {
  for (const p of parsers) {
    if (parserMatchesFile(p, base, ext)) return true;
  }
  return false;
}

export type FileLoaderResolution =
  | { status: 'resolved'; loaderId: string; loader: DocumentLoader }
  | { status: 'unclaimed' }
  | { status: 'unknown-loader'; loaderId: string; claimedBy: string[] }
  | { status: 'ambiguous'; specificity: FileClaimSpecificity; loaderIds: string[] };

/**
 * Which loader decodes this file.
 *
 * Every parser claiming the file states how it wants the file read. Agreement is the normal case.
 * When they disagree, the parser that named the file outranks the one that named its extension —
 * `vercel.json` is read as JSON even though a CloudFormation parser also accepts `.json`. Two
 * equally specific claims naming different loaders have no order-free answer, so the file is
 * refused instead of decoded by whichever plugin registered first.
 */
export function resolveLoaderForFile(base: string, ext: string): FileLoaderResolution {
  const byName: string[] = [];
  const byExtension: string[] = [];
  for (const parser of parsers) {
    const claim = parserFileClaim(parser, base, ext);
    if (claim === 'by-name') byName.push(parser.loaderId);
    else if (claim === 'by-extension') byExtension.push(parser.loaderId);
  }
  const specificity: FileClaimSpecificity = byName.length > 0 ? 'by-name' : 'by-extension';
  const claimed = byName.length > 0 ? byName : byExtension;
  if (claimed.length === 0) return { status: 'unclaimed' };

  const distinct = [...new Set(claimed)].sort(compareCodeUnits);
  if (distinct.length > 1) return { status: 'ambiguous', specificity, loaderIds: distinct };

  const loaderId = distinct[0];
  const registered = documentLoaders.get(loaderId);
  if (!registered) {
    const claimedBy = [...new Set(
      parsers
        .filter(parser => parser.loaderId === loaderId && parserMatchesFile(parser, base, ext))
        .map(parser => parser.kind),
    )].sort(compareCodeUnits);
    return { status: 'unknown-loader', loaderId, claimedBy };
  }
  return { status: 'resolved', loaderId, loader: registered.loader };
}

/* ---------------------- InfraKind → graph domain registry ---------------------- */

export interface InfraKindDomain {
  domainId: string;
  label: string;
  description: string;
}

const kindDomains = new Map<string, InfraKindDomain>();

export function registerInfraKindDomain(kind: string, meta: InfraKindDomain): void {
  kindDomains.set(kind, meta);
}

/**
 * Resolve a kind to a graph domain. Unknown kinds are mapped to a conventional
 * `domain:infra-<kind>` so new plugins always land in their own bucket instead of silently
 * falling through to a hardcoded default (which used to send everything to infra-sam).
 */
export function getInfraKindDomain(kind: string): InfraKindDomain {
  const explicit = kindDomains.get(kind);
  if (explicit) return explicit;
  const label = domainLabelSlug(`infra-${kind}`);
  return {
    domainId: domainNodeId(label),
    label,
    description: `Domain: ${label} (IaC ${kind})`,
  };
}

/** All explicitly registered (kind, domain) pairs — used to seed graph domain nodes. */
export function getAllRegisteredKindDomains(): Array<{ kind: string; meta: InfraKindDomain }> {
  return [...kindDomains.entries()].map(([kind, meta]) => ({ kind, meta }));
}

/* ---------------------- InfraResourceKind metadata ---------------------- */

// Declared once in the SDK, which is the published contract a plugin writes against; re-exported so
// engine callers keep reading this vocabulary from the registry that applies it.
export type { ResourceKindMeta, TriggerEntryKind, TriggerTypeMeta };

const resourceKindMeta = new Map<string, ResourceKindMeta>();

export function registerResourceKindMeta(kind: string, meta: ResourceKindMeta): void {
  resourceKindMeta.set(kind, meta);
}

export function getResourceKindMeta(kind: string): ResourceKindMeta | undefined {
  return resourceKindMeta.get(kind);
}

/* ---------------------- InfraTrigger type metadata ---------------------- */

const triggerTypeMeta = new Map<string, TriggerTypeMeta>();

export function registerTriggerTypeMeta(type: string, meta: TriggerTypeMeta): void {
  triggerTypeMeta.set(type, meta);
}

export function getTriggerTypeMeta(type: string): TriggerTypeMeta | undefined {
  return triggerTypeMeta.get(type);
}
