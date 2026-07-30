import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { StoredAnnotation, RepositoryGraph, RepositoryFactsSnapshot } from '../types.js';
import { writeFileAtomicSync } from '../fs/atomic.js';
import { annotationFreshness, type FreshnessVerdict } from './freshness.js';
import {
  buildAnnotationBacklog,
  countBacklogPhases,
  countBacklogRows,
  filterRowsByStaleKind,
  sortBacklogRows,
  type AnnotationBacklog,
  type AnnotationQueuePage,
  type BacklogCounts,
  type BacklogCoverage,
  type QueueItem,
  type QueuePhase,
  type QueueStatus,
  type StaleKind,
} from './backlog.js';
import { ANNOTATIONS_FILENAME, resolveAnnotationsFilePath } from '../paths.js';
import { ensureEmptyAnnotationsFileAtPath, EMPTY_ANNOTATION_FILE_TEXT } from './maintenance.js';
import { writeAnnotationBackup } from './backup.js';
import {
  withAnnotationFileLockAsync,
  withAnnotationFileLockSync,
} from './file-lock.js';
import { type ModuleKind } from './module-kind.js';
import { formatPipelineDetail, formatPipelineStatus, logPipeline, logPipelineWarn } from '../cli/ui.js';
import {
  AnnotationContentSchema,
  hydrateAnnotationMap,
  parseAnnotationFile,
  parseAnnotationsRawShape,
  serializeAnnotationFileFromRaw,
} from './format.js';
import type { PropagationConfig } from '../config.js';
import type { EntrypointFragment } from '../interpreter/types.js';
import { omittedNote, shortenList, shortenText } from '../platform/text.js';

export { AnnotationContentSchema };

export interface AnnotationHealthScanRow {
  nodeId: string;
  status: QueueStatus;
  staleKind?: StaleKind;
  /** Queue phase. domain/runtime-resource/infra are auto-derived aggregates. */
  phase: QueuePhase;
}

export interface AnnotationHealthSampleItem {
  nodeId: string;
  status: QueueStatus;
  staleKind?: StaleKind;
  moduleKind?: ModuleKind;
  reason: string;
}

/**
 * The needs-work half of {@link buildAnnotationBacklog}, projected for validate/compliance/status.
 * Those paths need classification and order, never item prose, so nothing here is hydrated.
 */
export interface AnnotationHealthScan {
  counts: BacklogCounts;
  /** Needs-work rows sorted in the same priority order as getQueue. */
  rows: AnnotationHealthScanRow[];
  /**
   * Hydrate the top `limit` needs-work items (optionally restricted by
   * predicate), preserving getQueue ordering and the queueSample shape.
   */
  sample: (limit: number, predicate?: (row: AnnotationHealthScanRow) => boolean) => AnnotationHealthSampleItem[];
}

export interface AnnotationFileStatusSnapshot {
  exists: boolean;
  parseOk: boolean;
  hasConflictMarkers: boolean;
  annotationCount?: number;
  error?: string;
}

/**
 * What the last merge kept over the file, per branch of the never-lose net: `readded` for records the
 * file no longer had, `reverted` for records it had in a superseded version. Runtime state of one store
 * instance, so only an in-process reader sees it.
 */
export interface AnnotationMergeKeeps {
  readded: number;
  reverted: number;
  /** Bounded, so one large revert cannot flood a response. */
  sample: string[];
}

/** How many node ids a merge-keep report names before it falls back to the counts. */
const MERGE_KEEP_SAMPLE = 5;

/**
 * One sentence for a merge that kept records the file disagreed with, or undefined when it kept none.
 * The net exists so an interrupted save cannot lose a note, but it also silently outlives a deliberate
 * revert, so the message names that cause and how to make a revert stick.
 */
export function describeMergeKeeps(keeps: AnnotationMergeKeeps): string | undefined {
  const total = keeps.readded + keeps.reverted;
  if (total === 0) return undefined;
  const parts: string[] = [];
  if (keeps.readded > 0) parts.push(`${keeps.readded} the file no longer held`);
  if (keeps.reverted > 0) parts.push(`${keeps.reverted} the file held in an older version`);
  const more = omittedNote(total - keeps.sample.length);
  return `Kept ${total} in-memory annotation(s) the file disagreed with — ${parts.join(', ')}: `
    + `${keeps.sample.join(', ')}${more}. A revert of the annotations file does not stick while this process `
    + 'holds the newer records; re-apply it after the process exits, or write the intended state through '
    + 'write_annotation / merge_annotations.';
}

const SAVE_DEBOUNCE_MS = 800;
const MAX_SAVE_RETRIES = 3;

function isAnnotationRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A `pass` read off a RAW disk record. The serializer elides the key when the value is 1, and the
 * loader hydrates that absence back to 1, so a raw record without the key is pass 1 — reading it as 0
 * would rank every first-pass record on disk as superseded.
 */
function rawDiskPass(diskRec: Record<string, unknown>): number {
  return typeof diskRec.pass === 'number' ? diskRec.pass : 1;
}

/**
 * Whether a disk record is a superseded version of the one we hold: a lower `pass`, or the same `pass`
 * with an older `updatedAt`. Drives the never-regress net in {@link AnnotationStore.mergeWithDisk}.
 * Unparseable or equal metadata reads as "not older", so disk keeps the merge base by default and only a
 * demonstrable regression is overridden.
 */
