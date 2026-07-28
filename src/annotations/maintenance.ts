import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalJson } from '@repovine/plugin-sdk';
import type { RepositoryGraph, AnnotationContent, StoredAnnotation, RepositoryFactsSnapshot } from '../types.js';
import { nextCall, type NextCall } from '../response/next-call.js';
import type { AnnotationStore, AnnotationHealthScan, AnnotationFileStatusSnapshot } from './store.js';
import { describeMergeKeeps } from './store.js';
import { isPropagationStaleItem, isContentStaleItem } from './backlog.js';
import { getInterpreterEntrypoints } from '../stage2/interpreter/entrypoint-store.js';
import { ANNOTATIONS_FILENAME, ARTIFACTS_DIR_NAME, resolveAnnotationsFilePath } from '../paths.js';
import { loadConfig } from '../config.js';
import { writeFileAtomicSync } from '../fs/atomic.js';
import { withAnnotationFileLockSync } from './file-lock.js';
import {
  canonicalAnnotation,
  canonicalAnnotationContent,
  consumerRiskMarkingHints,
  hydrateAnnotationMap,
  normalizeRisks,
  parseAnnotationFile,
  parseAnnotationsRawShape,
  serializeAnnotationFile as serializeAnnotationFileInternal,
  type AnnotationFile,
} from './format.js';
import { writeAnnotationBackup } from './backup.js';
import { applyMergeReviewHints, listMergeReviewFields } from './merge-review.js';
import {
  computeCarrierLinkGaps,
  type CarrierLinkGaps,
} from './carrier-links.js';
import { readValidSuppressedTargets } from './carrier-review.js';
import { computeInconsistentModuleAnnotations } from './quality.js';
import { nodeInScopeHints } from './scope-hints.js';
import {
  computeRiskScopeCandidates,
  type RiskScopeCandidates,
} from './risk-scope-candidates.js';
import { shortenText } from '../platform/text.js';

/** Default annotations filename at workspace root when config is absent. */
export const ANNOTATIONS_RELATIVE_PATH = ANNOTATIONS_FILENAME;
export { serializeAnnotationFile } from './format.js';
export { serializeAnnotationFileFromRaw } from './format.js';

/** Canonical empty on-disk shape for a new workspace. */
export const EMPTY_ANNOTATION_FILE_TEXT = '{\n  "version": 1,\n  "annotations": {}\n}\n';

/** Create an empty annotations file when missing. Returns true when the file was written. */
export function ensureEmptyAnnotationsFileAtPath(filePath: string): boolean {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, EMPTY_ANNOTATION_FILE_TEXT, 'utf-8');
  return true;
}

/** Create the workspace annotations file from config path when missing. */
export function ensureEmptyAnnotationsFile(repoRoot: string, relativePath = ANNOTATIONS_FILENAME): boolean {
  return ensureEmptyAnnotationsFileAtPath(resolveAnnotationsFilePath(repoRoot, relativePath));
}

export interface AnnotationMergeConflict {
  nodeId: string;
  field: string;
  chosen: 'ours' | 'theirs';
  reason: string;
  oursPreview?: string;
  theirsPreview?: string;
}

export interface AnnotationMergeReport {
  status: 'merged' | 'normalized' | 'no-conflict' | 'dry-run' | 'error';
  filePath: string;
  wroteFile: boolean;
  autoMerged: number;
  added: number;
  deleted: number;
  unchanged: number;
  annotationConflicts: AnnotationMergeConflict[];
  /**
   * Where the three-way merge base came from: git index stage :1: (exact), diff3 base sections
   * reconstructed from conflict markers (approximate), or none (empty base, add/add semantics).
   * Present only on reports produced by conflict merging.
   */
  baseSource?: 'git-index' | 'conflict-markers-diff3' | 'none';
  /** What the merge lost or skipped in the base: dropped entries, or a base that would not parse. */
  baseWarning?: string;
  /** Backup of the conflicted worktree bytes replaced by an index-stage merge. */
  replacedBackupPath?: string;
  /** Nodes the merge removed. A live store must forget them or its never-drop net restores them. */
  deletedNodeIds?: string[];
  /** The git index entry for the file is unmerged while the worktree carries no markers. */
  indexUnmerged?: boolean;
  message: string;
}

export interface AnnotationMergeStatus {
  filePath: string;
  file: {
    exists: boolean;
    parseOk: boolean;
    hasConflictMarkers: boolean;
    annotationCount?: number;
    error?: string;
  };
  /**
   * The git index entry is unmerged. True without conflict markers for file-level conflicts
   * (binary/-merge attribute, modify/delete, rename) and for a file already resolved by hand.
   */
  indexUnmerged?: boolean;
  nextActions: NextCall[];
}

/** Advisory density thresholds for consumer-scoped risks. Never gate (advisory only). */
export const CONSUMER_SCOPE_PER_NODE_WARN = 3;
export const CONSUMER_SCOPE_GLOBAL_RATIO_WARN = 0.5;

/** Advisory consumer-scope density signal — flood guard, never affects clean status. */
export interface ConsumerScopeDensity {
  /** Risk entries marked `scope: "consumer"` across all annotations. */
  consumerRisks: number;
  /** All risk entries (local + consumer). */
  totalRisks: number;
  /** consumerRisks / totalRisks (0 when no risks). */
  ratio: number;
  /** ratio exceeds {@link CONSUMER_SCOPE_GLOBAL_RATIO_WARN}. */
  overGlobalThreshold: boolean;
  /** Nodes marking more than {@link CONSUMER_SCOPE_PER_NODE_WARN} consumer risks. */
  nodesOverPerNodeCap: Array<{ nodeId: string; count: number }>;
  /** Consumer-scoped risks whose text omits the importer obligation (marking-bar). */
  unmarkedConsumerRisks: number;
}

