import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { jest } from '@jest/globals';
import {
  ANNOTATIONS_RELATIVE_PATH,
  CONSUMER_SCOPE_PER_NODE_WARN,
  getAnnotationMergeStatus,
  mergeAnnotationsOnDisk,
  normalizeAnnotationsFile,
  mergeAnnotationFiles,
  serializeAnnotationFile,
  validateAnnotationHealth,
} from '../../../src/annotations/maintenance.js';
import { AnnotationStore } from '../../../src/annotations/store.js';
import { carrierTargetRiskHash, writeCarrierReviewFile } from '../../../src/annotations/carrier-review.js';
import { listMergeReviewFields } from '../../../src/annotations/merge-review.js';
import { writeAnnotationBackup, MAX_ANNOTATION_BACKUPS } from '../../../src/annotations/backup.js';
import { createEmptyGraph, addEdge, addNode } from '../../../src/graph/index.js';
import type { StoredAnnotation, RepositoryFactsSnapshot, ModuleInfo } from '../../../src/types.js';

function makeMod(id: string): ModuleInfo {
  const rel = id.replace(/^mod:/, '');
  return {
    id,
    packageName: 'test',
    filePath: `/repo/${rel}.ts`,
    relativeFilePath: `${rel}.ts`,
    contentHash: `${id}:hash`,
    imports: [],
    exports: [],
  };
}

function makeValidateGraph(moduleIds: string[]) {
  const graph = createEmptyGraph();
  for (const id of moduleIds) {
    addNode(graph, {
      id,
      type: 'module',
      label: id.replace(/^mod:/, ''),
      description: '',
      data: { relativeFilePath: `${id.replace(/^mod:/, '')}.ts` },
    });
  }
  return graph;
}

function annotation(
  nodeId: string,
  summary: string,
  extra: Partial<StoredAnnotation['annotation']> = {},
  updatedAt = '2026-01-01T00:00:00.000Z',
): StoredAnnotation {
  return {
    nodeId,
    nodeType: 'module',
    contentHash: `${nodeId}:hash`,
    pass: 1,
    updatedAt,
    annotation: { summary, ...extra },
    schemaVersion: 1,
  };
}

function annotationFile(annotations: Record<string, StoredAnnotation>) {
  return { version: 1, annotations };
}

// Neutralize the developer's ambient git configuration so global/system hooks,
// commit templates, or gpgsign cannot perturb the temp-repo merge tests.
const HERMETIC_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test User',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test User',
  GIT_COMMITTER_EMAIL: 'test@example.com',
} as NodeJS.ProcessEnv;

function git(repoRoot: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-C', repoRoot, '-c', 'commit.gpgsign=false', '-c', 'init.templateDir=', ...args],
    {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: HERMETIC_GIT_ENV,
    },
  );
}

function writeAnnotations(repoRoot: string, annotations: Record<string, StoredAnnotation>): void {
  const filePath = path.join(repoRoot, ANNOTATIONS_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serializeAnnotationFile(annotationFile(annotations)), 'utf-8');
}

/**
 * Drive a real `git merge` to conflict on the annotations file. Returns with the repo left in the
 * unmerged state, so index stages :1:/:2:/:3: are readable.
 */
function setupConflict(
  repoRoot: string,
  sides: {
    base?: Record<string, StoredAnnotation>;
    ours?: Record<string, StoredAnnotation>;
    theirs?: Record<string, StoredAnnotation>;
    conflictStyle?: 'merge' | 'diff3' | 'zdiff3';
    /** Runs after both branches are committed, before `git merge` creates the conflict. */
    beforeMerge?: () => void;
  } = {},
): void {
  const base = sides.base ?? { 'mod:a': annotation('mod:a', 'Base summary') };
  const ours = sides.ours ?? { 'mod:a': annotation('mod:a', 'Ours summary', {}, '2026-01-03T00:00:00.000Z') };
  const theirs = sides.theirs ?? { 'mod:a': annotation('mod:a', 'Theirs summary', {}, '2026-01-02T00:00:00.000Z') };

  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['checkout', '-b', 'main']);
  if (sides.conflictStyle) git(repoRoot, ['config', 'merge.conflictStyle', sides.conflictStyle]);

  writeAnnotations(repoRoot, base);
  git(repoRoot, ['add', ANNOTATIONS_RELATIVE_PATH]);
  git(repoRoot, ['commit', '-m', 'base']);

  git(repoRoot, ['checkout', '-b', 'feature']);
  writeAnnotations(repoRoot, theirs);
  git(repoRoot, ['add', ANNOTATIONS_RELATIVE_PATH]);
  git(repoRoot, ['commit', '-m', 'feature']);

  git(repoRoot, ['checkout', 'main']);
  writeAnnotations(repoRoot, ours);
  git(repoRoot, ['add', ANNOTATIONS_RELATIVE_PATH]);
  git(repoRoot, ['commit', '-m', 'main']);

  sides.beforeMerge?.();

  expect(() => git(repoRoot, ['merge', 'feature'])).toThrow();
}

/**
 * Real conflicted-file text as git writes it — common context outside the hunks included — moved
 * to a directory with no git index, which is what the marker-parsing fallback actually sees.
 */
