import type { IaCParser } from '../types.js';
import type {
  DocumentLoader,
  TriggerEntryKind,
} from '@repovine/plugin-sdk';
import { compareCodeUnits } from '@repovine/plugin-sdk';
import { domainNodeId } from '../graph/node-ids.js';
import { domainLabelSlug } from '../stage2/domain-slug.js';
import { HOST_DOCUMENT_LOADERS } from './document-loaders.js';

/**
 * The IaC parsers, document loaders and kind→domain metadata active in this isolate.
 *
 * The one loading path installs the whole set and the next build replaces it whole; nothing
 * registers itself here. Installed order is an inventory, not a precedence: a document is offered to
 * every parser whose `fileMatch` and `supports()` claim it, and a disagreement is reported rather
 * than settled by whoever came first.
 */
let parsers: IaCParser[] = [];

export function getParsers(): readonly IaCParser[] {
  return parsers;
}

/** One plugin's IaC capability as the active set holds it. */
export interface ActiveIaCPlugin {
  id: string;
  parsers: readonly IaCParser[];
  kindDomains?: ReadonlyArray<{ kind: string; meta: InfraKindDomain }>;
  /** Document loaders this plugin brings, beyond the `yaml`/`json`/`text` the host provides. */
  loaders?: readonly DocumentLoader[];
}

let activePlugins: ActiveIaCPlugin[] = [];

/**
 * Document loaders by id: the three the host provides, plus whatever the installed plugins bring.
 *
 * A loader id is a shared name — a parser names one to say how its files decode — so two plugins
 * claiming one id is a conflict. The first stands and the second is refused, because silently
 * replacing a decoder would change how every other plugin's files are read.
 */
let documentLoaders = new Map<string, { loader: DocumentLoader; ownerPluginId: string }>();
let loaderRegistrationConflicts: LoaderRegistrationConflict[] = [];

export interface LoaderRegistrationConflict {
  loaderId: string;
  /** The plugin whose loader is in use, then the one that was refused. */
  heldBy: string;
  refused: string;
}

function hostDocumentLoaders(): Map<string, { loader: DocumentLoader; ownerPluginId: string }> {
  const out = new Map<string, { loader: DocumentLoader; ownerPluginId: string }>();
  for (const loader of HOST_DOCUMENT_LOADERS) {
    out.set(loader.id, { loader, ownerPluginId: '<host>' });
  }
  return out;
}

documentLoaders = hostDocumentLoaders();

export function getDocumentLoader(id: string): DocumentLoader | undefined {
  return documentLoaders.get(id)?.loader;
}

/** Loader ids two plugins claimed. Read by the scan so a refused registration is reported once. */
export function getLoaderRegistrationConflicts(): readonly LoaderRegistrationConflict[] {
  return loaderRegistrationConflicts;
}

/**
 * Install this build's IaC plugins, replacing whatever the previous build installed.
 *
 * Everything an IaC plugin contributes is replaced together — parsers, loaders and kind→domain
 * metadata — so a plugin dropped from the config takes all three with it. A build that keeps
 * metadata from a plugin it no longer loads is the accumulation this replacement exists to prevent.
 */
export function installIaCPlugins(next: readonly ActiveIaCPlugin[]): void {
  if (pinnedParsers) return;
  parsers = [];
  activePlugins = [...next];
  documentLoaders = hostDocumentLoaders();
  loaderRegistrationConflicts = [];
  kindDomains = new Map<string, InfraKindDomain>();

  for (const plugin of next) {
    for (const loader of plugin.loaders ?? []) {
      const held = documentLoaders.get(loader.id);
      if (held) {
        loaderRegistrationConflicts.push({
          loaderId: loader.id,
          heldBy: held.ownerPluginId,
          refused: plugin.id,
        });
        continue;
      }
      documentLoaders.set(loader.id, { loader, ownerPluginId: plugin.id });
    }
    for (const parser of plugin.parsers) parsers.push(parser);
    for (const { kind, meta } of plugin.kindDomains ?? []) kindDomains.set(kind, meta);
  }
}

/** Ids of IaC plugins that contributed parsers to the active set, in installed order. */
export function getActiveIaCPluginIds(): string[] {
  return activePlugins.filter(plugin => plugin.parsers.length > 0).map(plugin => plugin.id);
}

/** The installed set, so a caller can install it again with one member added or removed. */
export function getActiveIaCPlugins(): readonly ActiveIaCPlugin[] {
  return activePlugins;
}

/**
 * Set while a test pins the parser list to parsers it constructed in process. See the source set's
 * note: a build installs its own set, and a producer with no package to name needs the pin.
 */
let pinnedParsers = false;

/** Test-only: pin the parsers to this list. The returned callback restores and unpins. */
export function setParsersForTest(next: IaCParser[]): () => void {
  const prev = parsers;
  const wasPinned = pinnedParsers;
  parsers = [...next];
  pinnedParsers = true;
  return () => {
    parsers = prev;
    pinnedParsers = wasPinned;
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

let kindDomains = new Map<string, InfraKindDomain>();

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

/** Every (kind, domain) pair the installed plugins declared — used to seed graph domain nodes. */
export function getActiveKindDomains(): Array<{ kind: string; meta: InfraKindDomain }> {
  return [...kindDomains.entries()].map(([kind, meta]) => ({ kind, meta }));
}

// Declared once in the SDK, which is the published contract a plugin writes against; re-exported so
// engine callers keep reading this vocabulary from the registry that applies it.
export type { TriggerEntryKind };