export interface AnnotationValidationReport {
  status: 'clean' | 'needs-review';
  mergeStatus: AnnotationMergeStatus;
  counts: {
    annotations: number;
    orphaned: number;
    stale: number;
    staleContent: number;
    stalePropagation: number;
    unannotated: number;
    mergeReview: number;
    /**
     * Stored notes whose filled fields contradict a graph fact — the only correctness axis the engine
     * has. Reported here because a tool named `validate` omitted it entirely; the contradicting names
     * live in `get_annotation_status({ view: "coverage" })`, and `nextActions` points at them.
     *
     * Advisory, like the axis it comes from: it does not move `status`. A contradiction is a claim
     * about content the author wrote, and the drain queue is about content the graph moved — folding
     * one into the other would make `repovine status` exit non-zero on a repository whose annotations
     * are all current.
     */
    inconsistent: number;
  };
  consumerScopeDensity: ConsumerScopeDensity;
  carrierLinkGaps: CarrierLinkGaps;
  riskScopeCandidates: RiskScopeCandidates;
  needsWork: number;
  needsWorkInScope?: number;
  scope?: string[];
  scopedClean?: boolean;
  orphanedByType?: Record<string, number>;
  queueSample: Array<{
    nodeId: string;
    status: string;
    moduleKind?: string;
    reason: string;
  }>;
  /**
   * What to call next, empty when nothing needs doing. `status` is where "nothing needs doing" is
   * read; this list had carried a status line as if it were a call, and two consumers recognised
   * that line by matching its text back out.
   */
  nextActions: NextCall[];
}

/**
 * What to call about the annotation file's merge state. One builder for both readers of that state —
 * the cached store snapshot and the fresh disk read — which had carried byte-identical copies.
 */
function mergeStatusNextActions(file: AnnotationFileStatusSnapshot, indexUnmerged: boolean): NextCall[] {
  const nextActions: NextCall[] = [];
  if (file.hasConflictMarkers) {
    nextActions.push(nextCall('merge_annotations', {}, 'Resolve annotation JSON with merge rules.'));
  }
  if (indexUnmerged) {
    nextActions.push(nextCall(
      'merge_annotations',
      { fromIndex: true },
      'The git index entry for repovine.annots.json is unmerged although the file has no conflict markers '
      + '(file-level conflict, or an already hand-resolved file). Merge the index stages, or `git add` the '
      + 'file if the worktree copy is the intended resolution.',
    ));
  }
  if (!file.parseOk && file.exists && !file.hasConflictMarkers) {
    nextActions.push({ reason: 'Fix repovine.annots.json parse error or restore it before annotation work.' });
  }
  if (file.parseOk) {
    nextActions.push(nextCall('validate_annotations', {}, 'Check annotation health before handoff or after a git merge/rebase.'));
  }
  return nextActions;
}

function annotationMergeStatusFromSnapshot(
  filePath: string,
  file: AnnotationFileStatusSnapshot,
): AnnotationMergeStatus {
  const indexUnmerged = !file.hasConflictMarkers && file.exists && isIndexUnmerged(filePath);
  return {
    filePath,
    file,
    ...(indexUnmerged ? { indexUnmerged } : {}),
    nextActions: mergeStatusNextActions(file, indexUnmerged),
  };
}

type MergeSide = 'ours' | 'theirs';

function annotationPath(repoRoot: string, annotationsFile?: string): string {
  const relative = annotationsFile ?? loadConfig(repoRoot).workspace.annotationsFile;
  return resolveAnnotationsFilePath(repoRoot, relative);
}

function writeAnnotationFileWhileLocked(filePath: string, content: string): void {
  writeFileAtomicSync(filePath, content);
}

function hasConflictMarkers(content: string): boolean {
  return /^(<<<<<<<|=======|>>>>>>>) ?/m.test(content);
}

/**
 * Reconstruct ours/theirs (and a base when every hunk carried a diff3 `|||||||` section) from a
 * conflicted file. zdiff3 hoists lines shared by both sides out of the conflict region while
 * leaving the base section whole, so its reconstructed base can be structurally invalid; the
 * caller treats an unparseable base as empty rather than failing the merge.
 */
function splitConflictMarkerSides(content: string): {
  ours: string;
  theirs: string;
  /** Present when every conflict hunk carried a diff3/zdiff3 `|||||||` base section. */
  base?: string;
  conflictCount: number;
} {
  const ours: string[] = [];
  const theirs: string[] = [];
  const base: string[] = [];
  let side: 'both' | 'ours' | 'base' | 'theirs' = 'both';
  let conflictCount = 0;
  let baseSectionCount = 0;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^<<<<<<< ?/.test(line)) {
      if (side !== 'both') throw new Error('Nested or malformed conflict marker in repovine.annots.json');
      side = 'ours';
      conflictCount++;
      continue;
    }
    if (/^\|\|\|\|\|\|\| ?/.test(line)) {
      if (side !== 'ours') throw new Error('Malformed diff3 base marker in repovine.annots.json');
      side = 'base';
      baseSectionCount++;
      continue;
    }
    if (/^======= ?/.test(line)) {
      if (side !== 'ours' && side !== 'base') throw new Error('Malformed conflict separator in repovine.annots.json');
      side = 'theirs';
      continue;
    }
    if (/^>>>>>>> ?/.test(line)) {
      if (side !== 'theirs') throw new Error('Malformed conflict end marker in repovine.annots.json');
      side = 'both';
      continue;
    }

    if (side === 'both' || side === 'ours') ours.push(rawLine);
    if (side === 'both' || side === 'theirs') theirs.push(rawLine);
    if (side === 'both' || side === 'base') base.push(rawLine);
  }

  if (side !== 'both') throw new Error('Unclosed conflict marker in repovine.annots.json');
  if (conflictCount === 0) throw new Error('repovine.annots.json has no conflict markers');

  return {
    ours: ours.join('\n'),
    theirs: theirs.join('\n'),
    ...(baseSectionCount === conflictCount ? { base: base.join('\n') } : {}),
    conflictCount,
  };
}

interface GitIndexMergeStages {
  base?: string;
  ours?: string;
  theirs?: string;
}

/** repovine.annots.json can reach tens of MB; keep git blob reads far above that. */
const GIT_STAGE_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Ambient git environment variables repoint a child at another repository or index. Stage reads
 * must resolve against the repository holding the annotations file, so they are dropped.
 */
const GIT_ENV_OVERRIDES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
] as const;

function gitChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_ENV_OVERRIDES) delete env[key];
  return env;
}

function runGit(cwd: string, args: string[]): { ok: true; out: string } | { ok: false } {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: GIT_STAGE_MAX_BUFFER,
      env: gitChildEnv(),
    });
    return { ok: true, out };
  } catch {
    return { ok: false };
  }
}