function conflictTextOutsideGit(
  sides: Parameters<typeof setupConflict>[1],
  targetDir: string,
): string {
  const gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-conflict-src-'));
  try {
    setupConflict(gitDir, sides);
    const text = fs.readFileSync(path.join(gitDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8');
    const target = path.join(targetDir, ANNOTATIONS_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf-8');
    return text;
  } finally {
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
}

describe('annotation maintenance', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-maint-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serializes annotations as compact one-record-per-line JSON', () => {
    const text = serializeAnnotationFile(annotationFile({
      'mod:a': annotation('mod:a', 'A summary'),
      'resource:aws-lambda:Worker': {
        nodeId: 'resource:aws-lambda:Worker',
        nodeType: 'runtime-resource',
        contentHash: 'worker-hash',
        pass: 2,
        updatedAt: '2026-01-01T00:00:00.000Z',
        annotation: { summary: 'Worker summary' },
        schemaVersion: 1,
      },
    }));

    expect(text).toContain('"mod:a": {"contentHash":"mod:a:hash"');
    expect(text).toContain('"resource:aws-lambda:Worker": {"contentHash":"worker-hash","pass":2');
    const parsed = JSON.parse(text) as { version: number; annotations: Record<string, Record<string, unknown>> };
    expect(parsed.version).toBe(1);
    expect(parsed.annotations['mod:a'].nodeId).toBeUndefined();
    expect(parsed.annotations['mod:a'].nodeType).toBeUndefined();
    expect(parsed.annotations['mod:a'].pass).toBeUndefined();
    expect(parsed.annotations['mod:a'].schemaVersion).toBeUndefined();
  });

  it('merges distinct nodes and additive annotation fields while reporting scalar conflicts', () => {
    const base = annotationFile({
      'mod:a': annotation('mod:a', 'Base summary', { keyExports: { a: 'base export' } }),
    });
    const ours = annotationFile({
      'mod:a': annotation('mod:a', 'Ours summary', { assumptions: ['ours assumption'] }, '2026-01-03T00:00:00.000Z'),
      'mod:ours-only': annotation('mod:ours-only', 'Ours only summary'),
    });
    const theirs = annotationFile({
      'mod:a': annotation('mod:a', 'Theirs summary', { risks: ['theirs risk'] }, '2026-01-02T00:00:00.000Z'),
      'mod:theirs-only': annotation('mod:theirs-only', 'Theirs only summary'),
    });

    const result = mergeAnnotationFiles(base, ours, theirs);
    const merged = result.file.annotations['mod:a'];

    expect(result.file.annotations['mod:ours-only']).toBeDefined();
    expect(result.file.annotations['mod:theirs-only']).toBeDefined();
    expect(merged.annotation.summary).toBe('Ours summary');
    expect(merged.annotation.assumptions).toEqual(expect.arrayContaining([
      'ours assumption',
      '[merge-review:summary:ours] Ours summary',
      '[merge-review:summary:theirs] Theirs summary',
    ]));
    expect(merged.annotation.risks).toEqual(['theirs risk']);
    expect(merged.annotation.patterns).toEqual(['merge-review:summary']);
    expect(result.annotationConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'mod:a', field: 'annotation.summary', chosen: 'ours' }),
    ]));
  });

  it('resolves conflict markers in the worktree annotations file', () => {
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['checkout', '-b', 'main']);
    git(tmpDir, ['config', 'user.email', 'test@example.com']);
    git(tmpDir, ['config', 'user.name', 'Test User']);

    writeAnnotations(tmpDir, {
      'mod:a': annotation('mod:a', 'Base summary'),
    });
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    git(tmpDir, ['commit', '-m', 'base']);

    git(tmpDir, ['checkout', '-b', 'feature']);
    writeAnnotations(tmpDir, {
      'mod:a': annotation('mod:a', 'Theirs summary', { risks: ['theirs risk'] }, '2026-01-02T00:00:00.000Z'),
    });
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    git(tmpDir, ['commit', '-m', 'feature annotations']);

    git(tmpDir, ['checkout', 'main']);
    writeAnnotations(tmpDir, {
      'mod:a': annotation('mod:a', 'Ours summary', { assumptions: ['ours assumption'] }, '2026-01-03T00:00:00.000Z'),
    });
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    git(tmpDir, ['commit', '-m', 'main annotations']);

    expect(() => git(tmpDir, ['merge', 'feature'])).toThrow();
    expect(getAnnotationMergeStatus(tmpDir).file.hasConflictMarkers).toBe(true);

    const merge = mergeAnnotationsOnDisk(tmpDir);
    expect(merge.status).toBe('merged');
    expect(merge.baseSource).toBe('git-index');
    expect(merge.annotationConflicts).toHaveLength(1);
    expect(getAnnotationMergeStatus(tmpDir).file.hasConflictMarkers).toBe(false);

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8'),
    );
    expect(parsed.annotations['mod:a'].annotation.summary).toBe('Ours summary');
    expect(parsed.annotations['mod:a'].annotation.assumptions).toEqual(expect.arrayContaining([
      'ours assumption',
      '[merge-review:summary:ours] Ours summary',
      '[merge-review:summary:theirs] Theirs summary',
    ]));
    expect(parsed.annotations['mod:a'].annotation.risks).toEqual(['theirs risk']);
    expect(parsed.annotations['mod:a'].annotation.patterns).toEqual(['merge-review:summary']);
  });

  it('resolves diff3-style conflicts through git index stages', () => {
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['checkout', '-b', 'main']);
    git(tmpDir, ['config', 'merge.conflictStyle', 'diff3']);

    writeAnnotations(tmpDir, { 'mod:a': annotation('mod:a', 'Base summary') });
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    git(tmpDir, ['commit', '-m', 'base']);

    git(tmpDir, ['checkout', '-b', 'feature']);
    writeAnnotations(tmpDir, {
      'mod:a': annotation('mod:a', 'Theirs summary', {}, '2026-01-02T00:00:00.000Z'),
    });
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    git(tmpDir, ['commit', '-m', 'feature annotations']);

    git(tmpDir, ['checkout', 'main']);
    writeAnnotations(tmpDir, {
      'mod:a': annotation('mod:a', 'Ours summary', {}, '2026-01-03T00:00:00.000Z'),
    });
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    git(tmpDir, ['commit', '-m', 'main annotations']);

    expect(() => git(tmpDir, ['merge', 'feature'])).toThrow();
    const conflicted = fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8');
    expect(conflicted).toContain('|||||||');

    const merge = mergeAnnotationsOnDisk(tmpDir);
    expect(merge.status).toBe('merged');
    expect(merge.baseSource).toBe('git-index');
    expect(getAnnotationMergeStatus(tmpDir).file.hasConflictMarkers).toBe(false);

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8'),
    );
    expect(parsed.annotations['mod:a'].annotation.summary).toBe('Ours summary');
  });

  it('detects deletions against the real merge base instead of resurrecting them silently', () => {
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['checkout', '-b', 'main']);

    writeAnnotations(tmpDir, {
      'mod:a': annotation('mod:a', 'A base'),
      'mod:b': annotation('mod:b', 'B shared'),
      'mod:c': annotation('mod:c', 'C base'),
    });
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    git(tmpDir, ['commit', '-m', 'base']);

    git(tmpDir, ['checkout', '-b', 'feature']);
    writeAnnotations(tmpDir, {
      'mod:a': annotation('mod:a', 'A theirs', {}, '2026-01-02T00:00:00.000Z'),
      'mod:b': annotation('mod:b', 'B shared'),
      'mod:c': annotation('mod:c', 'C theirs', {}, '2026-01-02T00:00:00.000Z'),
    });
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    git(tmpDir, ['commit', '-m', 'feature: edit a and c']);

    git(tmpDir, ['checkout', 'main']);
    writeAnnotations(tmpDir, {
      'mod:a': annotation('mod:a', 'A ours', {}, '2026-01-03T00:00:00.000Z'),
    });
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    git(tmpDir, ['commit', '-m', 'main: edit a, delete b and c']);

    expect(() => git(tmpDir, ['merge', 'feature'])).toThrow();

    const merge = mergeAnnotationsOnDisk(tmpDir);
    expect(merge.status).toBe('merged');
    expect(merge.baseSource).toBe('git-index');

    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8'),
    );
    // Ours deleted mod:b, theirs kept it unchanged: the deletion wins and stays silent.
    expect(parsed.annotations['mod:b']).toBeUndefined();
    expect(merge.annotationConflicts.filter(c => c.nodeId === 'mod:b')).toHaveLength(0);
    // Ours deleted mod:c while theirs changed it: theirs is kept and the conflict is surfaced.
    expect(parsed.annotations['mod:c'].annotation.summary).toBe('C theirs');
    expect(merge.annotationConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'mod:c',
        field: '*',
        chosen: 'theirs',
        reason: 'ours deleted annotation while theirs changed it',
      }),
    ]));
    // Both edited mod:a: scalar merge-review conflict as before.
    expect(parsed.annotations['mod:a'].annotation.summary).toBe('A ours');
    expect(merge.annotationConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'mod:a', field: 'annotation.summary' }),
    ]));
  });

  it('refuses to guess when the index is unmerged but the file has no conflict markers', () => {
    // A `-merge` attribute makes git resolve at file level: all three stages stay in the index and
    // the worktree gets ours verbatim, so normalizing would silently drop theirs.
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['checkout', '-b', 'main']);
    fs.writeFileSync(path.join(tmpDir, '.gitattributes'), `${ANNOTATIONS_RELATIVE_PATH} -merge\n`, 'utf-8');
    writeAnnotations(tmpDir, { 'mod:base': annotation('mod:base', 'Base') });
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'base']);

    git(tmpDir, ['checkout', '-b', 'feature']);
    writeAnnotations(tmpDir, {
      'mod:base': annotation('mod:base', 'Base'),
      'mod:theirs': annotation('mod:theirs', 'Theirs only', {}, '2026-01-02T00:00:00.000Z'),
    });
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'feature']);

    git(tmpDir, ['checkout', 'main']);
    writeAnnotations(tmpDir, {
      'mod:base': annotation('mod:base', 'Base'),
      'mod:ours': annotation('mod:ours', 'Ours only', {}, '2026-01-03T00:00:00.000Z'),
    });
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'main']);

    expect(() => git(tmpDir, ['merge', 'feature'])).toThrow();
    expect(fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8')).not.toContain('<<<<<<<');

    const refused = mergeAnnotationsOnDisk(tmpDir);
    expect(refused.status).toBe('error');
    expect(refused.indexUnmerged).toBe(true);
    expect(refused.wroteFile).toBe(false);
    expect(refused.message).toContain('fromIndex');
    expect(getAnnotationMergeStatus(tmpDir).indexUnmerged).toBe(true);
    expect(getAnnotationMergeStatus(tmpDir).nextActions.join(' ')).toContain('fromIndex');

    const merged = mergeAnnotationsOnDisk(tmpDir, { fromIndex: true });
    expect(merged.status).toBe('merged');
    expect(merged.baseSource).toBe('git-index');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8'));
    // Both sides survive; the file-level resolution had discarded theirs entirely.
    expect(Object.keys(parsed.annotations).sort()).toEqual(['mod:base', 'mod:ours', 'mod:theirs']);
  });

  it('refuses a marker-free unmerged index whose stages cannot be read', () => {
    // Same file-level conflict, but the stage blob is gone: merge must not fall through to
    // normalize, which would keep whichever side the worktree holds and drop the other.
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['checkout', '-b', 'main']);
    fs.writeFileSync(path.join(tmpDir, '.gitattributes'), `${ANNOTATIONS_RELATIVE_PATH} -merge\n`, 'utf-8');
    writeAnnotations(tmpDir, { 'mod:base': annotation('mod:base', 'Base') });
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'base']);

    git(tmpDir, ['checkout', '-b', 'feature']);
    writeAnnotations(tmpDir, { 'mod:base': annotation('mod:base', 'Base'), 'mod:theirs': annotation('mod:theirs', 'Theirs', {}, '2026-01-02T00:00:00.000Z') });
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'feature']);

    git(tmpDir, ['checkout', 'main']);
    writeAnnotations(tmpDir, { 'mod:base': annotation('mod:base', 'Base'), 'mod:ours': annotation('mod:ours', 'Ours', {}, '2026-01-03T00:00:00.000Z') });
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'main']);

    expect(() => git(tmpDir, ['merge', 'feature'])).toThrow();
    const stageLine = git(tmpDir, ['ls-files', '-u', '--', ANNOTATIONS_RELATIVE_PATH])
      .split('\n')
      .find(l => l.split('\t')[0].endsWith(' 3')) as string;
    const sha = stageLine.split('\t')[0].split(' ')[1];
    fs.rmSync(path.join(tmpDir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)), { force: true });

    const before = fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8');
    const result = mergeAnnotationsOnDisk(tmpDir, { fromIndex: true });

    expect(result.status).toBe('error');
    expect(result.indexUnmerged).toBe(true);
    expect(result.wroteFile).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8')).toBe(before);
  });

  it('keeps normalizing a marker-free file when the index is clean', () => {
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['checkout', '-b', 'main']);
    const filePath = path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH);
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      annotations: { 'mod:a': { contentHash: 'mod:a:hash', updatedAt: '2026-01-01T00:00:00.000Z', annotation: { summary: 'A' } } },
    }, null, 2), 'utf-8');
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'base']);

    const result = mergeAnnotationsOnDisk(tmpDir);

    expect(result.status).toBe('normalized');
    expect(result.indexUnmerged).toBeUndefined();
    expect(getAnnotationMergeStatus(tmpDir).indexUnmerged).toBeUndefined();
  });

  it('warns whenever the merge ran without a base', () => {
    setupConflict(tmpDir);
    const conflicted = fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8');
    // Staging clears the unmerged index, so the merge falls back to marker parsing with no base.
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    fs.writeFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), conflicted, 'utf-8');

    const result = mergeAnnotationsOnDisk(tmpDir);

    expect(result.baseSource).toBe('none');
    expect(result.baseWarning).toContain('deletions on one side were treated as additions');
    expect(result.message).toContain('deletions on one side were treated as additions');
  });

  it('reads stages from the repository holding the file, ignoring an ambient GIT_DIR', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-other-repo-'));
    try {
      setupConflict(tmpDir, {
        base: { 'mod:mine': annotation('mod:mine', 'Mine base') },
        ours: { 'mod:mine': annotation('mod:mine', 'Mine ours', {}, '2026-01-03T00:00:00.000Z') },
        theirs: { 'mod:mine': annotation('mod:mine', 'Mine theirs', {}, '2026-01-02T00:00:00.000Z') },
      });
      setupConflict(other, {
        base: { 'mod:foreign': annotation('mod:foreign', 'Foreign base') },
        ours: { 'mod:foreign': annotation('mod:foreign', 'Foreign ours', {}, '2026-01-03T00:00:00.000Z') },
        theirs: { 'mod:foreign': annotation('mod:foreign', 'Foreign theirs', {}, '2026-01-02T00:00:00.000Z') },
      });

      const previous = process.env.GIT_DIR;
      process.env.GIT_DIR = path.join(other, '.git');
      let result;
      try {
        result = mergeAnnotationsOnDisk(tmpDir);
      } finally {
        if (previous === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = previous;
      }

      expect(result.status).toBe('merged');
      expect(result.baseSource).toBe('git-index');
      const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8'));
      expect(Object.keys(parsed.annotations)).toEqual(['mod:mine']);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('backs up the conflicted worktree bytes an index-stage merge replaces, outside the commit', () => {
    setupConflict(tmpDir);
    const conflicted = fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8');

    const merge = mergeAnnotationsOnDisk(tmpDir);

    expect(merge.baseSource).toBe('git-index');
    expect(merge.replacedBackupPath).toBeDefined();
    expect(merge.message).toContain('backed up at');
    expect(fs.readFileSync(merge.replacedBackupPath as string, 'utf-8')).toBe(conflicted);
    // The snapshot lives in the artifacts dir repovine's managed .gitignore block already covers, so
    // `git add -A` mid-conflict cannot stage a file full of conflict markers.
    expect(merge.replacedBackupPath as string).toContain(`${path.sep}.repovine${path.sep}`);
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.repovine/\n', 'utf-8');
    git(tmpDir, ['add', '-A']);
    expect(git(tmpDir, ['diff', '--cached', '--name-only'])).not.toContain('annotations.backup.');
  });

  it('still discloses the replaced worktree file when its backup deduplicates', () => {
    setupConflict(tmpDir);
    const conflicted = fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8');
    // Pre-seed a backup holding exactly these bytes, as a failed store load does.
    const backupDir = path.join(tmpDir, '.repovine', 'annotation-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const seeded = path.join(backupDir, 'annotations.backup.2026-01-01T00-00-00-000Z.json');
    fs.writeFileSync(seeded, conflicted, 'utf-8');

    const merge = mergeAnnotationsOnDisk(tmpDir);

    expect(merge.replacedBackupPath).toBe(seeded);
    expect(merge.message).toContain('backed up at');
    expect(fs.readdirSync(backupDir)).toHaveLength(1);
  });

  it('keeps merging when the merge base predates the current annotation schema', () => {
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['checkout', '-b', 'main']);

    // `sideEffects: []` is rejected by the current schema; historical commits still carry such
    // entries because the store round-trips quarantined records back to disk.
    const filePath = path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH);
    const legacyEntry = {
      contentHash: 'mod:legacy:hash',
      updatedAt: '2026-01-01T00:00:00.000Z',
      annotation: { summary: 'Legacy entry', sideEffects: [] },
      schemaVersion: 2,
    };
    fs.writeFileSync(filePath, JSON.stringify({
      version: 1,
      annotations: { 'mod:legacy': legacyEntry, 'mod:a': { contentHash: 'mod:a:hash', updatedAt: '2026-01-01T00:00:00.000Z', annotation: { summary: 'A base' } } },
    }, null, 2), 'utf-8');
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    git(tmpDir, ['commit', '-m', 'base with legacy entry']);

    git(tmpDir, ['checkout', '-b', 'feature']);
    writeAnnotations(tmpDir, { 'mod:a': annotation('mod:a', 'A theirs', {}, '2026-01-02T00:00:00.000Z') });
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    git(tmpDir, ['commit', '-m', 'feature']);

    git(tmpDir, ['checkout', 'main']);
    writeAnnotations(tmpDir, { 'mod:a': annotation('mod:a', 'A ours', {}, '2026-01-03T00:00:00.000Z') });
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    git(tmpDir, ['commit', '-m', 'main']);

    expect(() => git(tmpDir, ['merge', 'feature'])).toThrow();

    const merge = mergeAnnotationsOnDisk(tmpDir);

    expect(merge.status).toBe('merged');
    expect(merge.baseSource).toBe('git-index');
    expect(merge.baseWarning).toContain('invalid under the current schema');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.annotations['mod:a'].annotation.summary).toBe('A ours');
  });

  it('reads index stages of the configured path only, never a glob-matched sibling', () => {
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['checkout', '-b', 'main']);

    // `m[s]` is a valid directory name and a git pathspec character class matching `ms`.
    const bracketFile = 'm[s]/repovine.annots.json';
    const siblingFile = 'ms/repovine.annots.json';
    const writeBoth = (bracketSummary: string, siblingSummary: string, updatedAt: string) => {
      for (const [rel, summary, nodeId] of [
        [bracketFile, bracketSummary, 'mod:bracket'],
        [siblingFile, siblingSummary, 'mod:sibling'],
      ] as const) {
        const target = path.join(tmpDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, serializeAnnotationFile(annotationFile({
          [nodeId]: annotation(nodeId, summary, {}, updatedAt),
        })), 'utf-8');
      }
    };

    writeBoth('bracket base', 'sibling base', '2026-01-01T00:00:00.000Z');
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'base']);

    git(tmpDir, ['checkout', '-b', 'feature']);
    writeBoth('bracket theirs', 'sibling theirs', '2026-01-02T00:00:00.000Z');
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'feature']);

    git(tmpDir, ['checkout', 'main']);
    writeBoth('bracket ours', 'sibling ours', '2026-01-03T00:00:00.000Z');
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'main']);

    expect(() => git(tmpDir, ['merge', 'feature'])).toThrow();

    const merge = mergeAnnotationsOnDisk(tmpDir, { annotationsFile: bracketFile });

    expect(merge.status).toBe('merged');
    // Pin the index path: without :(literal) the pathspec also matches the sibling, the single-path
    // check rejects the mixed listing, and the merge silently degrades to marker parsing.
    expect(merge.baseSource).toBe('git-index');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, bracketFile), 'utf-8'));
    expect(Object.keys(parsed.annotations)).toEqual(['mod:bracket']);
    expect(parsed.annotations['mod:bracket'].annotation.summary).toBe('bracket ours');
  });

  it('falls back instead of half-reading stages when a stage blob is unreadable', () => {
    setupConflict(tmpDir, {
      base: { 'mod:a': annotation('mod:a', 'A base'), 'mod:keep': annotation('mod:keep', 'Keep') },
      ours: { 'mod:a': annotation('mod:a', 'A ours', {}, '2026-01-03T00:00:00.000Z'), 'mod:keep': annotation('mod:keep', 'Keep') },
      theirs: { 'mod:a': annotation('mod:a', 'A theirs', {}, '2026-01-02T00:00:00.000Z'), 'mod:keep': annotation('mod:keep', 'Keep') },
    });
    // Drop stage :3:'s object, as a partial clone or a damaged object store would.
    const stageLine = git(tmpDir, ['ls-files', '-u', '--', ANNOTATIONS_RELATIVE_PATH])
      .split('\n')
      .find(l => l.split('\t')[0].endsWith(' 3')) as string;
    const sha = stageLine.split('\t')[0].split(' ')[1];
    fs.rmSync(path.join(tmpDir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)), { force: true });

    const result = mergeAnnotationsOnDisk(tmpDir);

    // An unreadable stage must not read as "that side deleted everything".
    expect(result.baseSource).toBe('none');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8'));
    expect(Object.keys(parsed.annotations)).toContain('mod:keep');
    expect(result.deleted).toBe(0);
  });

  it('reads index stages for a file larger than the default subprocess buffer', () => {
    const bulk: Record<string, StoredAnnotation> = {};
    for (let i = 0; i < 4000; i++) {
      bulk[`mod:bulk${i}`] = annotation(`mod:bulk${i}`, `Bulk ${i} ${'x'.repeat(200)}`);
    }
    setupConflict(tmpDir, {
      base: { ...bulk, 'mod:a': annotation('mod:a', 'A base') },
      ours: { ...bulk, 'mod:a': annotation('mod:a', 'A ours', {}, '2026-01-03T00:00:00.000Z') },
      theirs: { ...bulk, 'mod:a': annotation('mod:a', 'A theirs', {}, '2026-01-02T00:00:00.000Z') },
    });
    expect(fs.statSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH)).size).toBeGreaterThan(1024 * 1024);

    const result = mergeAnnotationsOnDisk(tmpDir);

    expect(result.baseSource).toBe('git-index');
  });

  it('reports no base for an add/add conflict, where the index has no stage :1:', () => {
    git(tmpDir, ['init', '-q']);
    git(tmpDir, ['checkout', '-b', 'main']);
    fs.writeFileSync(path.join(tmpDir, 'seed.txt'), 'seed\n', 'utf-8');
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'seed']);

    git(tmpDir, ['checkout', '-b', 'feature']);
    writeAnnotations(tmpDir, { 'mod:theirs': annotation('mod:theirs', 'Theirs only', {}, '2026-01-02T00:00:00.000Z') });
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'feature adds annotations']);

    git(tmpDir, ['checkout', 'main']);
    writeAnnotations(tmpDir, { 'mod:ours': annotation('mod:ours', 'Ours only', {}, '2026-01-03T00:00:00.000Z') });
    git(tmpDir, ['add', '-A']);
    git(tmpDir, ['commit', '-m', 'main adds annotations']);

    expect(() => git(tmpDir, ['merge', 'feature'])).toThrow();

    const result = mergeAnnotationsOnDisk(tmpDir);

    // Both sides created the file: there is no base, and the report must not claim one.
    expect(result.status).toBe('merged');
    expect(result.baseSource).toBe('none');
    expect(result.baseWarning).toContain('without a merge base');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8'));
    expect(Object.keys(parsed.annotations).sort()).toEqual(['mod:ours', 'mod:theirs']);
  });

  it('merges markers left in a git repo whose index is already clean', () => {
    // Staging the conflicted file clears the unmerged index while markers stay in the worktree.
    // The stage reader must report "nothing to read" rather than an empty three-way input.
    setupConflict(tmpDir, {
      base: { 'mod:a': annotation('mod:a', 'A base'), 'mod:keep': annotation('mod:keep', 'Keep') },
      ours: { 'mod:a': annotation('mod:a', 'A ours', {}, '2026-01-03T00:00:00.000Z'), 'mod:keep': annotation('mod:keep', 'Keep') },
      theirs: { 'mod:a': annotation('mod:a', 'A theirs', {}, '2026-01-02T00:00:00.000Z'), 'mod:keep': annotation('mod:keep', 'Keep') },
    });
    const conflicted = fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8');
    git(tmpDir, ['add', ANNOTATIONS_RELATIVE_PATH]);
    fs.writeFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), conflicted, 'utf-8');

    const result = mergeAnnotationsOnDisk(tmpDir);

    expect(result.status).toBe('merged');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8'));
    expect(Object.keys(parsed.annotations).sort()).toEqual(['mod:a', 'mod:keep']);
  });

  it('does not create repovine.annots.json when merge is requested without an existing file', () => {
    const result = mergeAnnotationsOnDisk(tmpDir);

    expect(result.status).toBe('no-conflict');
    expect(result.wroteFile).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH))).toBe(false);
  });
});

