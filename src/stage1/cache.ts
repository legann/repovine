import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { RepositoryFactsSnapshot } from '../types.js';
import { MemoryProfiler } from '../perf/memory-profiler.js';
import { writeFileAtomicSync, writeJsonObjectStreamed } from '../fs/atomic.js';
import { repoRelativePosix } from '../platform/paths.js';

export interface SnapshotCache {
  load(): RepositoryFactsSnapshot | null;
  loadAsync(): Promise<RepositoryFactsSnapshot | null>;
  save(snapshot: RepositoryFactsSnapshot): void;
  saveAsync(snapshot: RepositoryFactsSnapshot): Promise<void>;
  /** Whether the cache file is present on disk (for the dirty-skip guard). */
  exists(): boolean;
}

/**
 * Content fingerprint of a snapshot, for the P2 dirty-skip guard. Covers each member's id +
 * `contentHash` (modules, templates, infra), member counts, `analysisVersion`, `engineBuildId`, and
 * the extraction-config fingerprint
 * (so a dev rebuild that changes only the engine still restamps the on-disk id). It excludes
 * absolute paths (member ids are repo-root-relative) and the timestamp, so a rebuild with identical
 * content produces the same fingerprint even under a different repo root. A match means the on-disk
 * snapshot is already current and the write can be skipped.
 */
// Streamed rather than routed through `sha256Hex`: the input is O(repository) — id plus content
// hash of every module, template and infra file — and materializing it as one string would allocate
// megabytes on each `refresh_context`. The framing (`|label:n|`, `\0`) is part of the fact, not
// formatting: it is what keeps a member count distinguishable from a member.
export function snapshotContentFingerprint(snapshot: RepositoryFactsSnapshot): string {
  const h = crypto.createHash('sha256');
  h.update(`av:${snapshot.analysisVersion ?? 0}`);
  h.update(`|eng:${snapshot.engineBuildId ?? ''}`);
  h.update(`|cfg:${snapshot.extractionConfigFingerprint ?? ''}`);
  const addMembers = (label: string, members?: ReadonlyArray<{ id: string; contentHash: string }>) => {
    h.update(`|${label}:${members?.length ?? 0}|`);
    if (members) {
      for (const m of members) {
        h.update(m.id);
        h.update('\0');
        h.update(m.contentHash);
        h.update('\0');
      }
    }
  };
  addMembers('mod', snapshot.modules);
  addMembers('tpl', snapshot.templates);
  addMembers('infra', snapshot.infraModules);
  return h.digest('hex');
}

type ModuleMember = RepositoryFactsSnapshot['modules'][number];
type TemplateMember = NonNullable<RepositoryFactsSnapshot['templates']>[number];
type InfraMember = NonNullable<RepositoryFactsSnapshot['infraModules']>[number];

/** Keys dropped from the extract-output fact digest: they carry source *position*, not semantics, so
 * a line move would otherwise perturb the fingerprint. `lineRange` appears nested inside
 * `semanticHints` signals and per-export members. */
const EXCLUDED_FACT_KEYS = new Set(['lineRange']);

/**
 * Canonical, position-free serialization of extracted facts. Object keys are emitted in sorted order,
 * arrays are sorted by their canonical element form (so extraction order is irrelevant), `undefined`
 * folds to `null`, and position keys (`lineRange`) are dropped. Two values serialize identically iff
 * they carry the same extracted semantics, independent of key order, array order, and line numbers.
 */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).sort().join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter(k => !EXCLUDED_FACT_KEYS.has(k))
      .sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

const sortedStrings = (xs?: ReadonlyArray<string>): string[] => (xs ? [...xs].sort() : []);

/** Extracted semantics of one module, excluding mechanical fields (`id`/`filePath`/`contentHash`,
 * folded separately) and position. Every list is normalized so extraction order does not move the
 * digest. */