/**
 * True when the repository reachable from `cwd` actually contains `filePath`. Guards against a
 * worktree whose git metadata resolves elsewhere: stages read from another repository would be
 * merged into this file as if they were its own history.
 */
function gitRepoContains(cwd: string, filePath: string): boolean {
  const top = runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return false;
  const root = top.out.trim();
  if (!root) return false;
  // realpathSync.native expands Windows 8.3 short names (GetFinalPathNameByHandleW):
  // os.tmpdir() can be `C:\Users\RUNNER~1\...` while git prints the long form, and the
  // plain realpathSync resolves symlinks only, leaving the two forms unequal. Strip the
  // `\\?\` namespace prefix native can add, and case-fold on win32 (NTFS identity) —
  // relaxed comparison scoped to this repo-membership check.
  const real = (p: string): string => {
    let r = p;
    try {
      r = fs.realpathSync.native(p);
    } catch {
      try {
        r = fs.realpathSync(p);
      } catch {
        /* keep the input form */
      }
    }
    // Long-path namespace prefixes: `\\?\UNC\server\share` unprefixes to
    // `\\server\share`; `\\?\C:\x` to `C:\x`.
    if (r.startsWith('\\\\?\\UNC\\')) r = `\\\\${r.slice(8)}`;
    else if (r.startsWith('\\\\?\\')) r = r.slice(4);
    // Separator fold covers git's forward-slash form (`C:/…` from rev-parse)
    // reaching a compare against a native dirname on the realpath-failure path.
    return process.platform === 'win32' ? r.split('/').join('\\').toLowerCase() : r;
  };
  const rootReal = real(root);
  const fileReal = real(path.dirname(filePath));
  const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  return fileReal === rootReal || fileReal.startsWith(rootWithSep);
}

/** True when git reports unmerged index stages for the annotations path. */
function isIndexUnmerged(filePath: string): boolean {
  const cwd = path.dirname(filePath);
  if (!gitRepoContains(cwd, filePath)) return false;
  // cwd is already dirname(filePath): a basename pathspec lets git resolve the
  // match against its own prefix, so Node-side path form (8.3 short vs long,
  // backslash vs slash, drive case) never enters the comparison.
  const listing = runGit(cwd, ['ls-files', '-u', '-z', '--', `:(literal)${path.basename(filePath)}`]);
  return listing.ok && listing.out.length > 0;
}

/**
 * Read base/ours/theirs of an unmerged path from the git index (stages :1:/:2:/:3:).
 * Returns undefined when the file is not in an unmerged state or git is unavailable —
 * the caller then falls back to parsing worktree conflict markers.
 */
function readGitIndexMergeStages(filePath: string): GitIndexMergeStages | undefined {
  const cwd = path.dirname(filePath);
  if (!gitRepoContains(cwd, filePath)) return undefined;
  // `:(literal)` disables pathspec globbing: an annotations path containing `*`, `?`, or `[…]`
  // otherwise also matches sibling files, whose stages would silently overwrite the target's.
  // cwd is already dirname(filePath): a basename pathspec lets git resolve the
  // match against its own prefix, so Node-side path form (8.3 short vs long,
  // backslash vs slash, drive case) never enters the comparison.
  const listing = runGit(cwd, ['ls-files', '-u', '-z', '--', `:(literal)${path.basename(filePath)}`]);
  if (!listing.ok || listing.out.length === 0) return undefined;

  const keyByStage: Record<string, keyof GitIndexMergeStages> = { '1': 'base', '2': 'ours', '3': 'theirs' };
  const stages: GitIndexMergeStages = {};
  let entryPath: string | undefined;
  for (const entry of listing.out.split('\0')) {
    if (!entry) continue;
    // Entry shape: "<mode> <sha> <stage>\t<path>".
    const tab = entry.indexOf('\t');
    if (tab < 0) return undefined;
    const [mode, sha, stage] = entry.slice(0, tab).split(' ');
    const key = stage !== undefined ? keyByStage[stage] : undefined;
    if (!mode || !sha || !key) return undefined;
    // Every entry must describe the same path; a second path means the pathspec matched more
    // than the target and the stages cannot be attributed. Fall back to marker parsing.
    const listedPath = entry.slice(tab + 1);
    if (entryPath === undefined) entryPath = listedPath;
    else if (entryPath !== listedPath) return undefined;
    const blob = runGit(cwd, ['cat-file', 'blob', sha]);
    if (!blob.ok) return undefined;
    stages[key] = blob.out;
  }

  if (stages.ours === undefined && stages.theirs === undefined) return undefined;
  return stages;
}

/**
 * Parse a merge base whose annotation content is only compared against, never taken as an output
 * side (`pass` and `schemaVersion` are the exception: both are maxed across base/ours/theirs, so a
 * base entry can raise them in the written record). Historical base content
 * predates schema tightening, and a diff3 reconstruction can be structurally broken (zdiff3 hoists
 * lines shared by both sides out of the conflict region while keeping the base section intact).
 * Neither is a reason to fail a merge that would otherwise succeed: invalid entries drop out of the
 * base, an unparseable base degrades to empty (add/add semantics), and the caller reports the loss.
 */