function diskRecordIsOlder(diskRec: unknown, ours: StoredAnnotation): boolean {
  if (!isAnnotationRecord(diskRec)) return false;
  const diskPass = rawDiskPass(diskRec);
  const ourPass = typeof ours.pass === 'number' ? ours.pass : 1;
  if (diskPass !== ourPass) return diskPass < ourPass;
  const diskAt = typeof diskRec.updatedAt === 'string' ? Date.parse(diskRec.updatedAt) : NaN;
  const ourAt = typeof ours.updatedAt === 'string' ? Date.parse(ours.updatedAt) : NaN;
  if (Number.isNaN(diskAt) || Number.isNaN(ourAt)) return false;
  return diskAt < ourAt;
}

/**
 * Merge for a write that changed no annotation content (a re-submitted identical write, a bare
 * importBaseline refresh). The disk record stays the base so its content keeps the `contentHash` and
 * `updatedAt` that describe it; only what this write can carry independently of content is overlaid.
 * Stamping our metadata over disk content instead would report a record as fresh while it holds the
 * older text.
 */
function mergeRecordLevelOnly(disk: Record<string, unknown>, ours: StoredAnnotation): Record<string, unknown> {
  const ourPass = typeof ours.pass === 'number' ? ours.pass : 1;
  return {
    ...disk,
    pass: Math.max(rawDiskPass(disk), ourPass),
    ...(ours.importBaseline ? { importBaseline: ours.importBaseline } : {}),
  };
}

/**
 * Thrown when a save finds the file changed externally to something unreadable (git conflict markers,
 * partial write, corruption). The save refuses rather than overwrite the external bytes with in-memory
 * state; the deltas stay pending and are surfaced via `lastSaveError`.
 */
export class AnnotationExternalCorruptionError extends Error {
  readonly code = 'ANNOTATION_EXTERNAL_CORRUPTION';

  constructor(readonly filePath: string, readonly reason: string) {
    super(
      `Refusing to overwrite ${filePath}: it changed externally and is now unreadable (${reason}). `
      + 'Resolve the conflict (merge_annotations) or restore the file, then reload repovine.',
    );
    this.name = 'AnnotationExternalCorruptionError';
  }
}

export class AnnotationStore {
  private filePath: string;
  private data: Record<string, StoredAnnotation> = {};
  /**
   * Raw entries that failed schema validation at load time. They are NEVER dropped — they are
   * parked here and carried through on every write, so a schema mismatch (e.g. a tightened
   * `sideEffects` rule during a migration window) can never silently delete annotations off disk.
   * Hidden from graph/queries; not counted as queryable annotations.
   */
  private quarantine: Record<string, unknown> = {};
  /** nodeIds this process has explicitly written since the last successful persist. */
  private touched = new Set<string>();
  /**
   * Per-touched-node record of which annotation fields changed this cycle, for field-level merge against
   * a concurrent external writer. A Set names the changed fields; `null` means whole-record (legacy set,
   * migrations). Absence (a `touched` key with no entry) is also treated as whole-record.
   */
  private touchedFields = new Map<string, Set<string> | null>();
  /** nodeIds this process has explicitly deleted since the last successful persist. */
  private deleted = new Set<string>();
  /** Monotonic mutation counter; every set()/delete() bumps it. */
  private mutationSeq = 0;
  /**
   * Per-key mutation generation at its last set()/delete(). A save clears a key only if its generation is
   * unchanged since the save was composed — so a re-write of the SAME node during an in-flight save is
   * kept pending instead of being reverted to the composed version (a `Set<nodeId>` cannot tell a
   * re-write from the original write).
   */
  private opGen = new Map<string, number>();
  /** Stat of the file as of our last read/write — used to detect external writers cheaply. */
  private lastWriteStat: { mtimeMs: number; size: number } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes async saves so two debounced/flush cycles never overlap in-process. Never rejects. */
  private saveChain: Promise<unknown> = Promise.resolve();
  /** True while an async save holds (or is acquiring) the file lock — lets sync flush() fail fast. */
  private asyncSaveInFlight = false;
  private _lastSaveError: string | null = null;
  private mergeKeeps: AnnotationMergeKeeps = { readded: 0, reverted: 0, sample: [] };
  private lastFlushedCount: number | null = null;
  private mergeStatusSnapshot: AnnotationFileStatusSnapshot = {
    exists: false,
    parseOk: false,
    hasConflictMarkers: false,
  };
  private writeBlockedAfterFailedLoad = false;
  private failedLoadBackupPending = false;
  private failedLoadOriginalContent: string | undefined;

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Factory: create and load store asynchronously. */
  static async create(repoRoot: string, annotationsFile = ANNOTATIONS_FILENAME): Promise<AnnotationStore> {
    const store = new AnnotationStore(resolveAnnotationsFilePath(repoRoot, annotationsFile));
    await store.loadAsync();
    return store;
  }

  /** Synchronous factory for backward compatibility (tests, CLI). */
  static createSync(repoRoot: string, annotationsFile = ANNOTATIONS_FILENAME): AnnotationStore {
    const store = new AnnotationStore(resolveAnnotationsFilePath(repoRoot, annotationsFile));
    store.loadSync();
    return store;
  }

  private parseAndValidate(rawJson: string): void {
    const raw = JSON.parse(rawJson);
    this.data = {};
    this.quarantine = {};
    const anns = raw?.annotations;
    if (anns && typeof anns === 'object') {
      // Validate per-entry, hydrating compact disk records into the full runtime shape.
      // Invalid entries are quarantined, NOT discarded — they are written back on every
      // save so disk never loses data we simply could not parse.
      const hydrated = hydrateAnnotationMap(anns as Record<string, unknown>);
      this.data = hydrated.data;
      this.quarantine = hydrated.quarantine;
      const loaded = Object.keys(this.data).length;
      const quarantinedIds = hydrated.errors.map(error => error.nodeId);
      const firstError = hydrated.errors[0];
      if (quarantinedIds.length > 0) {
        const quarantinedShown = shortenList(quarantinedIds, 10);
        const shown = quarantinedShown.shown.join(', ');
        logPipelineWarn(`  Annotations: ${quarantinedIds.length} entry(ies) failed validation, quarantined (preserved on disk, hidden from queries): ${shown}${omittedNote(quarantinedShown.omitted)}`);
        if (firstError) logPipelineWarn(`    Example error (${firstError.nodeId}): ${firstError.message}`);
      }
      logPipeline(formatPipelineStatus(`  Annotations loaded: ${loaded} nodes${quarantinedIds.length ? ` (+${quarantinedIds.length} quarantined)` : ''}`));
    }
    this.lastFlushedCount = Object.keys(this.data).length + Object.keys(this.quarantine).length;
  }

