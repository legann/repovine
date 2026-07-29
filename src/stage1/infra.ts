import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InfraModuleInfo, InfraResource, PackageInfo } from '../types.js';
import {
  HASH_WIDTH,
  canonicalJson,
  compareCodeUnits,
  makeResourceId,
  sha256Hex,
  walkRepository,
} from '@repovine/plugin-sdk';
import type { IaCParser, LoadedDocument } from '@repovine/plugin-sdk';
import {
  getLoaderRegistrationConflicts,
  getParsers,
  isInfraCandidate,
  parserMatchesFile,
  resolveLoaderForFile,
} from '../plugins/iac-set.js';
import type { CompiledScanPatterns } from '../scan-filters.js';
import { shouldScanInfraPath } from '../scan-filters.js';
import { infraNodeId } from '../graph/node-ids.js';
import { refusal, type Refusal } from '../response/refusal.js';
import {
  IAC_DOCUMENT_CLAIM_CONFLICT_REFUSAL,
  IAC_LOADER_AMBIGUOUS_REFUSAL,
  IAC_LOADER_CLAIMED_TWICE_REFUSAL,
  IAC_LOADER_UNKNOWN_REFUSAL,
  RESOURCE_IDENTITY_CONFLICT_REFUSAL,
} from './refusal-kinds.js';

export interface InfraScanOptions {
  repoRoot: string;
  /** Unused by the scan itself (infra discovery is filesystem-driven from repoRoot); kept
   * optional so callers may pass it without effect. */
  packages?: PackageInfo[];
  /** Compiled `scan.include` / `scan.exclude` from repovine.config.json. */
  scanPatterns?: CompiledScanPatterns;
}

/** What the scan found, and what it declined to read. A refused file is absent from `modules`. */
export interface InfraScanResult {
  modules: InfraModuleInfo[];
  refusals: Refusal[];
}

/**
 * Recursively discover candidate infra files under dir, relative to repoRoot.
 * A file is a candidate if any registered parser claims it via its fileMatch (or if a parser
 * declared no fileMatch, in which case it sees everything).
 */
function discoverInfraFiles(repoRoot: string, dir: string, out: { filePath: string; relPath: string }[]): void {
  walkRepository(dir, {
    repoRoot,
    onFile: ({ absPath, relFromRoot, name }) => {
      const ext = path.extname(name).toLowerCase();
      if (!isInfraCandidate(name, ext)) return;
      out.push({ filePath: absPath, relPath: relFromRoot });
    },
  });
}

function mergeInfraModule(
  infraModules: InfraModuleInfo[],
  byId: Map<string, InfraModuleInfo>,
  mod: InfraModuleInfo,
): void {
  const existing = byId.get(mod.id);
  if (!existing) {
    byId.set(mod.id, mod);
    infraModules.push(mod);
    return;
  }

  // Same id ⇒ same kind ⇒ same relPath ⇒ same file, so the engine-stamped module contentHash is
  // already identical; only the per-document resources need to be folded together.
  existing.resources.push(...mod.resources);
}

/** Engine-owned module fingerprint: hash the raw infra file once, like collectTemplates.
 * Empty sentinel when unreadable so a later run re-reads. */
function infraFileContentHash(bytes: Uint8Array): string {
  return sha256Hex(Buffer.from(bytes).toString('utf8'), HASH_WIDTH.content);
}

function readFileBytes(filePath: string, relPath: string): Uint8Array | null {
  try {
    return fs.readFileSync(filePath);
  } catch (err) {
    if (process.env.REPOVINE_VERBOSE) {
      console.warn(`  ⚠ Infra: failed to read ${relPath}:`, (err as Error).message);
    }
    return null;
  }
}

/**
 * Decode one candidate file, or say why it was not decoded.
 *
 * The host reads the bytes and the registry decides which loader sees them, so a parser never
 * reaches the filesystem and never learns to decode a format a second way. A loader that throws on
 * malformed input yields no documents: unreadable content is a property of the file, not a refusal
 * the build has to name, and the existing verbose channel already reports it.
 */