function parseMergeBaseLenient(
  content: string | undefined,
  label: string,
): { file: AnnotationFile; degraded: boolean; warning?: string } {
  if (!content || !content.trim()) return { file: { version: 1, annotations: {} }, degraded: false };
  try {
    return { file: parseAnnotationFile(content, label), degraded: false };
  } catch (e) {
    const raw = (() => {
      try {
        return parseAnnotationsRawShape(content);
      } catch {
        return null;
      }
    })();
    if (raw === null) {
      return {
        file: { version: 1, annotations: {} },
        degraded: true,
        warning: `merge base (${label}) is unreadable (${(e as Error).message}); merged without a base, `
          + 'so deletions on one side were treated as additions on the other',
      };
    }
    const hydrated = hydrateAnnotationMap(raw);
    const dropped = hydrated.errors.length;
    return {
      file: { version: 1, annotations: hydrated.data },
      degraded: false,
      ...(dropped > 0
        ? {
          warning: `merge base (${label}) has ${dropped} entry(ies) invalid under the current schema; `
            + 'they were excluded from base comparison',
        }
        : {}),
    };
  }
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Two values are the same annotation fact when their canonical bytes match. The canonicalization is
 *  the published one: a second recursive key-sort here would drift from the form the graph compares
 *  edges by, and from the one a producer hashes a resource with. */
function stableEquals(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function preview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return shortenText(text, 160);
}

function chooseSide(ours: StoredAnnotation, theirs: StoredAnnotation): MergeSide {
  const oursTime = Date.parse(ours.updatedAt || '');
  const theirsTime = Date.parse(theirs.updatedAt || '');
  if (!Number.isNaN(oursTime) && !Number.isNaN(theirsTime) && theirsTime > oursTime) return 'theirs';
  return 'ours';
}

function sideValue<T>(side: MergeSide, ours: T, theirs: T): T {
  return side === 'ours' ? ours : theirs;
}

function mergeArrayValues(ours: unknown[], theirs: unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const value of [...ours, ...theirs]) {
    const key = canonicalJson(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function mergeAnnotationContentValue(
  nodeId: string,
  field: string,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  preferred: MergeSide,
  conflicts: AnnotationMergeConflict[],
): unknown {
  if (stableEquals(ours, theirs)) return clone(ours);
  if (base !== undefined && stableEquals(base, ours)) return clone(theirs);
  if (base !== undefined && stableEquals(base, theirs)) return clone(ours);
  if (ours === undefined && theirs === undefined) return undefined;
  if (ours === undefined) {
    if (base !== undefined && !stableEquals(base, theirs)) {
      conflicts.push({
        nodeId,
        field,
        chosen: 'theirs',
        reason: 'ours deleted field while theirs changed it',
        theirsPreview: preview(theirs),
      });
    }
    return clone(theirs);
  }
  if (theirs === undefined) {
    if (base !== undefined && !stableEquals(base, ours)) {
      conflicts.push({
        nodeId,
        field,
        chosen: 'ours',
        reason: 'theirs deleted field while ours changed it',
        oursPreview: preview(ours),
      });
    }
    return clone(ours);
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) return mergeArrayValues(ours, theirs);
  if (isPlainRecord(ours) && isPlainRecord(theirs)) {
    const out: Record<string, unknown> = {};
    const keys = new Set([
      ...Object.keys(isPlainRecord(base) ? base : {}),
      ...Object.keys(ours),
      ...Object.keys(theirs),
    ]);
    for (const key of [...keys].sort()) {
      const merged = mergeAnnotationContentValue(
        nodeId,
        `${field}.${key}`,
        isPlainRecord(base) ? base[key] : undefined,
        ours[key],
        theirs[key],
        preferred,
        conflicts,
      );
      if (merged !== undefined) out[key] = merged;
    }
    return out;
  }

  const chosen = sideValue(preferred, ours, theirs);
  conflicts.push({
    nodeId,
    field,
    chosen: preferred,
    reason: 'both sides changed this scalar field differently',
    oursPreview: preview(ours),
    theirsPreview: preview(theirs),
  });
  return clone(chosen);
}

function mergeAnnotationContent(
  nodeId: string,
  base: AnnotationContent | undefined,
  ours: AnnotationContent,
  theirs: AnnotationContent,
  preferred: MergeSide,
  conflicts: AnnotationMergeConflict[],
): AnnotationContent {
  const out: Record<string, unknown> = {};
  const baseRecord = (base ?? {}) as unknown as Record<string, unknown>;
  const oursRecord = ours as unknown as Record<string, unknown>;
  const theirsRecord = theirs as unknown as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(baseRecord),
    ...Object.keys(oursRecord),
    ...Object.keys(theirsRecord),
  ]);

  for (const key of [...keys].sort()) {
    const merged = mergeAnnotationContentValue(
      nodeId,
      `annotation.${key}`,
      baseRecord[key],
      oursRecord[key],
      theirsRecord[key],
      preferred,
      conflicts,
    );
    if (merged !== undefined) out[key] = merged;
  }

  if (typeof out.summary !== 'string' || out.summary.length === 0) {
    out.summary = sideValue(preferred, ours.summary, theirs.summary);
  }
  return canonicalAnnotationContent(out as unknown as AnnotationContent);
}

function mergeChangedAnnotations(
  nodeId: string,
  base: StoredAnnotation | undefined,
  ours: StoredAnnotation,
  theirs: StoredAnnotation,
  conflicts: AnnotationMergeConflict[],
): StoredAnnotation {
  const preferred = chooseSide(ours, theirs);
  const mergedContent = mergeAnnotationContent(nodeId, base?.annotation, ours.annotation, theirs.annotation, preferred, conflicts);
  const annotation = applyMergeReviewHints(mergedContent, conflicts, nodeId);
  const nodeType = stableEquals(ours.nodeType, theirs.nodeType)
    ? ours.nodeType
    : sideValue(preferred, ours.nodeType, theirs.nodeType);
  if (!stableEquals(ours.nodeType, theirs.nodeType)) {
    conflicts.push({
      nodeId,
      field: 'nodeType',
      chosen: preferred,
      reason: 'node type changed differently on both sides',
      oursPreview: preview(ours.nodeType),
      theirsPreview: preview(theirs.nodeType),
    });
  }
  const contentHash = stableEquals(ours.contentHash, theirs.contentHash)
    ? ours.contentHash
    : sideValue(preferred, ours.contentHash, theirs.contentHash);
  const schemaVersion = Math.max(base?.schemaVersion ?? 1, ours.schemaVersion ?? 1, theirs.schemaVersion ?? 1);

  return canonicalAnnotation({
    nodeId,
    nodeType,
    contentHash,
    pass: Math.max(base?.pass ?? 0, ours.pass ?? 0, theirs.pass ?? 0),
    updatedAt: new Date().toISOString(),
    annotation,
    schemaVersion,
  });
}

export function mergeAnnotationFiles(
  baseFile: AnnotationFile,
  oursFile: AnnotationFile,
  theirsFile: AnnotationFile,
): {
  file: AnnotationFile;
  autoMerged: number;
  added: number;
  deleted: number;
  unchanged: number;
  /** Nodes present in the base but absent from the merged file — a live store must forget them. */
  deletedNodeIds: string[];
  annotationConflicts: AnnotationMergeConflict[];
} {
  const annotationConflicts: AnnotationMergeConflict[] = [];
  const annotations: Record<string, StoredAnnotation> = {};
  const deletedNodeIds: string[] = [];
  let autoMerged = 0;
  let added = 0;
  let deleted = 0;
  let unchanged = 0;

  const nodeIds = new Set([
    ...Object.keys(baseFile.annotations),
    ...Object.keys(oursFile.annotations),
    ...Object.keys(theirsFile.annotations),
  ]);

  for (const nodeId of [...nodeIds].sort()) {
    const base = baseFile.annotations[nodeId];
    const ours = oursFile.annotations[nodeId];
    const theirs = theirsFile.annotations[nodeId];

    let next: StoredAnnotation | undefined;
    if (!ours && !theirs) {
      deleted++;
      deletedNodeIds.push(nodeId);
      continue;
    } else if (!base && ours && !theirs) {
      next = ours;
      added++;
    } else if (!base && theirs && !ours) {
      next = theirs;
      added++;
    } else if (ours && theirs && stableEquals(ours, theirs)) {
      next = ours;
      unchanged++;
    } else if (base && ours && stableEquals(base, ours) && theirs) {
      next = theirs;
      autoMerged++;
    } else if (base && theirs && stableEquals(base, theirs) && ours) {
      next = ours;
      autoMerged++;
    } else if (base && !ours && theirs) {
      if (stableEquals(base, theirs)) {
        deleted++;
        deletedNodeIds.push(nodeId);
        continue;
      }
      next = theirs;
      autoMerged++;
      annotationConflicts.push({
        nodeId,
        field: '*',
        chosen: 'theirs',
        reason: 'ours deleted annotation while theirs changed it',
      });
    } else if (base && !theirs && ours) {
      if (stableEquals(base, ours)) {
        deleted++;
        deletedNodeIds.push(nodeId);
        continue;
      }
      next = ours;
      autoMerged++;
      annotationConflicts.push({
        nodeId,
        field: '*',
        chosen: 'ours',
        reason: 'theirs deleted annotation while ours changed it',
      });
    } else if (ours && theirs) {
      next = mergeChangedAnnotations(nodeId, base, ours, theirs, annotationConflicts);
      autoMerged++;
    }

    if (next) annotations[nodeId] = canonicalAnnotation(next);
  }

  return {
    file: { version: 1, annotations },
    autoMerged,
    added,
    deleted,
    unchanged,
    deletedNodeIds,
    annotationConflicts,
  };
}

export function getAnnotationMergeStatus(
  repoRoot: string,
  annotationsFile?: string,
  options?: { annotations?: Pick<AnnotationStore, 'getMergeStatusSnapshot'> },
): AnnotationMergeStatus {
  const filePath = annotationPath(repoRoot, annotationsFile);
  if (options?.annotations) {
    return annotationMergeStatusFromSnapshot(filePath, options.annotations.getMergeStatusSnapshot());
  }
  let exists = false;
  let parseOk = false;
  let hasMarkers = false;
  let annotationCount: number | undefined;
  let fileError: string | undefined;
  try {
    exists = fs.existsSync(filePath);
    if (exists) {
      const content = fs.readFileSync(filePath, 'utf-8');
      hasMarkers = hasConflictMarkers(content);
      if (!hasMarkers) {
        const parsed = parseAnnotationFile(content, filePath);
        parseOk = true;
        annotationCount = Object.keys(parsed.annotations).length;
      } else {
        fileError = 'contains conflict markers';
      }
    }
  } catch (e) {
    fileError = (e as Error).message;
  }

  const indexUnmerged = !hasMarkers && exists && isIndexUnmerged(filePath);
  const file: AnnotationFileStatusSnapshot = {
    exists,
    parseOk,
    hasConflictMarkers: hasMarkers,
    ...(annotationCount !== undefined ? { annotationCount } : {}),
    ...(fileError ? { error: fileError } : {}),
  };

  return {
    filePath,
    file,
    ...(indexUnmerged ? { indexUnmerged } : {}),
    nextActions: mergeStatusNextActions(file, indexUnmerged),
  };
}

export function normalizeAnnotationsFile(
  repoRoot: string,
  dryRun = false,
  annotationsFile?: string,
): AnnotationMergeReport {
  const filePath = annotationPath(repoRoot, annotationsFile);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return withAnnotationFileLockSync(filePath, () => (
      normalizeAnnotationsFileWhileLocked(filePath, dryRun)
    ));
  } catch (e) {
    return {
      status: 'error',
      filePath,
      wroteFile: false,
      autoMerged: 0,
      added: 0,
      deleted: 0,
      unchanged: 0,
      annotationConflicts: [],
      message: (e as Error).message,
    };
  }
}

