import * as fs from 'node:fs';
import type { ModuleInfo, PackageInfo, PendingModule } from '../types.js';
import {
  HASH_WIDTH,
  sha256Hex,
  validatePublishedFact,
  type ReadonlyFactRecord,
  type HostPath,
  type SourceFileText,
  type SourcePlugin,
} from '@repovine/plugin-sdk';

/**
 * Engine-owned Stage-1 source extraction boundary.
 *
 * This is the single place that turns a producer's language semantics into materialized module
 * facts. The engine — not the plugin — owns everything language-agnostic: it reads each
 * shard file once, fingerprints it, and stamps `id` / `absPath` / `pkgRelPath` /
 * `packageName` / `contentHash` / `sourcePluginId` provenance onto the assembled `ModuleInfo`. The
 * plugin receives the raw text + hash via `sourceByModuleId` and returns only `SemanticModuleDelta`
 * (imports / exports / semanticHints), keyed back to the engine-minted `moduleId`.
 *
 * Both extraction paths (inline on the main thread and inside a worker thread) route through here,
 * so the boundary type crossing the worker bridge stays `ModuleInfo[]` and the assembly logic has
 * exactly one home.
 */

export interface RunSourceExtractionArgs {
  plugin: SourcePlugin;
  repoRoot: HostPath;
  packages: PackageInfo[];
  pendingModules: PendingModule[];
  prevByAbsPath: Map<HostPath, ModuleInfo>;
  absPathToId: Map<HostPath, string>;
  extractContext?: unknown;
  analysisVersion: number;
}

export interface RunSourceExtractionResult {
  modules: ModuleInfo[];
  reused: number;
  rescanned: number;
  /** Facts the producer published and this boundary took, in the order it emitted them. */
  facts: ReadonlyFactRecord[];
  /** One line per fact the boundary refused, naming the plugin and what was wrong with it. */
  factRefusals: string[];
}

export async function runSourceExtraction(args: RunSourceExtractionArgs): Promise<RunSourceExtractionResult> {
  const { plugin, pendingModules } = args;

  // Engine IO + content hashing: read each shard file exactly once and hand the producer
  // the raw text plus its fingerprint. A file that cannot be read is simply absent from the map —
  // the producer then has no source for it and emits no delta, so it drops out deterministically.
  const sourceByModuleId = new Map<string, SourceFileText>();
  for (const pending of pendingModules) {
    let content: string;
    try {
      content = fs.readFileSync(pending.absPath, 'utf-8');
    } catch {
      continue;
    }
    sourceByModuleId.set(pending.moduleId, { content, contentHash: sha256Hex(content, HASH_WIDTH.content) });
  }

  const result = await Promise.resolve(
    plugin.extract({
      repoRoot: args.repoRoot,
      packages: args.packages,
      pendingModules,
      prevByAbsPath: args.prevByAbsPath,
      absPathToId: args.absPathToId,
      sourceByModuleId,
      extractContext: args.extractContext,
      analysisVersion: args.analysisVersion,
    }),
  );

  // Assemble in pending order (engine-owned determinism), not in whatever order the plugin emitted.
  const deltaById = new Map(result.deltas.map(d => [d.moduleId, d] as const));
  const modules: ModuleInfo[] = [];
  for (const pending of pendingModules) {
    const delta = deltaById.get(pending.moduleId);
    if (!delta) continue;
    const src = sourceByModuleId.get(pending.moduleId);
    modules.push({
      id: pending.moduleId,
      packageName: pending.pkg.name,
      absPath: pending.absPath,
      pkgRelPath: pending.pkgRelPath,
      // A transient extraction (e.g. a subprocess that died mid-shard) must not be cached under the
      // real hash, or a later incremental run would reuse the poisoned empty module forever. The
      // empty sentinel never matches a real file hash, forcing a re-parse next run.
      contentHash: delta.transient ? '' : (src?.contentHash ?? ''),
      imports: delta.imports,
      exports: delta.exports,
      ...(delta.reExports?.length ? { reExports: delta.reExports } : {}),
      ...(delta.calls?.length ? { calls: delta.calls } : {}),
      ...(delta.callsTotal ? { callsTotal: delta.callsTotal } : {}),
      ...(delta.semanticHints ? { semanticHints: delta.semanticHints } : {}),
      sourcePluginId: pending.sourcePluginId ?? pending.pkg.sourcePluginId,
    });
  }

  const { facts, factRefusals } = takePublishedFacts(plugin.id, result.facts);
  return { modules, reused: result.reused, rescanned: result.rescanned, facts, factRefusals };
}

/**
 * Take the facts a producer published, and name the ones this boundary will not take.
 *
 * Published facts are untrusted input like every other plugin output: shape and budget are checked
 * here, and the schema owner must be the publishing plugin, so a producer cannot publish under
 * another ecosystem's name. A refused fact is absent from the view and named in the build's
 * refusals; it never degrades into a silently missing fact a reader would read as "no such thing".
 */
function takePublishedFacts(
  pluginId: string,
  published: readonly unknown[] | undefined,
): { facts: ReadonlyFactRecord[]; factRefusals: string[] } {
  const facts: ReadonlyFactRecord[] = [];
  const factRefusals: string[] = [];
  for (const candidate of published ?? []) {
    const validated = validatePublishedFact(candidate, { pluginId });
    if (validated.ok) facts.push(validated.fact);
    else factRefusals.push(`plugin "${pluginId}" published an invalid fact: ${validated.error}`);
  }
  return { facts, factRefusals };
}