describe('three-way decision ladder', () => {
  const file = (annotations: Record<string, StoredAnnotation>) => annotationFile(annotations);

  it('takes the side that changed relative to the base, in both directions', () => {
    const base = file({ 'mod:a': annotation('mod:a', 'Base'), 'mod:b': annotation('mod:b', 'Base') });
    const ours = file({
      'mod:a': annotation('mod:a', 'Base'),
      'mod:b': annotation('mod:b', 'Ours changed', {}, '2026-01-02T00:00:00.000Z'),
    });
    const theirs = file({
      'mod:a': annotation('mod:a', 'Theirs changed', {}, '2026-01-02T00:00:00.000Z'),
      'mod:b': annotation('mod:b', 'Base'),
    });

    const result = mergeAnnotationFiles(base, ours, theirs);

    // ours matched base for mod:a, so their edit lands; the mirror holds for mod:b.
    expect(result.file.annotations['mod:a'].annotation.summary).toBe('Theirs changed');
    expect(result.file.annotations['mod:b'].annotation.summary).toBe('Ours changed');
    expect(result.annotationConflicts).toHaveLength(0);
  });

  it('reports the conflict when theirs deleted a record ours changed', () => {
    const base = file({ 'mod:a': annotation('mod:a', 'Base') });
    const ours = file({ 'mod:a': annotation('mod:a', 'Ours changed', {}, '2026-01-02T00:00:00.000Z') });
    const theirs = file({});

    const result = mergeAnnotationFiles(base, ours, theirs);

    expect(result.file.annotations['mod:a'].annotation.summary).toBe('Ours changed');
    expect(result.annotationConflicts).toEqual([
      expect.objectContaining({
        nodeId: 'mod:a',
        field: '*',
        chosen: 'ours',
        reason: 'theirs deleted annotation while ours changed it',
      }),
    ]);
  });

  it('counts a record both sides deleted', () => {
    const base = file({ 'mod:a': annotation('mod:a', 'Base'), 'mod:gone': annotation('mod:gone', 'Gone') });
    const ours = file({ 'mod:a': annotation('mod:a', 'Base') });
    const theirs = file({ 'mod:a': annotation('mod:a', 'Base') });

    const result = mergeAnnotationFiles(base, ours, theirs);

    expect(result.file.annotations['mod:gone']).toBeUndefined();
    expect(result.deleted).toBe(1);
    expect(result.deletedNodeIds).toEqual(['mod:gone']);
  });

  it('keeps the side that changed a field relative to the base', () => {
    const base = file({ 'mod:a': annotation('mod:a', 'Same', { dataFlow: 'base flow' }) });
    const ours = file({ 'mod:a': annotation('mod:a', 'Same', { dataFlow: 'ours flow' }, '2026-01-02T00:00:00.000Z') });
    const theirs = file({ 'mod:a': annotation('mod:a', 'Same', { dataFlow: 'base flow' }, '2026-01-03T00:00:00.000Z') });

    const result = mergeAnnotationFiles(base, ours, theirs);

    // theirs left dataFlow at the base value, so ours wins even though theirs is newer.
    expect(result.file.annotations['mod:a'].annotation.dataFlow).toBe('ours flow');
    expect(listMergeReviewFields(result.file.annotations['mod:a'].annotation)).toEqual([]);
  });

  it('deduplicates array entries both sides added', () => {
    const base = file({ 'mod:a': annotation('mod:a', 'Same') });
    const ours = file({ 'mod:a': annotation('mod:a', 'Same', { risks: ['shared risk', 'ours risk'] }, '2026-01-02T00:00:00.000Z') });
    const theirs = file({ 'mod:a': annotation('mod:a', 'Same', { risks: ['shared risk', 'theirs risk'] }, '2026-01-03T00:00:00.000Z') });

    const result = mergeAnnotationFiles(base, ours, theirs);

    expect(result.file.annotations['mod:a'].annotation.risks).toEqual([
      'shared risk',
      'ours risk',
      'theirs risk',
    ]);
  });

  it('keeps ours when both sides carry the same timestamp', () => {
    const stamp = '2026-01-05T00:00:00.000Z';
    const base = file({ 'mod:a': annotation('mod:a', 'Base') });
    const ours = file({ 'mod:a': annotation('mod:a', 'Ours', {}, stamp) });
    const theirs = file({ 'mod:a': annotation('mod:a', 'Theirs', {}, stamp) });

    const result = mergeAnnotationFiles(base, ours, theirs);

    expect(result.file.annotations['mod:a'].annotation.summary).toBe('Ours');
    expect(result.annotationConflicts).toEqual([
      expect.objectContaining({ nodeId: 'mod:a', field: 'annotation.summary', chosen: 'ours' }),
    ]);
  });

  it('reports a field one side deleted while the other changed it', () => {
    const base = file({ 'mod:a': annotation('mod:a', 'Same', { dataFlow: 'base flow' }) });
    const ours = file({ 'mod:a': annotation('mod:a', 'Same', {}, '2026-01-02T00:00:00.000Z') });
    const theirs = file({ 'mod:a': annotation('mod:a', 'Same', { dataFlow: 'theirs flow' }, '2026-01-03T00:00:00.000Z') });

    const result = mergeAnnotationFiles(base, ours, theirs);

    expect(result.file.annotations['mod:a'].annotation.dataFlow).toBe('theirs flow');
    expect(result.annotationConflicts).toEqual([
      expect.objectContaining({
        nodeId: 'mod:a',
        field: 'annotation.dataFlow',
        chosen: 'theirs',
        reason: 'ours deleted field while theirs changed it',
      }),
    ]);
  });

  it('merges nested record fields key by key', () => {
    const base = file({ 'mod:a': annotation('mod:a', 'Same', { keyExports: { shared: 'base' } }) });
    const ours = file({ 'mod:a': annotation('mod:a', 'Same', { keyExports: { shared: 'base', fromOurs: 'ours export' } }, '2026-01-02T00:00:00.000Z') });
    const theirs = file({ 'mod:a': annotation('mod:a', 'Same', { keyExports: { shared: 'base', fromTheirs: 'theirs export' } }, '2026-01-03T00:00:00.000Z') });

    const result = mergeAnnotationFiles(base, ours, theirs);

    expect(result.file.annotations['mod:a'].annotation.keyExports).toEqual({
      shared: 'base',
      fromOurs: 'ours export',
      fromTheirs: 'theirs export',
    });
    expect(result.annotationConflicts).toHaveLength(0);
  });
});