function moduleFacts(m: ModuleMember): unknown {
  return {
    imports: (m.imports ?? []).map(i => ({
      moduleSpecifier: i.moduleSpecifier,
      resolvedModuleId: i.resolvedModuleId ?? null,
      importedNames: sortedStrings(i.importedNames),
      isTypeOnly: i.isTypeOnly,
      isExternal: i.isExternal,
    })),
    reExports: (m.reExports ?? []).map(r => ({
      moduleSpecifier: r.moduleSpecifier,
      resolvedModuleId: r.resolvedModuleId ?? null,
      names: sortedStrings(r.names),
      isStar: r.isStar,
      isExternal: r.isExternal,
    })),
    calls: sortedStrings(m.calls),
    exports: (m.exports ?? []).map(e => ({
      name: e.name,
      kind: e.kind,
      isDefault: e.isDefault,
      signature: e.signature ?? null,
      returnType: e.returnType ?? null,
      typeValue: e.typeValue ?? null,
      calls: sortedStrings(e.calls),
      implementsInterfaces: sortedStrings(e.implementsInterfaces),
      params: (e.params ?? []).map(p => ({ name: p.name, type: p.type })),
      fields: (e.fields ?? []).map(f => ({ name: f.name, type: f.type, optional: f.optional })),
      privateMembers: (e.privateMembers ?? []).map(pm => ({ name: pm.name, kind: pm.kind })),
      internals: (e.internals ?? []).map(iv => ({ name: iv.name, kind: iv.kind })),
    })),
    semanticHints: m.semanticHints ?? null,
    sourcePluginId: m.sourcePluginId ?? null,
  };
}

/** Extracted semantics of one template artifact (engine + declared structure); path excluded. */
function templateFacts(t: TemplateMember): unknown {
  return {
    engine: t.engine ?? null,
    extendsTemplate: t.extendsTemplate ?? null,
    includesTemplate: sortedStrings(t.includesTemplate),
    blocks: sortedStrings(t.blocks),
  };
}

/** Extracted semantics of one infra document (kind + parsed resources, each with its own
 * per-resource fingerprint and triggers/envRefs). */
function infraFacts(m: InfraMember): unknown {
  return { kind: m.kind, resources: m.resources ?? [] };
}

/**
 * Content fingerprint of a snapshot's extracted facts, independent of `analysisVersion`,
 * `engineBuildId`, and member order (members are sorted by id before hashing). Per member it folds
 * `id` + `contentHash` PLUS a canonical digest of the extracted facts themselves (imports, exports,
 * calls, reExports, semanticHints, infra resources, template structure). Because `contentHash`
 * fingerprints *source* but not *extract output*, folding the facts is what makes an extract-logic
 * change (new call edges, semantic hints, effect flags, IaC parsing) move the fingerprint even when
 * source is byte-identical. The CI golden guard hashes a fixed fixture corpus with this and catches
 * an extract change shipped without a STAGE1_ANALYSIS_VERSION bump. Position (`lineRange`) and
 * absolute paths are excluded, so formatting/line moves do not perturb it.
 */