function normalizeAnnotationsFileWhileLocked(
  filePath: string,
  dryRun: boolean,
  knownContent?: string,
): AnnotationMergeReport {
  if (!fs.existsSync(filePath)) {
    return {
      status: 'no-conflict',
      filePath,
      wroteFile: false,
      autoMerged: 0,
      added: 0,
      deleted: 0,
      unchanged: 0,
      annotationConflicts: [],
      message: 'repovine.annots.json does not exist yet',
    };
  }
  const content = knownContent ?? fs.readFileSync(filePath, 'utf-8');
  if (hasConflictMarkers(content)) {
    return {
      status: 'error',
      filePath,
      wroteFile: false,
      autoMerged: 0,
      added: 0,
      deleted: 0,
      unchanged: 0,
      annotationConflicts: [],
      message: 'repovine.annots.json contains conflict markers; run merge_annotations first',
    };
  }
  const file = parseAnnotationFile(content, filePath);
  const next = serializeAnnotationFileInternal(file);
  const changed = content !== next;
  if (changed && !dryRun) writeAnnotationFileWhileLocked(filePath, next);
  return {
    status: dryRun ? 'dry-run' : changed ? 'normalized' : 'no-conflict',
    filePath,
    wroteFile: changed && !dryRun,
    autoMerged: 0,
    added: 0,
    deleted: 0,
    unchanged: Object.keys(file.annotations).length,
    annotationConflicts: [],
    message: changed ? 'repovine.annots.json normalized' : 'repovine.annots.json already canonical',
  };
}