function loadDocuments(
  filePath: string,
  relPath: string,
  bytes: Uint8Array,
  refusals: Refusal[],
): readonly LoadedDocument[] {
  const base = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const resolution = resolveLoaderForFile(base, ext);

  if (resolution.status === 'unclaimed') return [];
  if (resolution.status === 'ambiguous') {
    refusals.push(refusal(
      'conflict',
      IAC_LOADER_AMBIGUOUS_REFUSAL,
      `${relPath} is claimed ${resolution.specificity === 'by-name' ? 'by name' : 'by extension'} `
      + `by parsers asking for different document loaders (${resolution.loaderIds.join(', ')}), `
      + 'so it was not decoded. Have the parsers name one loader, or let one of them claim the file '
      + 'by name so its loader decides.',
      { relativeFilePath: relPath, loaderIds: [...resolution.loaderIds] },
    ));
    return [];
  }
  if (resolution.status === 'unknown-loader') {
    refusals.push(refusal(
      'not-found',
      IAC_LOADER_UNKNOWN_REFUSAL,
      `${relPath} asks for the document loader "${resolution.loaderId}", which no plugin registered, `
      + 'so it was not decoded. Register the loader with the plugin descriptor that names it.',
      {
        relativeFilePath: relPath,
        loaderId: resolution.loaderId,
        claimedBy: [...resolution.claimedBy],
      },
    ));
    return [];
  }

  try {
    return resolution.loader.load({ relativeFilePath: relPath, content: bytes });
  } catch (err) {
    if (process.env.REPOVINE_VERBOSE) {
      console.warn(`  ⚠ Infra: loader "${resolution.loaderId}" failed on ${relPath}:`, (err as Error).message);
    }
    return [];
  }
}

interface Contribution {
  parser: IaCParser;
  kind: string;
  resources: InfraResource[];
}

/**
 * Every parser that supports this document, in registration order.
 *
 * Order is presentation only: the set is what decides the outcome. A parser returning `null` said it
 * had nothing to add, which is not the same as saying no one else may look, so it drops out here
 * rather than ending the pass.
 */
function collectContributions(
  filePath: string,
  relPath: string,
  base: string,
  ext: string,
  doc: unknown,
): Contribution[] {
  const out: Contribution[] = [];
  for (const parser of getParsers()) {
    if (!parserMatchesFile(parser, base, ext)) continue;
    if (!parser.supports(filePath, doc)) continue;
    const delta = parser.parse(filePath, relPath, doc);
    if (!delta) continue;
    out.push({ parser, kind: delta.kind, resources: delta.resources });
  }
  return out;
}

/**
 * Contributions the build takes from one document, after the exclusive claims are honoured.
 *
 * An exclusive claim says the document has a single reading. A second contribution beside it is a
 * genuine disagreement about what the document is, and the two readings would both land in the
 * graph, so neither is taken and both parsers are named. Shared claims merge, which is how one file
 * can hold a chart and its values, or a manifest and an annotation another plugin understands.
 */
function settleClaims(
  relPath: string,
  contributions: Contribution[],
  documentKey: string,
  refusals: Refusal[],
): Contribution[] {
  if (contributions.length < 2) return contributions;
  const exclusive = contributions.filter(c => c.parser.claim === 'exclusive');
  if (exclusive.length === 0) return contributions;
  const kinds = [...new Set(contributions.map(c => c.kind))].sort(compareCodeUnits);
  refusals.push(refusal(
    'conflict',
    IAC_DOCUMENT_CLAIM_CONFLICT_REFUSAL,
    `Document ${documentKey} of ${relPath} was claimed exclusively by `
    + `${exclusive.map(c => c.kind).sort(compareCodeUnits).join(', ')} while `
    + `${kinds.join(', ')} all read it, so none of those readings was taken. `
    + 'Narrow one parser\'s supports() so a single reading claims the document.',
    { relativeFilePath: relPath, documentKey, kinds, exclusiveKinds: exclusive.map(c => c.kind).sort(compareCodeUnits) },
  ));
  return [];
}