// Streamed for the same reason as `snapshotContentFingerprint`, and deliberately NOT the same
// fact: members are sorted by id here, so reordering the snapshot does not move this fingerprint
// and does move that one.
export function extractOutputFingerprint(snapshot: RepositoryFactsSnapshot): string {
  const h = crypto.createHash('sha256');
  const addMembers = <T extends { id: string; contentHash: string }>(
    label: string,
    members: ReadonlyArray<T> | undefined,
    facts: (m: T) => unknown,
  ) => {
    const sorted = members ? [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : [];
    h.update(`|${label}:${sorted.length}|`);
    for (const m of sorted) {
      h.update(m.id);
      h.update('\0');
      h.update(m.contentHash);
      h.update('\0');
      h.update(canonicalize(facts(m)));
      h.update('\0');
    }
  };
  addMembers('mod', snapshot.modules, moduleFacts);
  addMembers('tpl', snapshot.templates, templateFacts);
  addMembers('infra', snapshot.infraModules, infraFacts);
  return h.digest('hex');
}

const SNAPSHOT_FILENAME = 'repository-facts-snapshot.json';

/** Module `filePath` is the only absolute field. Store it repo-root-relative (posix) so the
 * on-disk cache transfers between worktrees, CI checkouts, and container mounts at the same
 * content. The absolute path is reconstructed against the current runtime root on load. */
const toPortable = (root: string, abs: string): string => repoRelativePosix(root, abs);
const toAbsolute = (root: string, stored: string): string =>
  path.isAbsolute(stored) ? stored : path.resolve(root, stored);

/** Serialize each module with its absolute `filePath` rewritten repo-root-relative, one element at a
 * time. A single transient clone is alive per yield, so the largest array is never doubled in memory,
 * and the streamed writer yields the event loop between batches. */
function* portableModuleMembers(snapshot: RepositoryFactsSnapshot): Generator<string> {
  const root = snapshot.repoRoot;
  for (const m of snapshot.modules) {
    yield JSON.stringify({ ...m, filePath: toPortable(root, m.filePath) });
  }
}

export function createFileCache(cacheDir: string, repoRoot: string): SnapshotCache {
  const filePath = path.join(cacheDir, SNAPSHOT_FILENAME);

  const reconstruct = (raw: { modules: RepositoryFactsSnapshot['modules'] }): RepositoryFactsSnapshot => {
    for (const m of raw.modules) m.filePath = toAbsolute(repoRoot, m.filePath);
    return raw as RepositoryFactsSnapshot;
  };

  // Serialize with each module's absolute `filePath` rewritten repo-root-relative in place, then
  // reverted in a finally. No clone of the (largest) modules array is allocated. The relative-path
  // window is synchronous — there is no await between rewrite and revert — so nothing else on the
  // event loop observes the snapshot mid-rewrite, even when called from `saveAsync`. The finally
  // restores absolute paths even if `JSON.stringify` throws (the >512 MB string cliff).
  const writeSnapshot = (snapshot: RepositoryFactsSnapshot): string => {
    const profiler = MemoryProfiler.ensure();
    const root = snapshot.repoRoot;
    for (const m of snapshot.modules) m.filePath = toPortable(root, m.filePath);
    try {
      profiler.phase('cache:before-stringify');
      const json = JSON.stringify(snapshot);
      profiler.setCounter('snapshotCacheJsonBytes', Buffer.byteLength(json, 'utf8'));
      profiler.phase('cache:after-stringify');
      return json;
    } finally {
      for (const m of snapshot.modules) m.filePath = toAbsolute(root, m.filePath);
    }
  };

  return {
    load(): RepositoryFactsSnapshot | null {
      try {
        if (!fs.existsSync(filePath)) return null;
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!raw || !Array.isArray(raw.modules)) return null;
        return reconstruct(raw);
      } catch {
        return null;
      }
    },

    async loadAsync(): Promise<RepositoryFactsSnapshot | null> {
      try {
        const content = await fsPromises.readFile(filePath, 'utf-8');
        const raw = JSON.parse(content);
        if (!raw || !Array.isArray(raw.modules)) return null;
        return reconstruct(raw);
      } catch {
        return null;
      }
    },

    save(snapshot: RepositoryFactsSnapshot): void {
      const json = writeSnapshot(snapshot);
      writeFileAtomicSync(filePath, json);
      MemoryProfiler.ensure().phase('cache:after-write');
    },

    async saveAsync(snapshot: RepositoryFactsSnapshot): Promise<void> {
      // Stream modules off the main loop: no whole-snapshot string, no >512 MB cliff. Output is
      // byte-for-byte identical to the synchronous `save()` above (same portable on-disk format).
      const bytes = await writeJsonObjectStreamed(filePath, snapshot, {
        key: 'modules',
        kind: 'array',
        members: portableModuleMembers(snapshot),
      });
      const profiler = MemoryProfiler.ensure();
      profiler.setCounter('snapshotCacheJsonBytes', bytes);
      profiler.phase('cache:after-write');
    },

    exists(): boolean {
      return fs.existsSync(filePath);
    },
  };
}