export function mergeAnnotationsOnDisk(
  repoRoot: string,
  options: { dryRun?: boolean; annotationsFile?: string; fromIndex?: boolean } = {},
): AnnotationMergeReport {
  const filePath = annotationPath(repoRoot, options.annotationsFile);
  const backupDir = path.join(repoRoot, ARTIFACTS_DIR_NAME, 'annotation-backups');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return withAnnotationFileLockSync(filePath, () => {
      const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
      const markers = hasConflictMarkers(content);
      // The unmerged-index question is asked directly, not inferred from a successful stage read:
      // stages that cannot be read or attributed must not look like a merged index and fall
      // through to normalize, which is exactly the silent one-sided write this path prevents.
      const indexUnmerged = fs.existsSync(filePath) && isIndexUnmerged(filePath);
      const stages = markers || indexUnmerged ? readGitIndexMergeStages(filePath) : undefined;

      // No markers but an unmerged index: git resolved the file at file level (binary/-merge
      // attribute, modify/delete, rename) or a human already resolved it by hand. Normalizing
      // would silently keep whichever side is in the worktree and drop the other. Neither guess
      // is safe, so state the situation and let the caller pick.
      if (!markers && indexUnmerged && !options.fromIndex) {
        return {
          status: 'error',
          filePath,
          wroteFile: false,
          autoMerged: 0,
          added: 0,
          deleted: 0,
          unchanged: 0,
          annotationConflicts: [],
          indexUnmerged: true,
          message: 'repovine.annots.json has no conflict markers but its git index entry is still unmerged '
            + '(file-level conflict such as a binary/-merge attribute, modify/delete, or an already hand-resolved file). '
            + 'The worktree holds one side only. Run merge_annotations({ "fromIndex": true }) to merge the index stages '
            + '(the replaced worktree file is backed up first), or `git add` the file if the worktree copy is the intended resolution.',
        };
      }

      // fromIndex was requested but the stages are unreadable or span more than one path. Saying so
      // beats normalizing the one side the worktree happens to hold.
      if (!markers && indexUnmerged && !stages) {
        return {
          status: 'error',
          filePath,
          wroteFile: false,
          autoMerged: 0,
          added: 0,
          deleted: 0,
          unchanged: 0,
          annotationConflicts: [],
          indexUnmerged: true,
          message: 'repovine.annots.json has an unmerged git index entry whose stages could not be read '
            + '(unreadable stage blob, or the path resolves to more than one index entry). '
            + 'Resolve the conflict with git, then re-run merge_annotations.',
        };
      }

      if (!markers && !stages) {
        return normalizeAnnotationsFileWhileLocked(filePath, options.dryRun === true, content);
      }

      // Prefer the git index stages over worktree marker parsing: stage :1: is the real merge
      // base (delete-vs-modify becomes detectable) and conflict style (diff3/zdiff3) stops
      // mattering. Marker parsing remains the fallback outside an unmerged git state.
      let base: AnnotationFile;
      let ours: AnnotationFile;
      let theirs: AnnotationFile;
      let baseSource: 'git-index' | 'conflict-markers-diff3' | 'none';
      let baseWarning: string | undefined;
      if (stages) {
        const parsedBase = parseMergeBaseLenient(stages.base, 'git index stage :1:');
        base = parsedBase.file;
        baseWarning = parsedBase.warning;
        ours = parseAnnotationFile(stages.ours, 'git index ours (:2:)');
        theirs = parseAnnotationFile(stages.theirs, 'git index theirs (:3:)');
        baseSource = stages.base !== undefined && !parsedBase.degraded ? 'git-index' : 'none';
      } else {
        const sides = splitConflictMarkerSides(content);
        const parsedBase = parseMergeBaseLenient(sides.base, 'conflict marker base (diff3)');
        base = parsedBase.file;
        baseWarning = parsedBase.warning;
        ours = parseAnnotationFile(sides.ours, 'conflict marker ours');
        theirs = parseAnnotationFile(sides.theirs, 'conflict marker theirs');
        baseSource = sides.base !== undefined && !parsedBase.degraded ? 'conflict-markers-diff3' : 'none';
      }
      // Without a base, "deleted on one side" is indistinguishable from "added on the other", so
      // the merge resurrects deletions. That is a silent semantic downgrade unless it is stated.
      if (baseSource === 'none' && baseWarning === undefined) {
        baseWarning = 'merged without a merge base, so deletions on one side were treated as additions '
          + 'on the other and unchanged-vs-changed pairs may be reported as conflicts';
      }

      const merged = mergeAnnotationFiles(base, ours, theirs);

      // The git-index path recomputes the file from the pre-merge blobs, so any edit made to the
      // conflicted worktree file (a hand-resolved hunk) is not represented in the result. Snapshot
      // the bytes being replaced and name the backup in the report rather than dropping them. The
      // snapshot lands in the gitignored artifacts dir so `git add -A` mid-conflict cannot commit it.
      let replacedBackupPath: string | undefined;
      if (!options.dryRun && stages) {
        const backup = writeAnnotationBackup(filePath, Buffer.from(content, 'utf-8'), { dir: backupDir });
        if (backup.status === 'failed') {
          return {
            status: 'error',
            filePath,
            wroteFile: false,
            autoMerged: 0,
            added: 0,
            deleted: 0,
            unchanged: 0,
            annotationConflicts: [],
            message: `refusing to replace the conflicted repovine.annots.json: its backup could not be written (${backup.error})`,
          };
        }
        replacedBackupPath = backup.backupPath;
      }
      if (!options.dryRun) {
        writeAnnotationFileWhileLocked(filePath, serializeAnnotationFileInternal(merged.file));
      }
      const messageParts = [
        merged.annotationConflicts.length > 0
          ? 'repovine.annots.json merged with annotation conflicts requiring review'
          : 'repovine.annots.json merged cleanly',
        ...(baseSource === 'git-index' ? ['merged from git index stages :1:/:2:/:3:'] : []),
        ...(baseWarning ? [baseWarning] : []),
        ...(replacedBackupPath
          ? [`replaced conflicted worktree file backed up at ${path.basename(replacedBackupPath)}`]
          : []),
      ];
      return {
        status: options.dryRun ? 'dry-run' : 'merged',
        filePath,
        wroteFile: options.dryRun !== true,
        autoMerged: merged.autoMerged,
        added: merged.added,
        deleted: merged.deleted,
        unchanged: merged.unchanged,
        annotationConflicts: merged.annotationConflicts,
        baseSource,
        ...(merged.deletedNodeIds.length > 0 ? { deletedNodeIds: merged.deletedNodeIds } : {}),
        ...(baseWarning ? { baseWarning } : {}),
        ...(replacedBackupPath ? { replacedBackupPath } : {}),
        message: messageParts.join('; '),
      };
    });
  } catch (e) {
    return {
      status: 'error',
      filePath,
      wroteFile: false,
      autoMerged: 0,
      added: 0,
      deleted: 0,
      unchanged: 0,
      annotationConflicts: [],
      message: (e as Error).message,
    };
  }
}