/**
 * One resource per identity within a file, and a refusal when two disagree.
 *
 * Identity is `(namespace, localKey)` and the host mints one graph node per identity, so two
 * resources under one identity in the same file are two descriptions of one thing. Identical
 * descriptions are the same fact stated twice — a document read by two parsers, or repeated in a
 * multi-document file — and fold into one. Differing descriptions have no order-free winner, so
 * neither is kept and both readings are named.
 *
 * This is deliberately per file. The same resource declared in two files is how a monolith template
 * and a per-service template describe one deployment, and the graph already records both
 * declaration sites on the node it mints.
 */
function dedupeByIdentity(
  relPath: string,
  resources: readonly InfraResource[],
  refusals: Refusal[],
): InfraResource[] {
  const seen = new Map<string, { resource: InfraResource; payload: string }>();
  const conflicted = new Set<string>();
  for (const resource of resources) {
    const id = makeResourceId(resource.identity);
    const payload = canonicalJson(resource);
    const held = seen.get(id);
    if (!held) {
      seen.set(id, { resource, payload });
      continue;
    }
    if (held.payload === payload) continue;
    if (conflicted.has(id)) continue;
    conflicted.add(id);
    refusals.push(refusal(
      'conflict',
      RESOURCE_IDENTITY_CONFLICT_REFUSAL,
      `${relPath} describes ${id} twice with different content, so neither description was taken. `
      + 'Give the two resources distinct local keys, or emit one description of the resource.',
      { relativeFilePath: relPath, resourceId: id },
    ));
  }
  return [...seen.entries()]
    .filter(([id]) => !conflicted.has(id))
    .map(([, held]) => held.resource);
}

export function collectInfraModules(options: InfraScanOptions): InfraScanResult {
  const { repoRoot, scanPatterns } = options;
  const infraModules: InfraModuleInfo[] = [];
  const modulesById = new Map<string, InfraModuleInfo>();
  const refusals: Refusal[] = [];

  for (const conflict of getLoaderRegistrationConflicts()) {
    refusals.push(refusal(
      'conflict',
      IAC_LOADER_CLAIMED_TWICE_REFUSAL,
      `Plugin "${conflict.refused}" registered the document loader "${conflict.loaderId}", which `
      + `"${conflict.heldBy}" already provides, so the second registration was refused. `
      + 'Rename one loader: replacing a decoder would change how every plugin naming it reads files.',
      { loaderId: conflict.loaderId, heldBy: conflict.heldBy, refused: conflict.refused },
    ));
  }

  const candidates: { filePath: string; relPath: string }[] = [];
  discoverInfraFiles(repoRoot, repoRoot, candidates);
  if (candidates.length === 0) return { modules: infraModules, refusals };

  for (const { filePath, relPath } of candidates) {
    if (scanPatterns && !shouldScanInfraPath(relPath, scanPatterns)) continue;
    const bytes = readFileBytes(filePath, relPath);
    if (!bytes) continue;
    const documents = loadDocuments(filePath, relPath, bytes, refusals);
    if (documents.length === 0) continue;

    const base = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    // Module-level metadata is engine-owned: a single raw-file fingerprint shared by every
    // document the file produces. Computed once per file regardless of parser/doc count.
    const fileContentHash = infraFileContentHash(bytes);

    for (const document of documents) {
      const contributions = settleClaims(
        relPath,
        collectContributions(filePath, relPath, base, ext, document.value),
        document.documentKey,
        refusals,
      );
      for (const contribution of contributions) {
        // Stamp all mechanical/agnostic fields here; the parser supplied only infra semantics.
        mergeInfraModule(infraModules, modulesById, {
          id: infraNodeId(contribution.kind, relPath),
          kind: contribution.kind,
          filePath,
          relativeFilePath: relPath,
          contentHash: fileContentHash,
          resources: contribution.resources,
        });
      }
    }
  }

  for (const infraModule of infraModules) {
    infraModule.resources = dedupeByIdentity(infraModule.relativeFilePath, infraModule.resources, refusals);
  }

  return { modules: infraModules, refusals };
}