describe('annotation merge edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-merge-edge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('chooses theirs when theirs updatedAt is newer and still adds merge-review markers', () => {
    const base = annotationFile({});
    const ours = annotationFile({
      'mod:a': annotation('mod:a', 'Ours summary', {}, '2026-01-01T00:00:00.000Z'),
    });
    const theirs = annotationFile({
      'mod:a': annotation('mod:a', 'Theirs summary', {}, '2026-01-05T00:00:00.000Z'),
    });

    const result = mergeAnnotationFiles(base, ours, theirs);
    const merged = result.file.annotations['mod:a'];

    expect(merged.annotation.summary).toBe('Theirs summary');
    expect(merged.annotation.patterns).toEqual(['merge-review:summary']);
    expect(result.annotationConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'mod:a', field: 'annotation.summary', chosen: 'theirs' }),
    ]));
  });

  it('does not add merge-review markers when scalar values match on both sides', () => {
    const base = annotationFile({});
    const ours = annotationFile({
      'mod:a': annotation('mod:a', 'Same summary', { assumptions: ['ours only'] }),
    });
    const theirs = annotationFile({
      'mod:a': annotation('mod:a', 'Same summary', { risks: ['theirs only'] }),
    });

    const result = mergeAnnotationFiles(base, ours, theirs);
    const merged = result.file.annotations['mod:a'];

    expect(merged.annotation.summary).toBe('Same summary');
    expect(merged.annotation.patterns).toBeUndefined();
    expect(result.annotationConflicts.filter(c => c.field === 'annotation.summary')).toHaveLength(0);
    expect(merged.annotation.assumptions).toEqual(['ours only']);
    expect(merged.annotation.risks).toEqual(['theirs only']);
  });

  it('preserves the extended annotation envelope during field-level merge', () => {
    const base = annotationFile({
      'mod:a': annotation('mod:a', 'Stable summary'),
    });
    const ours = annotationFile({
      'mod:a': annotation('mod:a', 'Stable summary', {
        keyExports: { ours: 'ours export' },
        assumptions: ['ours assumption'],
        sideEffects: [{ kind: 'io-read', subtype: 'fs', description: 'reads local cache' }],
        risks: [{ text: 'importers must verify this locally', scope: 'consumer' }],
        patterns: ['ours pattern'],
        invariants: ['ours invariant'],
        extensionPoints: ['ours extension'],
        integrationPoints: { ours: 'mod:ours/gate' },
        stateShape: { ours: 'ours state' },
        dataFlow: { ours: 'ours flow' },
        envDependencies: { OURS_ENV: 'read by ours path' },
        propagationSlice: {
          anchor: 'mod:a',
          path: ['mod:a', 'mod:ours/gate'],
          reviewedAt: '2026-01-03T00:00:00.000Z',
        },
      }, '2026-01-03T00:00:00.000Z'),
    });
    const theirs = annotationFile({
      'mod:a': annotation('mod:a', 'Stable summary', {
        keyExports: { theirs: 'theirs export' },
        assumptions: ['theirs assumption'],
        sideEffects: [{ kind: 'io-write', subtype: 'fs', description: 'writes merge report' }],
        risks: [{ text: 'published contract must not move', scope: 'boundary' }],
        patterns: ['theirs pattern'],
        invariants: ['theirs invariant'],
        extensionPoints: ['theirs extension'],
        integrationPoints: { theirs: 'mod:theirs/adapter' },
        stateShape: { theirs: 'theirs state' },
        dataFlow: { theirs: 'theirs flow' },
        envDependencies: { THEIRS_ENV: 'read by theirs path' },
      }, '2026-01-02T00:00:00.000Z'),
    });

    const result = mergeAnnotationFiles(base, ours, theirs);
    const merged = result.file.annotations['mod:a'];

    expect(result.annotationConflicts).toEqual([]);
    expect(merged.annotation).toMatchObject({
      summary: 'Stable summary',
      keyExports: {
        ours: 'ours export',
        theirs: 'theirs export',
      },
      integrationPoints: {
        ours: 'mod:ours/gate',
        theirs: 'mod:theirs/adapter',
      },
      stateShape: {
        ours: 'ours state',
        theirs: 'theirs state',
      },
      dataFlow: {
        ours: 'ours flow',
        theirs: 'theirs flow',
      },
      envDependencies: {
        OURS_ENV: 'read by ours path',
        THEIRS_ENV: 'read by theirs path',
      },
      propagationSlice: {
        anchor: 'mod:a',
        path: ['mod:a', 'mod:ours/gate'],
        reviewedAt: '2026-01-03T00:00:00.000Z',
      },
    });
    expect(merged.annotation.assumptions).toEqual(['ours assumption', 'theirs assumption']);
    expect(merged.annotation.sideEffects).toEqual([
      { kind: 'io-read', subtype: 'fs', description: 'reads local cache' },
      { kind: 'io-write', subtype: 'fs', description: 'writes merge report' },
    ]);
    expect(merged.annotation.risks).toEqual([
      { text: 'importers must verify this locally', scope: 'consumer' },
      { text: 'published contract must not move', scope: 'boundary' },
    ]);
    expect(merged.annotation.patterns).toEqual(['ours pattern', 'theirs pattern']);
    expect(merged.annotation.invariants).toEqual(['ours invariant', 'theirs invariant']);
    expect(merged.annotation.extensionPoints).toEqual(['ours extension', 'theirs extension']);
  });

  it('auto-merges scalar from the side that changed relative to base without merge-review', () => {
    const base = annotationFile({
      'mod:a': annotation('mod:a', 'Shared summary'),
    });
    const ours = annotationFile({
      'mod:a': annotation('mod:a', 'Shared summary', { assumptions: ['ours assumption'] }),
    });
    const theirs = annotationFile({
      'mod:a': annotation('mod:a', 'Theirs summary', { risks: ['theirs risk'] }, '2026-01-05T00:00:00.000Z'),
    });

    const result = mergeAnnotationFiles(base, ours, theirs);
    const merged = result.file.annotations['mod:a'];

    expect(merged.annotation.summary).toBe('Theirs summary');
    expect(merged.annotation.patterns).toBeUndefined();
    expect(result.annotationConflicts.filter(c => c.field === 'annotation.summary')).toHaveLength(0);
    expect(merged.annotation.assumptions).toEqual(['ours assumption']);
    expect(merged.annotation.risks).toEqual(['theirs risk']);
  });

  it('adds merge-review markers for non-summary scalar fields', () => {
    const base = annotationFile({});
    const ours = annotationFile({
      'mod:a': annotation('mod:a', 'Stable summary', { flowDescription: 'Ours flow' }, '2026-01-03T00:00:00.000Z'),
    });
    const theirs = annotationFile({
      'mod:a': annotation('mod:a', 'Stable summary', { flowDescription: 'Theirs flow' }, '2026-01-02T00:00:00.000Z'),
    });

    const result = mergeAnnotationFiles(base, ours, theirs);
    const merged = result.file.annotations['mod:a'];

    expect(merged.annotation.summary).toBe('Stable summary');
    expect(merged.annotation.flowDescription).toBe('Ours flow');
    expect(merged.annotation.patterns).toEqual(['merge-review:flowDescription']);
    expect(merged.annotation.assumptions).toEqual(expect.arrayContaining([
      '[merge-review:flowDescription:ours] Ours flow',
      '[merge-review:flowDescription:theirs] Theirs flow',
    ]));
  });

  it('tracks multiple scalar merge-review fields on one node', () => {
    const base = annotationFile({});
    const ours = annotationFile({
      'mod:a': annotation(
        'mod:a',
        'Ours summary',
        { flowDescription: 'Ours flow' },
        '2026-01-03T00:00:00.000Z',
      ),
    });
    const theirs = annotationFile({
      'mod:a': annotation(
        'mod:a',
        'Theirs summary',
        { flowDescription: 'Theirs flow' },
        '2026-01-02T00:00:00.000Z',
      ),
    });

    const result = mergeAnnotationFiles(base, ours, theirs);
    const merged = result.file.annotations['mod:a'];

    expect(merged.annotation.patterns).toEqual(['merge-review:flowDescription', 'merge-review:summary']);
    expect(listMergeReviewFields(merged.annotation).sort()).toEqual(['flowDescription', 'summary']);
  });

  it('dry-run leaves conflict markers on disk', () => {
    const filePath = path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH);
    const ours = serializeAnnotationFile(annotationFile({
      'mod:a': annotation('mod:a', 'Ours summary', {}, '2026-01-03T00:00:00.000Z'),
    }));
    const theirs = serializeAnnotationFile(annotationFile({
      'mod:a': annotation('mod:a', 'Theirs summary', {}, '2026-01-02T00:00:00.000Z'),
    }));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, [
      '<<<<<<< HEAD',
      ours,
      '=======',
      theirs,
      '>>>>>>> feature',
    ].join('\n'), 'utf-8');

    const result = mergeAnnotationsOnDisk(tmpDir, { dryRun: true });

    expect(result.status).toBe('dry-run');
    expect(result.wroteFile).toBe(false);
    expect(result.baseSource).toBe('none');
    expect(getAnnotationMergeStatus(tmpDir).file.hasConflictMarkers).toBe(true);
  });

  it('merges diff3 markers outside a git index using the embedded base sections', () => {
    const filePath = path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH);
    const base = serializeAnnotationFile(annotationFile({
      'mod:a': annotation('mod:a', 'Base summary'),
      'mod:b': annotation('mod:b', 'B base'),
    }));
    const ours = serializeAnnotationFile(annotationFile({
      'mod:a': annotation('mod:a', 'Ours summary', {}, '2026-01-03T00:00:00.000Z'),
    }));
    const theirs = serializeAnnotationFile(annotationFile({
      'mod:a': annotation('mod:a', 'Base summary'),
      'mod:b': annotation('mod:b', 'B theirs', {}, '2026-01-02T00:00:00.000Z'),
    }));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `<<<<<<< HEAD\n${ours}||||||| merged common ancestors\n${base}=======\n${theirs}>>>>>>> feature\n`,
      'utf-8',
    );

    const result = mergeAnnotationsOnDisk(tmpDir);

    expect(result.status).toBe('merged');
    expect(result.baseSource).toBe('conflict-markers-diff3');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // Theirs kept mod:a at base while ours edited it: ours wins without merge-review.
    expect(parsed.annotations['mod:a'].annotation.summary).toBe('Ours summary');
    expect(listMergeReviewFields(parsed.annotations['mod:a'].annotation)).toEqual([]);
    // Ours deleted mod:b while theirs changed it: kept and surfaced, not silently resurrected.
    expect(parsed.annotations['mod:b'].annotation.summary).toBe('B theirs');
    expect(result.annotationConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'mod:b',
        field: '*',
        chosen: 'theirs',
        reason: 'ours deleted annotation while theirs changed it',
      }),
    ]));
  });

  it('carries common context outside the hunks through the marker fallback', () => {
    // Real git output keeps the JSON envelope lines outside the conflict markers; a fallback that
    // drops them produces unparseable sides.
    const text = conflictTextOutsideGit({
      base: { 'mod:a': annotation('mod:a', 'A base'), 'mod:z': annotation('mod:z', 'Z shared') },
      ours: { 'mod:a': annotation('mod:a', 'A ours', {}, '2026-01-03T00:00:00.000Z'), 'mod:z': annotation('mod:z', 'Z shared') },
      theirs: { 'mod:a': annotation('mod:a', 'A theirs', {}, '2026-01-02T00:00:00.000Z'), 'mod:z': annotation('mod:z', 'Z shared') },
    }, tmpDir);
    expect(text).toContain('"version": 1');
    expect(text.split('\n').indexOf('  "annotations": {')).toBeLessThan(text.split('\n').findIndex(l => l.startsWith('<<<<<<<')));

    const result = mergeAnnotationsOnDisk(tmpDir);

    expect(result.status).toBe('merged');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8'));
    // The entry that lives outside the conflict hunk must survive on both sides.
    expect(parsed.annotations['mod:z'].annotation.summary).toBe('Z shared');
    expect(parsed.annotations['mod:a'].annotation.summary).toBe('A ours');
  });

  it('falls back to add/add semantics when only some hunks carry a diff3 base', () => {
    const filePath = path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH);
    const entry = (nodeId: string, summary: string, updatedAt: string) =>
      `  ${JSON.stringify(nodeId)}: ${JSON.stringify({
        contentHash: `${nodeId}:hash`,
        updatedAt,
        annotation: { summary },
      })}`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // The base-carrying hunk is last, so a partial base built from it alone would still be valid
    // JSON: the merge outcome — not a parse error — is what distinguishes honoring the gate.
    // With no base, mod:a is an add/add conflict (merge-review, newest side wins). With the partial
    // base, base equals ours and theirs would auto-merge in silently.
    fs.writeFileSync(filePath, [
      '{',
      '  "version": 1,',
      '  "annotations": {',
      '<<<<<<< HEAD',
      `${entry('mod:b', 'B ours', '2026-01-03T00:00:00.000Z')},`,
      '=======',
      `${entry('mod:b', 'B theirs', '2026-01-02T00:00:00.000Z')},`,
      '>>>>>>> feature',
      '<<<<<<< HEAD',
      entry('mod:a', 'A base', '2026-01-03T00:00:00.000Z'),
      '||||||| merged common ancestors',
      entry('mod:a', 'A base', '2026-01-01T00:00:00.000Z'),
      '=======',
      entry('mod:a', 'A theirs', '2026-01-02T00:00:00.000Z'),
      '>>>>>>> feature',
      '  }',
      '}',
      '',
    ].join('\n'), 'utf-8');

    const result = mergeAnnotationsOnDisk(tmpDir);

    expect(result.status).toBe('merged');
    expect(result.baseSource).toBe('none');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.annotations['mod:a'].annotation.summary).toBe('A base');
    expect(parsed.annotations['mod:a'].annotation.patterns).toEqual(['merge-review:summary']);
    expect(parsed.annotations['mod:b'].annotation.summary).toBe('B ours');
  });

  it('degrades to an empty base when a zdiff3 reconstruction is unparseable', () => {
    // zdiff3 hoists lines shared by both sides out of the conflict region while leaving the base
    // section whole, so the reconstructed base is not valid JSON.
    conflictTextOutsideGit({
      conflictStyle: 'zdiff3',
      base: { 'mod:a': annotation('mod:a', 'A base') },
      ours: {
        'mod:a': annotation('mod:a', 'A ours', {}, '2026-01-03T00:00:00.000Z'),
        'mod:x': annotation('mod:x', 'X shared', {}, '2026-01-03T00:00:00.000Z'),
      },
      theirs: {
        'mod:a': annotation('mod:a', 'A theirs', {}, '2026-01-02T00:00:00.000Z'),
        'mod:x': annotation('mod:x', 'X shared', {}, '2026-01-03T00:00:00.000Z'),
      },
    }, tmpDir);

    const result = mergeAnnotationsOnDisk(tmpDir);

    expect(result.status).toBe('merged');
    expect(result.baseSource).toBe('none');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8'));
    expect(parsed.annotations['mod:a'].annotation.summary).toBe('A ours');
    expect(parsed.annotations['mod:x'].annotation.summary).toBe('X shared');
  });

  it('reports a clear error for a stray diff3 base marker', () => {
    const filePath = path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '||||||| base\n=======\n>>>>>>> feature\n', 'utf-8');

    const result = mergeAnnotationsOnDisk(tmpDir);

    expect(result.status).toBe('error');
    expect(result.message).toContain('Malformed diff3 base marker');
  });

  it.each([
    ['unclosed hunk', '<<<<<<< HEAD\n{}\n=======\n{}\n', 'Unclosed conflict marker'],
    ['nested start marker', '<<<<<<< HEAD\n<<<<<<< OTHER\n{}\n=======\n{}\n>>>>>>> feature\n', 'Nested or malformed conflict marker'],
    ['end marker before separator', '<<<<<<< HEAD\n{}\n>>>>>>> feature\n', 'Malformed conflict end marker'],
  ])('refuses a malformed conflict file: %s', (_label, body, expected) => {
    const filePath = path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body, 'utf-8');

    const result = mergeAnnotationsOnDisk(tmpDir);

    expect(result.status).toBe('error');
    expect(result.message).toContain(expected);
    // A file we could not parse must survive untouched for manual repair.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(body);
  });

  it('reconstructs a diff3 base from real git output, envelope included', () => {
    // Real diff3 output keeps the JSON envelope outside the hunk, so the base section alone is not
    // valid JSON: the reconstruction has to carry the common lines into the base as well.
    conflictTextOutsideGit({
      conflictStyle: 'diff3',
      base: { 'mod:a': annotation('mod:a', 'A base'), 'mod:keep': annotation('mod:keep', 'Keep') },
      ours: { 'mod:a': annotation('mod:a', 'A base'), 'mod:keep': annotation('mod:keep', 'Keep'), 'mod:ours': annotation('mod:ours', 'Ours only', {}, '2026-01-03T00:00:00.000Z') },
      theirs: { 'mod:a': annotation('mod:a', 'A theirs', {}, '2026-01-02T00:00:00.000Z'), 'mod:keep': annotation('mod:keep', 'Keep') },
    }, tmpDir);

    const result = mergeAnnotationsOnDisk(tmpDir);

    expect(result.status).toBe('merged');
    expect(result.baseSource).toBe('conflict-markers-diff3');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8'));
    // ours left mod:a at the base value, so the real base makes theirs win without merge-review.
    expect(parsed.annotations['mod:a'].annotation.summary).toBe('A theirs');
    expect(parsed.annotations['mod:ours'].annotation.summary).toBe('Ours only');
    expect(parsed.annotations['mod:keep'].annotation.summary).toBe('Keep');
  });
});