  private mergeStatusSnapshotFromContent(content: string, exists = true): AnnotationFileStatusSnapshot {
    const hasConflictMarkers = /^(<<<<<<<|=======|>>>>>>>) ?/m.test(content);
    if (hasConflictMarkers) {
      return {
        exists,
        parseOk: false,
        hasConflictMarkers: true,
        error: 'contains conflict markers',
      };
    }
    try {
      const parsed = parseAnnotationFile(content, this.filePath);
      return {
        exists,
        parseOk: true,
        hasConflictMarkers: false,
        annotationCount: Object.keys(parsed.annotations).length,
      };
    } catch (e) {
      return {
        exists,
        parseOk: false,
        hasConflictMarkers: false,
        error: (e as Error).message,
      };
    }
  }

  private setMergeStatusSnapshot(snapshot: AnnotationFileStatusSnapshot): void {
    this.mergeStatusSnapshot = snapshot;
    if (snapshot.parseOk) {
      this.writeBlockedAfterFailedLoad = false;
      this.failedLoadBackupPending = false;
      this.failedLoadOriginalContent = undefined;
    }
  }

  private rememberFailedLoad(content?: string): void {
    if (!this.mergeStatusSnapshot.exists) return;
    this.writeBlockedAfterFailedLoad = true;
    this.failedLoadBackupPending = true;
    if (content !== undefined) {
      this.failedLoadOriginalContent = content;
      return;
    }
    if (this.failedLoadOriginalContent !== undefined) return;
    try {
      this.failedLoadOriginalContent = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      // A read failure still makes the store non-writable; a later backup attempt may succeed.
    }
  }

  private mergeStatusSnapshotAfterLoadFailure(error: unknown): AnnotationFileStatusSnapshot {
    const exists = fs.existsSync(this.filePath);
    if (exists) {
      try {
        return this.mergeStatusSnapshotFromContent(fs.readFileSync(this.filePath, 'utf-8'), true);
      } catch (readError) {
        return {
          exists: true,
          parseOk: false,
          hasConflictMarkers: false,
          error: (readError as Error).message,
        };
      }
    }
    return {
      exists: false,
      parseOk: false,
      hasConflictMarkers: false,
      ...((error as Error).message ? { error: (error as Error).message } : {}),
    };
  }