/**
 * Build the shared annotation-health scan (one lightweight pass over the
 * annotatable surface). validate/compliance reuse a single scan per run instead
 * of repeated full getQueue(MAX) materialization.
 */
export function buildAnnotationHealthScan(input: {
  repoRoot: string;
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  annotations: AnnotationStore;
}): AnnotationHealthScan {
  const propagation = loadConfig(input.repoRoot).annotations.propagation;
  const entrypoints = getInterpreterEntrypoints(input.graph);
  return input.annotations.scanAnnotationHealth(input.graph, input.snapshot, { propagation, entrypoints });
}

/** Compute the advisory consumer-scope density signal over all stored annotations. */
export function computeConsumerScopeDensity(annotations: AnnotationStore): ConsumerScopeDensity {
  let consumerRisks = 0;
  let totalRisks = 0;
  let unmarkedConsumerRisks = 0;
  const nodesOverPerNodeCap: Array<{ nodeId: string; count: number }> = [];
  for (const [nodeId, ann] of Object.entries(annotations.getAll())) {
    const risks = normalizeRisks(ann.annotation.risks);
    if (risks.length === 0) continue;
    const consumer = risks.filter((r) => r.scope === 'consumer').length;
    totalRisks += risks.length;
    consumerRisks += consumer;
    if (consumer > CONSUMER_SCOPE_PER_NODE_WARN) nodesOverPerNodeCap.push({ nodeId, count: consumer });
    unmarkedConsumerRisks += consumerRiskMarkingHints(ann.annotation).length;
  }
  const ratio = totalRisks > 0 ? consumerRisks / totalRisks : 0;
  return {
    consumerRisks,
    totalRisks,
    ratio,
    overGlobalThreshold: totalRisks > 0 && ratio > CONSUMER_SCOPE_GLOBAL_RATIO_WARN,
    nodesOverPerNodeCap,
    unmarkedConsumerRisks,
  };
}