describe('validateAnnotationHealth merge-review', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-valid-merge-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports mergeReview count and needs-review while markers remain', () => {
    writeAnnotations(tmpDir, {
      'mod:a': annotation('mod:a', 'Draft summary', {
        patterns: ['merge-review:summary'],
        assumptions: [
          '[merge-review:summary:ours] Ours summary',
          '[merge-review:summary:theirs] Theirs summary',
        ],
      }),
      'mod:b': annotation('mod:b', 'Clean summary'),
    });
    const store = AnnotationStore.createSync(tmpDir);
    const graph = makeValidateGraph(['mod:a', 'mod:b']);
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date().toISOString(),
      packages: [],
      modules: [makeMod('mod:a'), makeMod('mod:b')],
    };

    const report = validateAnnotationHealth({
      repoRoot: tmpDir,
      graph,
      snapshot,
      annotations: store,
    });

    expect(report.counts.mergeReview).toBe(1);
    expect(report.status).toBe('needs-review');
    expect(report.nextActions.some(a => a.includes('merge-review markers'))).toBe(true);
  });

  it('is clean when no merge-review markers remain', () => {
    writeAnnotations(tmpDir, {
      'mod:a': annotation('mod:a', 'Final summary'),
    });
    const store = AnnotationStore.createSync(tmpDir);
    const graph = makeValidateGraph(['mod:a']);
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date().toISOString(),
      packages: [],
      modules: [makeMod('mod:a')],
    };

    const report = validateAnnotationHealth({
      repoRoot: tmpDir,
      graph,
      snapshot,
      annotations: store,
    });

    expect(report.counts.mergeReview).toBe(0);
    expect(report.status).toBe('clean');
  });

  it('is not "clean" while the store has a pending save error', () => {
    writeAnnotations(tmpDir, { 'mod:a': annotation('mod:a', 'Final summary') });
    const store = AnnotationStore.createSync(tmpDir);
    (store as unknown as { _lastSaveError: string | null })._lastSaveError = 'disk full';
    const graph = makeValidateGraph(['mod:a']);
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date().toISOString(),
      packages: [],
      modules: [makeMod('mod:a')],
    };

    const report = validateAnnotationHealth({ repoRoot: tmpDir, graph, snapshot, annotations: store });

    // Status must not contradict a "saves are failing" advisory (finding #6).
    expect(report.status).toBe('needs-review');
    expect(report.nextActions.some(a => a.includes('saves are failing'))).toBe(true);
  });

  it('uses one scanAnnotationHealth pass and never materializes the full getQueue', () => {
    writeAnnotations(tmpDir, { 'mod:a': annotation('mod:a', 'summary') });
    const store = AnnotationStore.createSync(tmpDir);
    const graph = makeValidateGraph(['mod:a', 'mod:b']);
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date().toISOString(),
      packages: [],
      modules: [makeMod('mod:a'), makeMod('mod:b')],
    };
    const getQueueSpy = jest.spyOn(store, 'getQueue');
    const scanSpy = jest.spyOn(store, 'scanAnnotationHealth');

    validateAnnotationHealth({ repoRoot: tmpDir, graph, snapshot, annotations: store });

    expect(getQueueSpy).not.toHaveBeenCalled();
    expect(scanSpy).toHaveBeenCalledTimes(1);
  });

  it('can reuse the store cached merge-status snapshot for warm validation paths', () => {
    writeAnnotations(tmpDir, { 'mod:a': annotation('mod:a', 'summary') });
    const store = AnnotationStore.createSync(tmpDir);

    expect(getAnnotationMergeStatus(tmpDir, undefined, { annotations: store }).file).toEqual(
      expect.objectContaining({
        exists: true,
        parseOk: true,
        hasConflictMarkers: false,
        annotationCount: 1,
      }),
    );

    // Corrupt the file after runtime load: cached warm-path status should still reflect
    // the loaded snapshot, while the disk-truth path sees the new parse error.
    fs.writeFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), '{broken json');

    expect(getAnnotationMergeStatus(tmpDir, undefined, { annotations: store }).file).toEqual(
      expect.objectContaining({
        exists: true,
        parseOk: true,
        hasConflictMarkers: false,
        annotationCount: 1,
      }),
    );
    expect(getAnnotationMergeStatus(tmpDir).file).toEqual(
      expect.objectContaining({
        exists: true,
        parseOk: false,
        hasConflictMarkers: false,
      }),
    );
  });

  it('refreshes the cached merge-status snapshot after write/flush', () => {
    writeAnnotations(tmpDir, { 'mod:a': annotation('mod:a', 'summary') });
    const store = AnnotationStore.createSync(tmpDir);
    store.set('mod:b', annotation('mod:b', 'new summary'));
    store.flush();

    expect(getAnnotationMergeStatus(tmpDir, undefined, { annotations: store }).file).toEqual(
      expect.objectContaining({
        exists: true,
        parseOk: true,
        hasConflictMarkers: false,
        annotationCount: 2,
      }),
    );
  });
});