  private loadSync(): void {
    let loadedContent: string | undefined;
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        loadedContent = content;
        const snapshot = this.mergeStatusSnapshotFromContent(content, true);
        this.setMergeStatusSnapshot(snapshot);
        this.parseAndValidate(content);
        this.captureStatSync();
      } else if (ensureEmptyAnnotationsFileAtPath(this.filePath)) {
        this.setMergeStatusSnapshot(this.mergeStatusSnapshotFromContent(EMPTY_ANNOTATION_FILE_TEXT, true));
        this.parseAndValidate(EMPTY_ANNOTATION_FILE_TEXT);
        this.captureStatSync();
      }
    } catch (e) {
      this.data = {};
      this.quarantine = {};
      this.setMergeStatusSnapshot(this.mergeStatusSnapshotAfterLoadFailure(e));
      this.rememberFailedLoad(loadedContent);
      logPipeline(formatPipelineDetail(`  Annotations: failed to load (${(e as Error).message}), starting with none`));
    }
  }

  private async loadAsync(): Promise<void> {
    let loadedContent: string | undefined;
    try {
      const content = await fsPromises.readFile(this.filePath, 'utf-8');
      loadedContent = content;
      const snapshot = this.mergeStatusSnapshotFromContent(content, true);
      this.setMergeStatusSnapshot(snapshot);
      this.parseAndValidate(content);
      this.captureStatSync();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && ensureEmptyAnnotationsFileAtPath(this.filePath)) {
        this.setMergeStatusSnapshot(this.mergeStatusSnapshotFromContent(EMPTY_ANNOTATION_FILE_TEXT, true));
        this.parseAndValidate(EMPTY_ANNOTATION_FILE_TEXT);
        this.captureStatSync();
        return;
      }
      if (code !== 'ENOENT') {
        logPipeline(formatPipelineDetail(`  Annotations: failed to load (${(e as Error).message}), starting with none`));
      }
      this.data = {};
      this.quarantine = {};
      this.setMergeStatusSnapshot(this.mergeStatusSnapshotAfterLoadFailure(e));
      this.rememberFailedLoad(loadedContent);
    }
  }

  // ── Persistence ──
  //
  // A write never derives the file purely from in-memory `this.data`. The on-disk file is the
  // durable accumulator; a write applies only this process's explicit deltas (writes + deletes)
  // on top of it. Two guards keep this cheap on large (30–40k line) files:
  //   1. The in-memory map is a true superset of disk (invalid entries are quarantined, not
  //      dropped), so the common single-writer path writes straight from memory — no re-read.
  //   2. A stat check detects external writers; only then do we re-read and merge, so the hot
  //      path pays a single fs.stat. Writes are atomic (temp + rename) — a crash cannot truncate.

  /** Fast path: our in-memory map is authoritative (== disk + our deltas). */
  private composeOwn(): Record<string, unknown> {
    return { ...this.data, ...this.quarantine };
  }

  /** Merge path: disk is the base; overlay the entries this process holds, then apply our deletes. */
  private mergeWithDisk(diskAnns: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...diskAnns };
    // Reset here rather than in a caller: a save on an unchanged file returns before merging, and a
    // caller-side reset would erase a count the preceding refresh legitimately produced.
    this.mergeKeeps = { readded: 0, reverted: 0, sample: [] };
    // Carry our quarantined entries the external writer does not have.
    for (const [k, v] of Object.entries(this.quarantine)) {
      if (!(k in out)) out[k] = v;
    }
    // Apply our pending writes. For a key an external writer also holds, merge only the fields we changed
    // so their concurrent field additions survive; otherwise overlay the whole record. The regress net
    // below deliberately does NOT apply here: `pass` is derived from our own possibly-stale copy
    // (`existing.pass + 1`) and `updatedAt` from our wall clock, so a single concurrent write ties on
    // `pass` and loses the timestamp comparison — treating that as a regression would discard exactly the
    // field additions this branch exists to keep.
    for (const k of this.touched) {
      const ours = this.data[k];
      if (ours === undefined) continue;
      const fields = this.touchedFields.get(k);
      const diskRec = out[k];
      if (!isAnnotationRecord(diskRec) || !(fields instanceof Set)) {
        out[k] = ours;
      } else if (fields.size === 0) {
        out[k] = mergeRecordLevelOnly(diskRec, ours);
      } else {
        out[k] = this.mergeAnnotationFields(diskRec, ours, fields);
      }
    }
    // Safety net against concurrent-writer / interrupted-save / git-checkout data loss: a merge must
    // never DROP an annotation this process still holds in memory unless it was explicitly deleted, and
    // never REVERT one to an older disk copy. `touched` only covers writes since the last persist, so an
    // annotation we persisted in an earlier cycle is otherwise protected solely by the disk snapshot — and
    // a concurrent writer, a half-flushed debounced save, or an out-of-band file reset can leave the disk
    // transiently missing it or holding a superseded version. Treat both as external gaps, not as intent:
    // resurfacing a stale note is recoverable (freshness/orphan checks flag it); silently losing an update
    // is not. A genuine external update carries a higher `pass`, so it still wins.
    for (const k of Object.keys(this.data)) {
      if (this.deleted.has(k)) continue;
      const ours = this.data[k];
      if (!(k in out)) {
        out[k] = ours;
        this.recordMergeKeep('readded', k);
      } else if (!this.touched.has(k) && diskRecordIsOlder(out[k], ours)) {
        out[k] = ours;
        this.recordMergeKeep('reverted', k);
      }
    }
    // Apply our pending deletes. Absence from memory for any OTHER reason never deletes.
    for (const k of this.deleted) delete out[k];
    return out;
  }

  /**
   * Overlay only `fields` from our annotation onto the disk record, keeping the disk record's other
   * fields (a concurrent external writer's additions). Record metadata comes from our write; `pass` takes
   * the max so neither side's increment is lost. Callers pass a non-empty `fields`; an empty set means the
   * write changed no content and routes to {@link mergeRecordLevelOnly} instead.
   */
  private mergeAnnotationFields(
    disk: Record<string, unknown>,
    ours: StoredAnnotation,
    fields: Set<string>,
  ): StoredAnnotation {
    const diskAnnotation = (disk.annotation && typeof disk.annotation === 'object' ? disk.annotation : {}) as Record<string, unknown>;
    const ourAnnotation = ours.annotation as unknown as Record<string, unknown>;
    const mergedAnnotation: Record<string, unknown> = { ...diskAnnotation };
    for (const f of fields) {
      if (ourAnnotation[f] === undefined) delete mergedAnnotation[f];
      else mergedAnnotation[f] = ourAnnotation[f];
    }
    const diskPass = typeof disk.pass === 'number' ? disk.pass : 0;
    return {
      ...ours,
      pass: Math.max(diskPass, ours.pass),
      annotation: mergedAnnotation as unknown as StoredAnnotation['annotation'],
    };
  }

  /** Re-derive in-memory maps from a merged raw map so memory re-converges with disk. */
  private ingestRaw(annotations: Record<string, unknown>): void {
    const hydrated = hydrateAnnotationMap(annotations);
    this.data = hydrated.data;
    this.quarantine = hydrated.quarantine;
  }

  private fileChangedExternally(): boolean {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.filePath);
    } catch {
      return false; // absent → we are creating it, nothing external to merge
    }
    if (!this.lastWriteStat) return true; // file exists but we have no baseline → merge to be safe
    return st.mtimeMs !== this.lastWriteStat.mtimeMs || st.size !== this.lastWriteStat.size;
  }

  private captureStatSync(): void {
    try {
      const st = fs.statSync(this.filePath);
      this.lastWriteStat = { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      this.lastWriteStat = null;
    }
  }

  private readDiskAnnotationsSync(): { ok: true; anns: Record<string, unknown> } | { ok: false; reason: string } {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      // Validate the OUTER shape via the canonical schema — `{"annotations":"THEIRS"}` is a well-formed
      // JSON string but an INVALID annotations file. Accepting it as an empty set would let the next save
      // overwrite the external bytes. Per-entry validity is deferred (quarantined by ingestRaw), not
      // grounds to reject the whole file.
      const anns = parseAnnotationsRawShape(content);
      if (anns === null) return { ok: false, reason: 'invalid annotations file shape' };
      return { ok: true, anns };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  /** Decide final content: disk-merge when an external writer touched the file, else our superset. */
  private composeFinalRaw(): { finalRaw: Record<string, unknown>; merged: boolean } {
    if (!this.fileChangedExternally()) return { finalRaw: this.composeOwn(), merged: false };
    // The file changed under us. Read it; a parse/conflict failure means an external writer (git merge,
    // partial write) left it unreadable. Fail closed rather than overwrite THEIR bytes with our memory —
    // the corrupt file stays intact on disk for merge_annotations / manual repair. Symmetric with the
    // load-time refusal (a corrupt file blocks writes until reload).
    const disk = this.readDiskAnnotationsSync();
    if (!disk.ok) {
      throw new AnnotationExternalCorruptionError(this.filePath, disk.reason);
    }
    return { finalRaw: this.mergeWithDisk(disk.anns), merged: true };
  }

  private finalizeWrite(
    finalRaw: Record<string, unknown>,
    merged: boolean,
    capturedGen: ReadonlyMap<string, number>,
  ): void {
    // A touched/deleted key is fully persisted by this save only if its mutation generation is unchanged
    // since the save was composed. A key set/deleted AGAIN during the write (same or new nodeId) has a
    // newer generation and stays pending — its in-memory value must not be reverted to `finalRaw`.
    const persisted = (k: string): boolean => {
      const g = capturedGen.get(k);
      return g !== undefined && this.opGen.get(k) === g;
    };
    if (merged) {
      // ingestRaw re-derives this.data from the merged base composed BEFORE the await. Preserve the
      // in-memory value of any key that changed during the write so ingestRaw cannot wipe/revert it.
      const stillPending = [...this.touched].filter(k => !persisted(k));
      const stillPendingDeletes = [...this.deleted].filter(k => !persisted(k));
      const preserved: Record<string, StoredAnnotation> = {};
      for (const k of stillPending) {
        if (this.data[k] !== undefined) preserved[k] = this.data[k];
      }
      this.ingestRaw(finalRaw);
      for (const [k, v] of Object.entries(preserved)) {
        this.data[k] = v;
        delete this.quarantine[k];
      }
      for (const k of stillPendingDeletes) {
        delete this.data[k];
        delete this.quarantine[k];
      }
    }
    // Clear ONLY keys this save fully persisted (captured generation unchanged); the rest stay pending.
    for (const k of [...this.touched]) {
      if (persisted(k)) {
        this.touched.delete(k);
        this.touchedFields.delete(k);
        this.opGen.delete(k);
      }
    }
    for (const k of [...this.deleted]) {
      if (persisted(k)) {
        this.deleted.delete(k);
        this.opGen.delete(k);
      }
    }
    this.lastFlushedCount = Object.keys(finalRaw).length;
    this.setMergeStatusSnapshot(
      this.mergeStatusSnapshotFromContent(
        serializeAnnotationFileFromRaw({ version: 1, annotations: finalRaw }),
        true,
      ),
    );
    this.captureStatSync();
  }

  private async saveAsync(): Promise<void> {
    this.asyncSaveInFlight = true;
    try {
      await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
      // Acquisition is async so a waiter yields instead of blocking the event loop; the critical
      // section itself contains no `await`, which is the invariant that keeps the lock short-lived.
      // It used to hold the lock across `writeFileAtomic`, and that suspension point was the whole
      // problem: while the holder was parked, nothing else in this process could release it, so a
      // loaded event loop turned a millisecond write into a lock held past the wait deadline — and
      // the staleness takeover cannot help, because the pid in the lock is this process's own and is
      // very much alive. `annotation-lock-holds-no-await` holds this shape.
      await withAnnotationFileLockAsync(this.filePath, () => {
        this.assertWritable();
        const { finalRaw, merged } = this.composeFinalRaw();
        const capturedGen = new Map(this.opGen);
        this.maybeBackup(Object.keys(finalRaw).length);
        writeFileAtomicSync(
          this.filePath,
          serializeAnnotationFileFromRaw({ version: 1, annotations: finalRaw }),
        );
        this.finalizeWrite(finalRaw, merged, capturedGen);
      });
    } finally {
      this.asyncSaveInFlight = false;
    }
  }

  private saveSync(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    withAnnotationFileLockSync(this.filePath, () => {
      this.assertWritable();
      const { finalRaw, merged } = this.composeFinalRaw();
      const capturedGen = new Map(this.opGen);
      this.maybeBackup(Object.keys(finalRaw).length);
      writeFileAtomicSync(
        this.filePath,
        serializeAnnotationFileFromRaw({ version: 1, annotations: finalRaw }),
      );
      this.finalizeWrite(finalRaw, merged, capturedGen);
    });
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // Fire-and-forget: `runSaveWithRetry` already records `lastSaveError`, so swallow the rejection.
      void this.enqueueSave(() => this.runSaveWithRetry()).catch(() => { /* recorded in lastSaveError */ });
    }, SAVE_DEBOUNCE_MS);
  }

  /** Append a save to the single in-process chain so async saves never overlap. Chain never rejects. */
  private enqueueSave(run: () => Promise<void>): Promise<void> {
    const next = this.saveChain.then(run);
    this.saveChain = next.catch(() => { /* keep the chain alive after a failed save */ });
    return next;
  }

  /**
   * The one save routine every path funnels through: bounded retry, records `lastSaveError` (cleared on
   * success), throws on final failure so awaiting callers (durable write, flush, drain) learn the outcome.
   * A load-failure block never retries (it cannot succeed until reload). Lock timeouts retry as transient IO.
   */
  private async runSaveWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_SAVE_RETRIES; attempt++) {
      try {
        await this.saveAsync();
        this._lastSaveError = null;
        return;
      } catch (e) {
        lastError = e;
        const msg = (e as Error).message;
        this._lastSaveError = msg;
        if (this.writeBlockedAfterFailedLoad) {
          console.error(`  [ALERT] Annotations save blocked: ${msg}`);
          throw e;
        }
        if (attempt >= MAX_SAVE_RETRIES) {
          console.error(`  [ALERT] Annotations save FAILED after ${MAX_SAVE_RETRIES} attempts: ${msg}. Data may be lost on restart!`);
          throw e;
        }
        const delay = SAVE_DEBOUNCE_MS * attempt;
        console.error(`  [ALERT] Annotations save failed (attempt ${attempt}/${MAX_SAVE_RETRIES}): ${msg}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  get lastSaveError(): string | null {
    return this._lastSaveError;
  }

  /** What the last merge kept over a disagreeing file. Zeroed by every merge, so it describes the latest one. */
  get lastMergeKeeps(): AnnotationMergeKeeps {
    return { ...this.mergeKeeps, sample: [...this.mergeKeeps.sample] };
  }

  private recordMergeKeep(kind: 'readded' | 'reverted', nodeId: string): void {
    this.mergeKeeps[kind]++;
    if (this.mergeKeeps.sample.length < MERGE_KEEP_SAMPLE) this.mergeKeeps.sample.push(nodeId);
  }

  /**
   * Write pending annotations to disk immediately via the sync path (tests, one-shot CLI). Throws fast
   * if an async save holds the lock — synchronously waiting would busy-block the event loop for up to
   * the lock timeout. Async callers use {@link flushAsync} or {@link drain} instead.
   */
  flush(): void {
    if (this.asyncSaveInFlight) {
      throw new Error(
        'Cannot sync-flush annotations while an async save is in flight; use flushAsync()/drain().',
      );
    }
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveSync();
  }

  /**
   * Async flush: waits for any in-flight save, then persists via the retrying async path. Rejects on final
   * failure (so `durable: true` learns durability failed). On failure it re-arms the debounce so the pending
   * write is not stranded by the timer this method cancelled.
   */
  async flushAsync(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await this.enqueueSave(() => this.runSaveWithRetry());
    } catch (e) {
      if (this.touched.size > 0 || this.deleted.size > 0) this.scheduleSave();
      throw e;
    }
  }

  /**
   * Drain for graceful shutdown / store handoff: cancel the debounce, persist pending deltas (with retry),
   * and wait for the save chain to settle. Never throws — a failure is recorded in `lastSaveError`, since a
   * shutdown path must not reject.
   */
  async drain(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await this.enqueueSave(() => this.runSaveWithRetry());
    } catch (e) {
      this._lastSaveError = (e as Error).message;
      console.error(`  [ALERT] Annotations drain failed: ${this._lastSaveError}`);
    }
  }

  /**
   * Re-read the file and re-base in-memory state on it, preserving this process's uncommitted writes and
   * deletes. A long-lived runtime calls this on refresh so external edits (git pull) surface WITHOUT a
   * fresh store instance — a new store's orphaned debounce timer could fire after the swap and
   * clobber/resurrect records. Fail-closed on an unreadable/conflicted file: in-memory state is kept and
   * writes are blocked until repair, matching load-time behavior.
   */
  async reloadFromDisk(options: { signal?: AbortSignal } = {}): Promise<void> {
    const signal = options.signal;
    signal?.throwIfAborted();
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      // Async acquisition, synchronous transaction — same invariant as the save path. The read was
      // the one awaited operation in here, and holding the lock across it made the holder starvable
      // by anything that blocks the event loop.
      await withAnnotationFileLockAsync(this.filePath, () => {
        // Acquiring the cross-process lock can wait. Do not start disk IO for a refresh that was cancelled
        // while queued for it.
        signal?.throwIfAborted();
        let content: string;
        try {
          content = fs.readFileSync(this.filePath, 'utf-8');
        } catch (e) {
          signal?.throwIfAborted();
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // nothing on disk; keep memory as-is
          throw e;
        }

        // Nothing suspends between here and the commit below, so an abort cannot publish a partial
        // reload — the checkpoint stays because a cancelled refresh must not commit at all.
        signal?.throwIfAborted();
        const snapshot = this.mergeStatusSnapshotFromContent(content, true);
        if (!snapshot.parseOk) {
          // Corrupt/conflicted external file: keep our annotation data, but publish the fail-closed status.
          this.setMergeStatusSnapshot(snapshot);
          this.rememberFailedLoad(content);
          return;
        }
        const diskAnns = parseAnnotationsRawShape(content);
        if (diskAnns === null) {
          // Well-formed JSON but not a valid annotations envelope — fail closed like the save path.
          this.setMergeStatusSnapshot(snapshot);
          this.rememberFailedLoad(content);
          return;
        }
        // Merge disk INTO memory with the SAME semantics as a save-time merge: disk is the base, our pending
        // writes overlay it (field-merged via touchedFields), keys we hold but disk lacks are kept (never-drop,
        // the 19b5491 guarantee), our deletes apply. Reading `this.touched`/`this.data` here — after the await —
        // captures a set() that landed during the read, so it is not lost.
        this.ingestRaw(this.mergeWithDisk(diskAnns));
        this.setMergeStatusSnapshot(snapshot);
        this.captureStatSync();
      });
    } finally {
      // The reload cancelled the debounce. Restore it after success, failure, or cancellation so local
      // uncommitted writes/deletes cannot be stranded by an aborted refresh.
      if (this.touched.size > 0 || this.deleted.size > 0) this.scheduleSave();
    }
  }

  /**
   * Back up the existing file before overwriting it with `newCount` entries, when that would
   * shrink it by >5%. Runs on EVERY write path (called from saveSync/saveAsync), not just flush.
   */
  private maybeBackup(newCount: number): void {
    const currentCount = newCount;
    const previousCount = this.lastFlushedCount ?? currentCount;
    if (previousCount > 0 && (previousCount - currentCount) / previousCount > 0.05) {
      this.createBackup();
    }
  }

  private createBackup(content = this.failedLoadOriginalContent): boolean {
    let data: Buffer;
    try {
      if (content === undefined) {
        if (!fs.existsSync(this.filePath)) return false;
        data = fs.readFileSync(this.filePath);
      } else {
        data = Buffer.from(content, 'utf-8');
      }
    } catch (e) {
      console.error(`  [WARN] Failed to create annotation backup: ${(e as Error).message}`);
      return false;
    }
    const result = writeAnnotationBackup(this.filePath, data);
    if (result.status === 'failed') {
      console.error(`  [WARN] Failed to create annotation backup: ${result.error}`);
      return false;
    }
    if (result.status === 'written') {
      logPipeline(formatPipelineDetail(`  Annotation backup created: ${result.backupPath}`));
    }
    return true;
  }

  private assertWritable(): void {
    if (!this.writeBlockedAfterFailedLoad) return;
    if (this.failedLoadBackupPending && this.createBackup()) {
      this.failedLoadBackupPending = false;
      this.failedLoadOriginalContent = undefined;
    }
    const reason = this.mergeStatusSnapshot.error ?? 'annotation file did not load successfully';
    throw new Error(
      `Refusing to write ${this.filePath} while its loaded contents are invalid (${reason}). `
      + 'Repair or restore the file, then reload repovine before writing annotations.',
    );
  }

  /**
   * Accept deletions an external tool already committed to disk (merge_annotations resolving a git
   * conflict). Without this the never-drop net in {@link mergeWithDisk} treats the nodes as an
   * external add-gap and writes them back, undoing a resolution the merge reported as done.
   *
   * Unlike {@link delete}, this records an accomplished fact: it never schedules a save and is
   * allowed while writes are blocked, because the file on disk already lacks these nodes. It also
   * stays out of the pending-delete set, so a later write that legitimately re-adds one of these
   * nodes is accepted instead of being deleted again on every save.
   */
  forgetDeletedOnDisk(nodeIds: readonly string[]): void {
    for (const nodeId of nodeIds) {
      delete this.data[nodeId];
      delete this.quarantine[nodeId];
      this.touched.delete(nodeId);
      this.touchedFields.delete(nodeId);
    }
  }

  get(nodeId: string): StoredAnnotation | undefined {
    return this.data[nodeId];
  }

  /**
   * Write a full annotation record. `changedFields` names the annotation-content fields this write
   * changed; when a concurrent external writer touched the same node, only those fields overwrite the
   * disk record (other fields survive). Omit it for whole-record semantics (migrations, bulk merges).
   */
  set(nodeId: string, annotation: StoredAnnotation, changedFields?: readonly string[]): void {
    this.assertWritable();
    this.data[nodeId] = annotation;
    delete this.quarantine[nodeId];
    this.touched.add(nodeId);
    this.recordTouchedFields(nodeId, changedFields);
    this.deleted.delete(nodeId);
    this.opGen.set(nodeId, ++this.mutationSeq);
    this.scheduleSave();
  }

  /** Accumulate the changed-field set for a node across multiple writes before a persist. */
  private recordTouchedFields(nodeId: string, changedFields?: readonly string[]): void {
    if (changedFields === undefined) {
      this.touchedFields.set(nodeId, null); // whole-record write dominates any prior field-level set
      return;
    }
    const existing = this.touchedFields.get(nodeId);
    if (existing === null) return; // a prior whole-record write already covers this node
    const merged = existing ?? new Set<string>();
    for (const f of changedFields) merged.add(f);
    this.touchedFields.set(nodeId, merged);
  }

  /**
   * Content freshness of one node's annotation: hash and schema, without propagation.
   *
   * Propagation needs graph-wide inputs this signature does not carry, so a caller that reports
   * freshness to a reader passes the propagation verdict to {@link freshnessOf} instead.
   */
  isFresh(nodeId: string, currentHash: string): boolean {
    return this.freshnessOf(nodeId, currentHash).state === 'fresh';
  }

  /** The freshness verdict for one node, with propagation folded in when the caller evaluated it. */
  freshnessOf(nodeId: string, currentHash: string | undefined, propagationStale?: boolean): FreshnessVerdict {
    return annotationFreshness({
      annotation: this.data[nodeId],
      currentHash,
      ...(propagationStale === undefined ? {} : { propagationStale }),
    });
  }

  getAll(): Record<string, StoredAnnotation> {
    return this.data;
  }

  /** Delete specific annotation entries by node id. Returns number deleted. */
  delete(nodeIds: string[]): number {
    this.assertWritable();
    let count = 0;
    for (const id of nodeIds) {
      let existed = false;
      if (id in this.data) { delete this.data[id]; existed = true; }
      if (id in this.quarantine) { delete this.quarantine[id]; existed = true; }
      if (existed) {
        // An explicit delete is the ONLY thing that removes an entry from disk on the next write.
        this.deleted.add(id);
        this.touched.delete(id);
        this.touchedFields.delete(id);
        this.opGen.set(id, ++this.mutationSeq);
        count++;
      }
    }
    if (count > 0) this.scheduleSave();
    return count;
  }

  get dataEntries(): Record<string, StoredAnnotation> {
    return this.data;
  }

  getMergeStatusSnapshot(): AnnotationFileStatusSnapshot {
    return { ...this.mergeStatusSnapshot };
  }

  detectOrphaned(graph: RepositoryGraph): {
    total: number;
    orphaned: Array<{
      nodeId: string;
      nodeType: string;
      pass: number;
      updatedAt: string;
      summaryPreview: string;
      reason: 'node_missing' | 'node_type_changed';
    }>;
    byType: Record<string, number>;
  } {
    const orphaned: Array<{
      nodeId: string;
      nodeType: string;
      pass: number;
      updatedAt: string;
      summaryPreview: string;
      reason: 'node_missing' | 'node_type_changed';
    }> = [];
    const byType: Record<string, number> = {};

    for (const [nodeId, ann] of Object.entries(this.data)) {
      const graphNode = graph.nodes.get(nodeId);
      if (!graphNode) {
        orphaned.push({
          nodeId,
          nodeType: ann.nodeType,
          pass: ann.pass,
          updatedAt: ann.updatedAt,
          summaryPreview: shortenText(ann.annotation?.summary ?? '', 100),
          reason: 'node_missing',
        });
        byType[ann.nodeType] = (byType[ann.nodeType] ?? 0) + 1;
      } else if (graphNode.type !== ann.nodeType) {
        orphaned.push({
          nodeId,
          nodeType: ann.nodeType,
          pass: ann.pass,
          updatedAt: ann.updatedAt,
          summaryPreview: shortenText(ann.annotation?.summary ?? '', 100),
          reason: 'node_type_changed',
        });
        byType[ann.nodeType] = (byType[ann.nodeType] ?? 0) + 1;
      }
    }

    return {
      total: orphaned.length,
      orphaned: orphaned.sort((a, b) => b.pass - a.pass),
      byType,
    };
  }

  /**
   * The one walk over the annotatable surface. Every queue and every coverage number this store
   * publishes is a projection of this result, so a node the queue leaves out is never reported as
   * work by coverage.
   */
  private backlog(
    graph: RepositoryGraph,
    snapshot: RepositoryFactsSnapshot,
    options: {
      domain?: string;
      propagation?: PropagationConfig;
      entrypoints?: readonly EntrypointFragment[];
    },
  ): AnnotationBacklog {
    return buildAnnotationBacklog({
      graph,
      snapshot,
      annotations: this.data,
      ...(options.domain !== undefined ? { domain: options.domain } : {}),
      ...(options.propagation ? { propagation: options.propagation } : {}),
      ...(options.entrypoints ? { entrypoints: options.entrypoints } : {}),
    });
  }

  /**
   * The top of the prioritized backlog: content-stale and schema-outdated notes, unannotated nodes,
   * then modules whose stored importBaseline drifted — the tier that persists after the hard queue
   * closes.
   */
  getQueue(
    graph: RepositoryGraph,
    snapshot: RepositoryFactsSnapshot,
    options: {
      domain?: string;
      limit?: number;
      propagation?: PropagationConfig;
      entrypoints?: readonly EntrypointFragment[];
    } = {},
  ): QueueItem[] {
    const limit = options.limit ?? 10;
    const rows = sortBacklogRows(this.backlog(graph, snapshot, options).rows);
    return rows.slice(0, limit).map(row => row.hydrate());
  }

  getQueuePage(
    graph: RepositoryGraph,
    snapshot: RepositoryFactsSnapshot,
    options: {
      domain?: string;
      limit?: number;
      offset?: number;
      propagation?: PropagationConfig;
      entrypoints?: readonly EntrypointFragment[];
      derivedOnly?: boolean;
      staleKind?: StaleKind;
    } = {},
  ): AnnotationQueuePage {
    const { limit = 10, offset = 0, derivedOnly = false, staleKind } = options;
    const rows = sortBacklogRows(this.backlog(graph, snapshot, options).rows);

    let displayRows = derivedOnly ? filterRowsByStaleKind(rows, 'propagation') : rows;
    if (staleKind) displayRows = filterRowsByStaleKind(displayRows, staleKind);

    return {
      items: displayRows.slice(offset, offset + limit).map(row => row.hydrate()),
      counts: countBacklogRows(rows),
      displayCounts: countBacklogRows(displayRows),
      byType: countBacklogPhases(displayRows),
    };
  }

  /**
   * The backlog for annotation health and compliance gates: classification and order for every
   * needs-work node, item text only for the sampled ones.
   */
  scanAnnotationHealth(
    graph: RepositoryGraph,
    snapshot: RepositoryFactsSnapshot,
    options: {
      domain?: string;
      propagation?: PropagationConfig;
      entrypoints?: readonly EntrypointFragment[];
    } = {},
  ): AnnotationHealthScan {
    const rows = sortBacklogRows(this.backlog(graph, snapshot, options).rows);
    const liteRows: AnnotationHealthScanRow[] = rows.map(row => ({
      nodeId: row.nodeId,
      status: row.status,
      ...(row.staleKind ? { staleKind: row.staleKind } : {}),
      phase: row.phase,
    }));
    const sample: AnnotationHealthScan['sample'] = (limit, predicate) => {
      const out: AnnotationHealthSampleItem[] = [];
      for (const row of rows) {
        if (out.length >= limit) break;
        if (predicate && !predicate(row)) continue;
        const item = row.hydrate();
        out.push({
          nodeId: item.nodeId,
          status: item.status,
          ...(item.staleKind ? { staleKind: item.staleKind } : {}),
          moduleKind: item.moduleKind,
          reason: item.reason,
        });
      }
      return out;
    };
    return { counts: countBacklogRows(rows), rows: liteRows, sample };
  }

  /** Annotation coverage, tallied by the same walk that ranks the queue. */
  getStats(
    graph: RepositoryGraph,
    snapshot: RepositoryFactsSnapshot,
    options: {
      domain?: string;
      propagation?: PropagationConfig;
      entrypoints?: readonly EntrypointFragment[];
    } = {},
  ): BacklogCoverage {
    return this.backlog(graph, snapshot, options).coverage;
  }

}