export function validateAnnotationHealth(input: {
  repoRoot: string;
  graph: RepositoryGraph;
  snapshot: RepositoryFactsSnapshot;
  annotations: AnnotationStore;
  limit?: number;
  /** Optional sub-agent scope — reports needsWorkInScope separately from repo-wide needsWork. */
  scope?: string | string[];
  /** Reuse a scan already built this run (compliance shares one across checks). */
  scan?: AnnotationHealthScan;
}): AnnotationValidationReport {
  const { repoRoot, graph, annotations } = input;
  const limit = input.limit ?? 20;
  const scopeHints = input.scope === undefined
    ? undefined
    : Array.isArray(input.scope) ? input.scope : [input.scope];
  const scan = input.scan ?? buildAnnotationHealthScan(input);
  const counts = {
    stale: scan.counts.stale,
    staleContent: scan.counts.staleContent,
    stalePropagation: scan.counts.stalePropagation,
    unannotated: scan.counts.unannotated,
  };
  const needsWork = scan.counts.needsWork;
  const scopedRows = scopeHints
    ? scan.rows.filter((row) => nodeInScopeHints(row.nodeId, scopeHints))
    : scan.rows;
  const needsWorkInScope = scopedRows.length;

  const orphaned = annotations.detectOrphaned(graph);
  // Read merge/conflict status from FRESH disk, not the store's cached snapshot. A conflict or corruption
  // an external writer (git merge) left after our last save is invisible to the cached snapshot, which
  // reflects the bytes we last wrote — finalizeWrite even re-stamps it parseOk:true.
  const mergeStatus = getAnnotationMergeStatus(repoRoot);
  let mergeReview = 0;
  // The offered call carries a concrete node: `write_annotation` requires `nodeId`, so an offer
  // without one is a call the caller cannot make.
  let mergeReviewNodeId: string | undefined;
  for (const [nodeId, ann] of Object.entries(annotations.getAll())) {
    if (listMergeReviewFields(ann.annotation).length > 0) {
      mergeReview++;
      mergeReviewNodeId ??= nodeId;
    }
  }
  const nextActions: NextCall[] = [];
  const lastSaveError = typeof annotations.lastSaveError === 'string' ? annotations.lastSaveError : null;
  if (lastSaveError) {
    nextActions.push(nextCall('merge_annotations', {}, `Annotation saves are failing (${lastSaveError}). The file may be conflicted, locked, or unreadable; resolve it (merge or restore), then re-save — pending writes are still held in memory.`));
  }
  // Read defensively like `lastSaveError` above: callers pass store-like objects, and this is runtime
  // state a partial one need not carry.
  const keeps = annotations.lastMergeKeeps;
  const mergeKeeps = keeps ? describeMergeKeeps(keeps) : undefined;
  if (mergeKeeps) nextActions.push({ reason: mergeKeeps });
  if (mergeStatus.file.hasConflictMarkers) {
    nextActions.push(nextCall('merge_annotations', {}, 'Resolve the conflict before continuing annotation work.'));
  }
  if (mergeReview > 0 && mergeReviewNodeId) {
    nextActions.push(nextCall('write_annotation', { nodeId: mergeReviewNodeId }, `${mergeReview} annotation(s) have merge-review markers (patterns merge-review:*); inspect assumptions and rewrite them, starting with this node.`));
  }
  if (mergeStatus.file.exists && !mergeStatus.file.parseOk && !mergeStatus.file.hasConflictMarkers) {
    nextActions.push({ reason: 'Fix repovine.annots.json parse error or restore it before annotation work.' });
  }
  if (orphaned.total > 0) {
    nextActions.push(nextCall('get_annotation_status', { view: 'orphans' }, 'Review orphaned annotations; refresh_context({ cleanupOrphans: true }) removes them afterwards.'));
  }
  if (counts.staleContent > 0 || counts.stalePropagation > 0) {
    nextActions.push(nextCall('get_annotation_status', { view: 'queue' }, 'Process the queue before trusting affected summaries.'));
  }
  const propagationStaleNodeId = scan.rows.find(row => row.staleKind === 'propagation')?.nodeId;
  if (counts.stalePropagation > 0 && propagationStaleNodeId) {
    nextActions.push(nextCall(
      'write_annotation',
      { nodeId: propagationStaleNodeId, refreshImportBaseline: true },
      'Clear propagation-stale items one node at a time, or rewrite integrationPoints/dataFlow when the upstream contract changed.',
    ));
  }
  if (counts.unannotated > 0) {
    nextActions.push(nextCall('get_annotation_status', { view: 'queue' }, 'New/unannotated nodes exist; continue annotation onboarding if coverage matters for this handoff.'));
  }
  const consumerScopeDensity = computeConsumerScopeDensity(annotations);
  if (consumerScopeDensity.overGlobalThreshold) {
    nextActions.push({ reason: `Advisory: ${consumerScopeDensity.consumerRisks}/${consumerScopeDensity.totalRisks} risks are scope:"consumer" (ratio ${consumerScopeDensity.ratio.toFixed(2)} > ${CONSUMER_SCOPE_GLOBAL_RATIO_WARN}) — consumer scope is the selective edge-flag exception; over-marking floods inspect_node investigate tags.` });
  }
  if (consumerScopeDensity.nodesOverPerNodeCap.length > 0) {
    nextActions.push({ reason: `Advisory: ${consumerScopeDensity.nodesOverPerNodeCap.length} node(s) mark more than ${CONSUMER_SCOPE_PER_NODE_WARN} consumer risks; consider keeping only the importer-critical ones consumer-scoped.` });
  }
  if (consumerScopeDensity.unmarkedConsumerRisks > 0) {
    nextActions.push({ reason: `Advisory: ${consumerScopeDensity.unmarkedConsumerRisks} consumer-scoped risk(s) read as bare facts — state the importer obligation (what the caller must verify locally).` });
  }
  const carrierLinkGaps = computeCarrierLinkGaps({
    graph,
    annotations: annotations.getAll(),
    suppressedTargetIds: readValidSuppressedTargets(repoRoot, annotations.getAll()),
    ...(scopeHints ? { scopeHints } : {}),
  });
  const riskScopeCandidates = computeRiskScopeCandidates({
    graph,
    snapshot: input.snapshot,
    annotations: annotations.getAll(),
    ...(scopeHints ? { scopeHints } : {}),
  });
  if (carrierLinkGaps.missingCarrierLinks > 0 || carrierLinkGaps.suppressedTargets > 0) {
    const suppressedClause = carrierLinkGaps.suppressedTargets > 0
      ? ` (${carrierLinkGaps.suppressedTargets} reviewed target(s) suppressed.)`
      : '';
    nextActions.push(nextCall('get_annotation_status', { view: 'carrier-gaps' }, `Advisory: ${carrierLinkGaps.missingCarrierLinks} candidate importer(s) sit 2 runtime-import-hops from consumer-scoped-risk nodes without naming them in integrationPoints — review for delegation; name the SSOT only where the importer delegates to it.${suppressedClause}`));
  }
  if (carrierLinkGaps.namedButUndeliverable > 0) {
    nextActions.push({ reason: `Advisory: ${carrierLinkGaps.namedButUndeliverable} integrationPoints reference(s) name graph nodes with no import path from the annotating module — investigatePointers cannot fire; keep mod: refs for implementer closure and verify wiring in source.` });
  }
  if (riskScopeCandidates.consumer > 0) {
    nextActions.push(nextCall('get_annotation_status', { view: 'risk-scope-candidates' }, `Advisory: ${riskScopeCandidates.consumer} plain/local risk(s) look like scope:"consumer" candidates; review before relying on investigate risk delivery.`));
  }
  if (riskScopeCandidates.boundary > 0) {
    nextActions.push(nextCall('get_annotation_status', { view: 'risk-scope-candidates' }, `Advisory: ${riskScopeCandidates.boundary} plain/local risk(s) look like scope:"boundary" candidates; review before relying on boundary delivery.`));
  }

  // The consistency axis, recomputed from `annotations × current graph`. It is the one axis that asks
  // whether a filled field contradicts a fact, so a verdict that ignored it called a note clean while
  // the write path was already refusing the same contradiction under harness.
  const inconsistent = computeInconsistentModuleAnnotations(
    annotations,
    new Map((input.snapshot?.modules ?? []).map(mod => [mod.id, mod])),
  );
  const inconsistentInScope = scopeHints
    ? inconsistent.filter(row => nodeInScopeHints(row.nodeId, scopeHints))
    : inconsistent;
  if (inconsistentInScope.length > 0) {
    nextActions.push(nextCall(
      'get_annotation_status',
      { view: 'coverage' },
      `${inconsistentInScope.length} note(s) name something the graph does not have; the contradicting names are in anomalies.inconsistent.`,
    ));
  }

  const clean = !mergeStatus.file.hasConflictMarkers
    && (!mergeStatus.file.exists || mergeStatus.file.parseOk)
    && !lastSaveError
    && orphaned.total === 0
    && counts.staleContent === 0
    && counts.stalePropagation === 0
    && mergeReview === 0;
  const scopedClean = scopeHints
    ? scopedRows.filter((row) =>
      row.status === 'unannotated'
      || isContentStaleItem(row)
      || isPropagationStaleItem(row),
    ).length === 0
    : clean;

  return {
    status: (scopeHints ? scopedClean : clean) ? 'clean' : 'needs-review',
    mergeStatus,
    counts: {
      annotations: Object.keys(annotations.getAll()).length,
      orphaned: orphaned.total,
      stale: counts.stale,
      staleContent: counts.staleContent,
      stalePropagation: counts.stalePropagation,
      unannotated: counts.unannotated,
      mergeReview,
      inconsistent: inconsistent.length,
    },
    consumerScopeDensity,
    carrierLinkGaps,
    riskScopeCandidates,
    needsWork,
    ...(scopeHints
      ? {
        scope: scopeHints,
        needsWorkInScope,
        scopedClean,
      }
      : {}),
    ...(orphaned.total > 0 ? { orphanedByType: orphaned.byType } : {}),
    queueSample: scopeHints
      ? scan.sample(limit, (row) => nodeInScopeHints(row.nodeId, scopeHints))
      : scan.sample(limit),
    nextActions,
  };
}