describe('annotation backup retention', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-backup-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const filePath = () => path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH);
  const backups = () => fs.readdirSync(tmpDir)
    .filter(f => f.startsWith('annotations.backup.') && f.endsWith('.json'))
    .sort();

  it('treats same-size different-content snapshots as distinct backups', () => {
    const a = Buffer.from('{"version":1,"annotations":{"mod:a":1}}', 'utf-8');
    const b = Buffer.from('{"version":1,"annotations":{"mod:b":1}}', 'utf-8');
    expect(a.byteLength).toBe(b.byteLength);

    const first = writeAnnotationBackup(filePath(), a);
    const second = writeAnnotationBackup(filePath(), b);

    expect(first.status).toBe('written');
    expect(second.status).toBe('written');
    expect(backups()).toHaveLength(2);
  });

  it('reuses the retained backup holding identical bytes', () => {
    const data = Buffer.from('{"version":1,"annotations":{}}', 'utf-8');

    const first = writeAnnotationBackup(filePath(), data);
    const second = writeAnnotationBackup(filePath(), data);

    expect(first.status).toBe('written');
    expect(second).toEqual({ status: 'duplicate', backupPath: (first as { backupPath: string }).backupPath });
    expect(backups()).toHaveLength(1);
  });

  it('keeps only the newest MAX_ANNOTATION_BACKUPS snapshots', () => {
    for (let i = 0; i < MAX_ANNOTATION_BACKUPS + 3; i++) {
      // Distinct content per write, otherwise dedup would collapse them.
      const written = writeAnnotationBackup(filePath(), Buffer.from(`{"n":${i}}`, 'utf-8'));
      expect(written.status).toBe('written');
      // Timestamps have millisecond resolution; force distinct names.
      const stamped = (written as { backupPath: string }).backupPath;
      fs.renameSync(stamped, path.join(tmpDir, `annotations.backup.2026-01-01T00-00-0${i}-000Z.json`));
    }

    // Rotation runs on the next write, over the renamed set.
    writeAnnotationBackup(filePath(), Buffer.from('{"n":"final"}', 'utf-8'));

    expect(backups().length).toBeLessThanOrEqual(MAX_ANNOTATION_BACKUPS);
  });
});

describe('merge deletions vs a live store', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-merge-store-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps a merge-resolved deletion deleted after the store reloads', async () => {
    // theirs removed mod:c and ours left it untouched, so the merge honors the deletion. A store
    // loaded before the conflict still holds mod:c; its never-drop net must not write it back.
    let store: AnnotationStore | undefined;
    setupConflict(tmpDir, {
      base: { 'mod:a': annotation('mod:a', 'A base'), 'mod:c': annotation('mod:c', 'C base') },
      ours: { 'mod:a': annotation('mod:a', 'A ours', {}, '2026-01-03T00:00:00.000Z'), 'mod:c': annotation('mod:c', 'C base') },
      theirs: { 'mod:a': annotation('mod:a', 'A theirs', {}, '2026-01-02T00:00:00.000Z') },
      // A long-lived MCP server holds the pre-conflict file in memory.
      beforeMerge: () => { store = AnnotationStore.createSync(tmpDir); },
    });
    expect(store).toBeDefined();
    expect(Object.keys((store as AnnotationStore).getAll())).toContain('mod:c');

    const merge = mergeAnnotationsOnDisk(tmpDir);
    expect(merge.deleted).toBe(1);
    expect(merge.deletedNodeIds).toEqual(['mod:c']);

    const live = store as AnnotationStore;
    live.forgetDeletedOnDisk(merge.deletedNodeIds ?? []);
    await live.reloadFromDisk();
    expect(Object.keys(live.getAll())).not.toContain('mod:c');

    live.set('mod:new', annotation('mod:new', 'New', {}, '2026-01-05T00:00:00.000Z'));
    await live.flushAsync();
    const onDisk = Object.keys(JSON.parse(
      fs.readFileSync(path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH), 'utf-8'),
    ).annotations);
    expect(onDisk).not.toContain('mod:c');
    expect(onDisk).toContain('mod:new');
  });

  it('accepts a node that is legitimately re-annotated after the merge deleted it', async () => {
    // Forgetting a merge-resolved deletion must not blocklist the node: re-annotating it later is
    // ordinary work, and the store would otherwise delete it again on every save.
    setupConflict(tmpDir, {
      base: { 'mod:a': annotation('mod:a', 'A base'), 'mod:c': annotation('mod:c', 'C base') },
      ours: { 'mod:a': annotation('mod:a', 'A ours', {}, '2026-01-03T00:00:00.000Z'), 'mod:c': annotation('mod:c', 'C base') },
      theirs: { 'mod:a': annotation('mod:a', 'A theirs', {}, '2026-01-02T00:00:00.000Z') },
    });
    const merge = mergeAnnotationsOnDisk(tmpDir);
    expect(merge.deletedNodeIds).toEqual(['mod:c']);

    const store = AnnotationStore.createSync(tmpDir);
    store.forgetDeletedOnDisk(merge.deletedNodeIds ?? []);

    // Another writer (a teammate's agent, a later pull) re-annotates the node on disk.
    const filePath = path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    raw.annotations['mod:c'] = {
      contentHash: 'mod:c:hash',
      updatedAt: '2026-01-06T00:00:00.000Z',
      annotation: { summary: 'C re-annotated' },
    };
    fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf-8');

    await store.reloadFromDisk();
    expect(store.get('mod:c')?.annotation.summary).toBe('C re-annotated');

    store.set('mod:other', annotation('mod:other', 'Other', {}, '2026-01-07T00:00:00.000Z'));
    await store.flushAsync();
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(onDisk.annotations['mod:c'].annotation.summary).toBe('C re-annotated');
  });
});

describe('annotation file lock during maintenance', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annot-maint-lock-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('normalize acquires repovine.annots.json.lock and releases it after write', () => {
    const filePath = path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH);
    const lockPath = `${filePath}.lock`;
    writeAnnotations(tmpDir, { 'mod:a': annotation('mod:a', 'summary') });
    // Non-canonical trailing whitespace forces a locked rewrite.
    fs.appendFileSync(filePath, '\n');

    const result = normalizeAnnotationsFile(tmpDir);
    expect(result.status).toBe('normalized');
    expect(result.wroteFile).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(tmpDir).filter(name => name.includes('.tmp.'))).toEqual([]);
  });

  it('reads merge input only after acquiring the annotation lock', async () => {
    const filePath = path.join(tmpDir, ANNOTATIONS_RELATIVE_PATH);
    const lockPath = `${filePath}.lock`;
    const ours = serializeAnnotationFile(annotationFile({
      'mod:a': annotation('mod:a', 'stale ours', {}, '2026-01-03T00:00:00.000Z'),
    }));
    const theirs = serializeAnnotationFile(annotationFile({
      'mod:a': annotation('mod:a', 'stale theirs', {}, '2026-01-02T00:00:00.000Z'),
    }));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, ['<<<<<<< HEAD', ours, '=======', theirs, '>>>>>>> feature'].join('\n'));

    const replacement = serializeAnnotationFile(annotationFile({
      'mod:a': annotation('mod:a', 'newer locked writer'),
    }));
    const child = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const lockPath = process.env.LOCK_PATH;
      const filePath = process.env.FILE_PATH;
      const replacement = process.env.REPLACEMENT;
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      process.stdout.write('locked\\n');
      setTimeout(() => {
        fs.writeFileSync(filePath, replacement);
        fs.unlinkSync(lockPath);
      }, 150);
    `], {
      env: {
        ...process.env,
        LOCK_PATH: lockPath,
        FILE_PATH: filePath,
        REPLACEMENT: replacement,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let readySeen = false;
    let childStderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', chunk => { childStderr += chunk; });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding('utf-8');
      child.stdout.once('data', chunk => {
        if (chunk.includes('locked')) {
          readySeen = true;
          resolve();
        } else {
          reject(new Error(`Unexpected child output: ${chunk}`));
        }
      });
      child.once('error', reject);
      child.once('exit', code => {
        if (!readySeen) reject(new Error(`Lock holder exited early (${code}): ${childStderr}`));
      });
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`Lock holder failed (${code}): ${childStderr}`));
      });
    });

    await ready;
    const result = mergeAnnotationsOnDisk(tmpDir);
    await exited;

    expect(result.status).toBe('no-conflict');
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      annotations: Record<string, { annotation: { summary: string } }>;
    };
    expect(parsed.annotations['mod:a'].annotation.summary).toBe('newer locked writer');
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(tmpDir).filter(name => name.includes('.tmp.'))).toEqual([]);
  });
});

describe('validateAnnotationHealth consumer-scope density (advisory)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-density-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function reportFor(annotations: Record<string, StoredAnnotation>) {
    writeAnnotations(tmpDir, annotations);
    const store = AnnotationStore.createSync(tmpDir);
    const ids = Object.keys(annotations);
    const graph = makeValidateGraph(ids);
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date().toISOString(),
      packages: [],
      modules: ids.map(makeMod),
    };
    return validateAnnotationHealth({ repoRoot: tmpDir, graph, snapshot, annotations: store });
  }

  it('flags over-threshold consumer ratio and per-node cap without failing clean status', () => {
    const report = reportFor({
      'mod:a': annotation('mod:a', 'Alpha', {
        risks: [
          { text: 'importer must verify gate', scope: 'consumer' },
          { text: 'bare fact one', scope: 'consumer' },
          { text: 'bare fact two', scope: 'consumer' },
          { text: 'bare fact three', scope: 'consumer' },
        ],
      }),
      'mod:b': annotation('mod:b', 'Beta', { risks: ['plain local fact'] }),
    });

    const density = report.consumerScopeDensity;
    expect(density.consumerRisks).toBe(4);
    expect(density.totalRisks).toBe(5);
    expect(density.overGlobalThreshold).toBe(true);
    expect(density.nodesOverPerNodeCap).toEqual([{ nodeId: 'mod:a', count: 4 }]);
    expect(density.unmarkedConsumerRisks).toBe(3); // three bare-fact consumer risks
    expect(report.nextActions.some(a => a.includes('scope:"consumer"'))).toBe(true);
    // Advisory only: density never flips a fresh, merged graph to needs-review.
    expect(report.status).toBe('clean');
    expect(CONSUMER_SCOPE_PER_NODE_WARN).toBe(3);
  });

  it('reports zeroed density when no consumer risks exist', () => {
    const report = reportFor({
      'mod:a': annotation('mod:a', 'Alpha', { risks: ['local only'] }),
    });
    expect(report.consumerScopeDensity.consumerRisks).toBe(0);
    expect(report.consumerScopeDensity.overGlobalThreshold).toBe(false);
    expect(report.status).toBe('clean');
  });
});

describe('validateAnnotationHealth risk-scope candidates (advisory)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-risk-candidates-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function reportFor(
    annotations: Record<string, StoredAnnotation>,
    options: { scope?: string | string[] } = {},
  ) {
    writeAnnotations(tmpDir, annotations);
    const store = AnnotationStore.createSync(tmpDir);
    const ids = Object.keys(annotations);
    const graph = makeValidateGraph(ids);
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date().toISOString(),
      packages: [],
      modules: ids.map(makeMod),
    };
    return validateAnnotationHealth({
      repoRoot: tmpDir,
      graph,
      snapshot,
      annotations: store,
      ...(options.scope ? { scope: options.scope } : {}),
    });
  }

  it('adds advisory counts and nextActions without failing a clean graph', () => {
    const report = reportFor({
      'mod:a': annotation('mod:a', 'Alpha', {
        risks: [
          'Importers must verify this gate locally before changing behavior.',
          'Published contract for external clients is frozen.',
        ],
      }),
    });

    expect(report.status).toBe('clean');
    expect(report.needsWork).toBe(0);
    expect(report.queueSample).toEqual([]);
    expect(report.riskScopeCandidates).toEqual(expect.objectContaining({
      consumer: 1,
      boundary: 1,
      total: 2,
    }));
    expect(report.riskScopeCandidates.sample).toHaveLength(2);
    expect(report.nextActions).toEqual(expect.arrayContaining([
      'Advisory: 1 plain/local risk(s) look like scope:"consumer" candidates; review before relying on investigate risk delivery.',
      'Advisory: 1 plain/local risk(s) look like scope:"boundary" candidates; review before relying on boundary delivery.',
    ]));
  });

  it('respects scoped validation for candidate counts and samples', () => {
    const report = reportFor({
      'mod:alpha/a': annotation('mod:alpha/a', 'Alpha', {
        risks: ['Importers must verify this gate locally before changing behavior.'],
      }),
      'mod:beta/b': annotation('mod:beta/b', 'Beta', {
        risks: ['Importers must verify this gate locally before changing behavior.'],
      }),
    }, { scope: 'alpha' });

    expect(report.riskScopeCandidates.total).toBe(1);
    expect(report.riskScopeCandidates.consumer).toBe(1);
    expect(report.riskScopeCandidates.sample.map((item) => item.nodeId)).toEqual(['mod:alpha/a']);
    expect(report.needsWorkInScope).toBe(0);
    expect(report.scopedClean).toBe(true);
  });
});

describe('validateAnnotationHealth carrier-link gaps (advisory)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-carrier-gaps-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes carrierLinkGaps and aggregate nextActions without failing clean status', () => {
    writeAnnotations(tmpDir, {
      'mod:facade': annotation('mod:facade', 'Facade summary'),
      'mod:target': annotation('mod:target', 'Target summary', {
        risks: [{ text: 'importer must verify gate locally', scope: 'consumer' }],
      }),
    });
    const store = AnnotationStore.createSync(tmpDir);
    const graph = makeValidateGraph(['mod:facade', 'mod:mid', 'mod:target']);
    addEdge(graph, 'mod:facade', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:target', 'imports');
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date().toISOString(),
      packages: [],
      modules: ['mod:facade', 'mod:mid', 'mod:target'].map(makeMod),
    };

    const report = validateAnnotationHealth({ repoRoot: tmpDir, graph, snapshot, annotations: store });

    expect(report.status).toBe('clean');
    expect(report.carrierLinkGaps).toEqual({
      missingCarrierLinks: 1,
      namedButUndeliverable: 0,
      suppressedTargets: 0,
      sample: [{ kind: 'missing-carrier-link', importerId: 'mod:facade', targetId: 'mod:target' }],
    });
    expect(report.nextActions.some(a => a.includes('sit 2 runtime-import-hops from consumer-scoped-risk nodes'))).toBe(true);
  });

  it('keeps carrierLinkGaps zeroed when no carrier advisory applies', () => {
    writeAnnotations(tmpDir, {
      'mod:facade': annotation('mod:facade', 'Facade summary', {
        integrationPoints: 'authoritative gate in mod:target',
      }),
      'mod:target': annotation('mod:target', 'Target summary', {
        risks: [{ text: 'importer must verify gate locally', scope: 'consumer' }],
      }),
    });
    const store = AnnotationStore.createSync(tmpDir);
    const graph = makeValidateGraph(['mod:facade', 'mod:mid', 'mod:target']);
    addEdge(graph, 'mod:facade', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:target', 'imports');
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date().toISOString(),
      packages: [],
      modules: ['mod:facade', 'mod:mid', 'mod:target'].map(makeMod),
    };

    const report = validateAnnotationHealth({ repoRoot: tmpDir, graph, snapshot, annotations: store });

    expect(report.carrierLinkGaps).toEqual({
      missingCarrierLinks: 0,
      namedButUndeliverable: 0,
      suppressedTargets: 0,
      sample: [],
    });
    expect(report.status).toBe('clean');
  });

  it('suppresses reviewed targets from carrier gaps and keeps the advisory auditable', () => {
    const targetAnnotation = annotation('mod:target', 'Target summary', {
      risks: [{ text: 'importer must verify gate locally', scope: 'consumer' }],
    });
    writeAnnotations(tmpDir, {
      'mod:facade': annotation('mod:facade', 'Facade summary'),
      'mod:target': targetAnnotation,
    });
    writeCarrierReviewFile(tmpDir, {
      version: 1,
      reviewedTargets: {
        'mod:target': {
          riskHash: carrierTargetRiskHash(targetAnnotation.annotation),
          decidedAt: '2026-07-13T00:00:00.000Z',
          reason: 'direct importers already flagged 1-hop',
        },
      },
    });
    const store = AnnotationStore.createSync(tmpDir);
    const graph = makeValidateGraph(['mod:facade', 'mod:mid', 'mod:target']);
    addEdge(graph, 'mod:facade', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:target', 'imports');
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date().toISOString(),
      packages: [],
      modules: ['mod:facade', 'mod:mid', 'mod:target'].map(makeMod),
    };

    const report = validateAnnotationHealth({ repoRoot: tmpDir, graph, snapshot, annotations: store });

    expect(report.carrierLinkGaps).toEqual({
      missingCarrierLinks: 0,
      namedButUndeliverable: 0,
      suppressedTargets: 1,
      sample: [],
    });
    // Fail-loud gate: a fully-suppressed repo still emits the advisory with the suppressed clause.
    const advisory = report.nextActions.find(a => a.includes('sit 2 runtime-import-hops'));
    expect(advisory).toContain('Advisory: 0 candidate importer(s)');
    expect(advisory).toContain('(1 reviewed target(s) suppressed.)');
    expect(report.status).toBe('clean');
  });

  it('re-surfaces suppressed targets when the consumer risk set changed after review', () => {
    writeAnnotations(tmpDir, {
      'mod:facade': annotation('mod:facade', 'Facade summary'),
      'mod:target': annotation('mod:target', 'Target summary', {
        risks: [{ text: 'importer must verify gate locally', scope: 'consumer' }],
      }),
    });
    writeCarrierReviewFile(tmpDir, {
      version: 1,
      reviewedTargets: {
        'mod:target': {
          riskHash: carrierTargetRiskHash({ summary: 'old', risks: [{ text: 'old gate', scope: 'consumer' }] }),
          decidedAt: '2026-07-13T00:00:00.000Z',
        },
      },
    });
    const store = AnnotationStore.createSync(tmpDir);
    const graph = makeValidateGraph(['mod:facade', 'mod:mid', 'mod:target']);
    addEdge(graph, 'mod:facade', 'mod:mid', 'imports');
    addEdge(graph, 'mod:mid', 'mod:target', 'imports');
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: tmpDir,
      timestamp: new Date().toISOString(),
      packages: [],
      modules: ['mod:facade', 'mod:mid', 'mod:target'].map(makeMod),
    };

    const report = validateAnnotationHealth({ repoRoot: tmpDir, graph, snapshot, annotations: store });

    expect(report.carrierLinkGaps).toEqual({
      missingCarrierLinks: 1,
      namedButUndeliverable: 0,
      suppressedTargets: 0,
      sample: [{ kind: 'missing-carrier-link', importerId: 'mod:facade', targetId: 'mod:target' }],
    });
  });
});
