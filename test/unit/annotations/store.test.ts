/**
 * Tests for AnnotationStore — CRUD, file lock, stale lock recovery.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { jest } from '@jest/globals';
import { AnnotationStore } from '../../../src/annotations/store.js';
import {
  getResourceContentHashForServiceId,
  resolveServiceResourceContentHash,
} from '../../../src/annotations/service-resource-hash.js';
import { AnnotationFileLockTimeoutError } from '../../../src/annotations/file-lock.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../../../src/config.js';
import { ANNOTATIONS_FILENAME } from '../../../src/paths.js';
import type { GraphEdge, GraphNode, ModuleInfo, RepositoryGraph, StoredAnnotation, RepositoryFactsSnapshot, TemplateFileInfo, InfraModuleInfo } from '../../../src/types.js';

function makeAnnotation(nodeId: string, hash = 'hash1', nodeType: StoredAnnotation['nodeType'] = 'module'): StoredAnnotation {
  return {
    nodeId,
    nodeType,
    contentHash: hash,
    pass: 1,
    updatedAt: new Date().toISOString(),
    annotation: { summary: 'Test annotation for ' + nodeId },
    schemaVersion: 2,
  };
}

function makeGraph(nodes: GraphNode[], edges: GraphEdge[]): RepositoryGraph {
  const nodeMap = new Map<string, GraphNode>();
  const outEdges = new Map<string, GraphEdge[]>();
  const inEdges = new Map<string, GraphEdge[]>();
  const byType = new Map<GraphNode['type'], Set<string>>();

  for (const node of nodes) {
    nodeMap.set(node.id, node);
    if (!byType.has(node.type)) byType.set(node.type, new Set());
    byType.get(node.type)!.add(node.id);
  }

  for (const edge of edges) {
    if (!outEdges.has(edge.from)) outEdges.set(edge.from, []);
    outEdges.get(edge.from)!.push(edge);
    if (!inEdges.has(edge.to)) inEdges.set(edge.to, []);
    inEdges.get(edge.to)!.push(edge);
  }

  return { nodes: nodeMap, edges, outEdges, inEdges, byType };
}

function makeMod(id: string, contentHash = `${id}:hash`): ModuleInfo {
  const relativeFilePath = `${id.replace(/^mod:/, '')}.ts`;
  return {
    id,
    packageName: 'test',
    filePath: `/repo/${relativeFilePath}`,
    relativeFilePath,
    contentHash,
    imports: [],
    exports: [{
      name: id.replace(/^mod:/, ''),
      kind: 'function',
      lineRange: { start: 1, end: 10 },
      isDefault: false,
    }],
  };
}

function makeTemplate(relPath: string, contentHash = `${relPath}:hash`): TemplateFileInfo {
  return {
    id: `template:${relPath}`,
    relPath,
    contentHash,
  };
}

function makeSnapshot(modules: ModuleInfo[], templates: TemplateFileInfo[] = []): RepositoryFactsSnapshot {
  return {
    repoRoot: '/repo',
    timestamp: new Date().toISOString(),
    packages: [],
    modules,
    ...(templates.length > 0 ? { templates } : {}),
  };
}

describe('AnnotationStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-store-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('basic CRUD', () => {
    it('set/get round-trips annotation', () => {
      const store = AnnotationStore.createSync(tmpDir);
      const ann = makeAnnotation('mod:test/foo');
      store.set('mod:test/foo', ann);
      expect(store.get('mod:test/foo')).toEqual(ann);
    });

    it('isFresh returns true when hash matches', () => {
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:x', makeAnnotation('mod:x', 'abc'));
      expect(store.isFresh('mod:x', 'abc')).toBe(true);
    });

    it('isFresh returns false when hash differs', () => {
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:x', makeAnnotation('mod:x', 'abc'));
      expect(store.isFresh('mod:x', 'different')).toBe(false);
    });

    it('isFresh returns false for unknown node', () => {
      const store = AnnotationStore.createSync(tmpDir);
      expect(store.isFresh('mod:nonexistent', 'any')).toBe(false);
    });

    it('delete removes annotations', () => {
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:a', makeAnnotation('mod:a'));
      store.set('mod:b', makeAnnotation('mod:b'));
      const deleted = store.delete(['mod:a']);
      expect(deleted).toBe(1);
      expect(store.get('mod:a')).toBeUndefined();
      expect(store.get('mod:b')).toBeDefined();
    });
  });

  describe('persistence', () => {
    it('flush writes to disk and reloads correctly', () => {
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:persisted', makeAnnotation('mod:persisted'));
      store.flush();

      const filePath = path.join(tmpDir, ANNOTATIONS_FILENAME);
      expect(fs.existsSync(filePath)).toBe(true);

      const store2 = AnnotationStore.createSync(tmpDir);
      expect(store2.get('mod:persisted')).toBeDefined();
      expect(store2.get('mod:persisted')?.annotation.summary).toContain('mod:persisted');
    });

    it('writes compact one-record-per-line disk format and hydrates omitted fields on reload', () => {
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:compact', {
        nodeId: 'mod:compact',
        nodeType: 'module',
        contentHash: 'compact-hash',
        pass: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        annotation: {
          summary: 'Compact annotation',
          assumptions: ['Defaults are inferred from the record key.'],
        },
        schemaVersion: 1,
      });
      store.flush();

      const filePath = path.join(tmpDir, ANNOTATIONS_FILENAME);
      const text = fs.readFileSync(filePath, 'utf-8');
      expect(text).toContain('"mod:compact": {"contentHash":"compact-hash"');
      const raw = JSON.parse(text) as { annotations: Record<string, Record<string, unknown>> };
      expect(raw.annotations['mod:compact'].nodeId).toBeUndefined();
      expect(raw.annotations['mod:compact'].nodeType).toBeUndefined();
      expect(raw.annotations['mod:compact'].pass).toBeUndefined();
      expect(raw.annotations['mod:compact'].schemaVersion).toBeUndefined();

      const store2 = AnnotationStore.createSync(tmpDir);
      const loaded = store2.get('mod:compact');
      expect(loaded?.nodeId).toBe('mod:compact');
      expect(loaded?.nodeType).toBe('module');
      expect(loaded?.pass).toBe(1);
      expect(loaded?.schemaVersion).toBe(1);
    });

    it('loads legacy full entries and rewrites them into compact disk shape', () => {
      const filePath = path.join(tmpDir, ANNOTATIONS_FILENAME);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        annotations: {
          'mod:legacy': {
            nodeId: 'mod:legacy',
            nodeType: 'module',
            contentHash: 'legacy-hash',
            pass: 1,
            updatedAt: '2026-01-01T00:00:00.000Z',
            annotation: { summary: 'Legacy annotation' },
            schemaVersion: 1,
          },
        },
      }, null, 2));

      const store = AnnotationStore.createSync(tmpDir);
      expect(store.get('mod:legacy')?.annotation.summary).toBe('Legacy annotation');
      store.flush();

      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { annotations: Record<string, Record<string, unknown>> };
      expect(raw.annotations['mod:legacy'].nodeId).toBeUndefined();
      expect(raw.annotations['mod:legacy'].nodeType).toBeUndefined();
      expect(raw.annotations['mod:legacy'].pass).toBeUndefined();
      expect(raw.annotations['mod:legacy'].schemaVersion).toBeUndefined();
    });

    it('starts empty when file does not exist', () => {
      const store = AnnotationStore.createSync(tmpDir);
      expect(Object.keys(store.getAll())).toHaveLength(0);
    });

    it('handles corrupted file gracefully', () => {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, ANNOTATIONS_FILENAME), '{corrupted data!!!');
      const store = AnnotationStore.createSync(tmpDir);
      expect(Object.keys(store.getAll())).toHaveLength(0);
    });
  });

  describe('durable persistence — no data loss on write', () => {
    const filePath = () => path.join(tmpDir, ANNOTATIONS_FILENAME);
    const readRaw = () => JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as { annotations: Record<string, unknown> };

    function writeRawFile(annotations: Record<string, unknown>): void {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(filePath(), JSON.stringify({ version: 1, annotations }, null, 2));
    }

    // A schema-invalid entry (empty sideEffects array is rejected by AnnotationContentSchema).
    function makeInvalidRaw(nodeId: string): Record<string, unknown> {
      return {
        nodeId,
        nodeType: 'module',
        contentHash: 'h',
        pass: 1,
        updatedAt: new Date().toISOString(),
        annotation: { summary: 'invalid entry ' + nodeId, sideEffects: [] },
        schemaVersion: 2,
      };
    }

    it('quarantines schema-invalid entries instead of dropping them, and preserves them on save', () => {
      writeRawFile({
        'mod:valid': makeAnnotation('mod:valid'),
        'mod:invalid': makeInvalidRaw('mod:invalid'),
      });

      const store = AnnotationStore.createSync(tmpDir);
      // Invalid entry is hidden from queries…
      expect(store.get('mod:invalid')).toBeUndefined();
      expect(store.get('mod:valid')).toBeDefined();

      // …but a subsequent write must NOT erase it from disk.
      store.set('mod:new', makeAnnotation('mod:new'));
      store.flush();

      const after = readRaw();
      expect(after.annotations['mod:invalid']).toBeDefined();
      expect(after.annotations['mod:valid']).toBeDefined();
      expect(after.annotations['mod:new']).toBeDefined();
    });

    it('refuses a write after a failed sync load and backs up the original corrupt bytes once', () => {
      const corrupt = '{not valid annotation json';
      fs.writeFileSync(filePath(), corrupt);
      const store = AnnotationStore.createSync(tmpDir);

      expect(store.getMergeStatusSnapshot().parseOk).toBe(false);
      expect(() => store.set('mod:new', makeAnnotation('mod:new')))
        .toThrow(/Refusing to write .*loaded contents are invalid/);
      expect(store.get('mod:new')).toBeUndefined();
      expect(fs.readFileSync(filePath(), 'utf-8')).toBe(corrupt);

      const backups = fs.readdirSync(tmpDir).filter(name => (
        name.startsWith('annotations.backup.') && name.endsWith('.json')
      ));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf-8')).toBe(corrupt);

      expect(() => store.flush()).toThrow(/Refusing to write/);
      expect(fs.readdirSync(tmpDir).filter(name => name.startsWith('annotations.backup.'))).toHaveLength(1);
      expect(fs.readFileSync(filePath(), 'utf-8')).toBe(corrupt);
    });

    it('refuses an async flush after a failed load and preserves a backup of the corrupt file', async () => {
      const corrupt = '{still not valid annotation json';
      fs.writeFileSync(filePath(), corrupt);
      const store = await AnnotationStore.create(tmpDir);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        await expect(store.flushAsync()).rejects.toThrow(/Refusing to write/);

        const backups = fs.readdirSync(tmpDir).filter(name => (
          name.startsWith('annotations.backup.') && name.endsWith('.json')
        ));
        expect(backups).toHaveLength(1);
        expect(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf-8')).toBe(corrupt);
        expect(fs.readFileSync(filePath(), 'utf-8')).toBe(corrupt);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('save blocked'));
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('does not duplicate the failed-load backup across store instances', () => {
      const corrupt = '{not valid annotation json';
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(filePath(), corrupt);

      const store1 = AnnotationStore.createSync(tmpDir);
      expect(() => store1.set('mod:new', makeAnnotation('mod:new'))).toThrow(/Refusing to write/);
      const store2 = AnnotationStore.createSync(tmpDir);
      expect(() => store2.set('mod:new', makeAnnotation('mod:new'))).toThrow(/Refusing to write/);

      const backups = () => fs.readdirSync(tmpDir).filter(name => (
        name.startsWith('annotations.backup.') && name.endsWith('.json')
      ));
      expect(backups()).toHaveLength(1);

      // Different corrupt content is a new incident and gets its own backup.
      fs.writeFileSync(filePath(), corrupt + ' changed');
      const store3 = AnnotationStore.createSync(tmpDir);
      expect(() => store3.set('mod:new', makeAnnotation('mod:new'))).toThrow(/Refusing to write/);
      expect(backups()).toHaveLength(2);
    });

    it('backs up a conflicted file once across repeated reload cycles', async () => {
      writeRawFile({ 'mod:valid': makeAnnotation('mod:valid') });
      const store = await AnnotationStore.create(tmpDir);

      const conflicted = '<<<<<<< HEAD\n{"version":1,"annotations":{}}\n=======\n{"version":1,"annotations":{}}\n>>>>>>> feature\n';
      fs.writeFileSync(filePath(), conflicted);

      await store.reloadFromDisk();
      expect(() => store.set('mod:new', makeAnnotation('mod:new'))).toThrow(/Refusing to write/);
      await store.reloadFromDisk();
      expect(() => store.set('mod:other', makeAnnotation('mod:other'))).toThrow(/Refusing to write/);

      const backups = fs.readdirSync(tmpDir).filter(name => (
        name.startsWith('annotations.backup.') && name.endsWith('.json')
      ));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf-8')).toBe(conflicted);
    });

    it('does not clobber entries written by an external process after load (merge-on-write)', () => {
      writeRawFile({ 'mod:valid': makeAnnotation('mod:valid') });
      const store = AnnotationStore.createSync(tmpDir);

      // Simulate another writer growing the file after this store loaded it.
      const ext = readRaw();
      ext.annotations['mod:external'] = makeAnnotation('mod:external') as unknown;
      fs.writeFileSync(filePath(), JSON.stringify({ version: 1, annotations: ext.annotations }, null, 2));

      // Our store writes its own delta and flushes.
      store.set('mod:mine', makeAnnotation('mod:mine'));
      store.flush();

      const after = readRaw();
      expect(after.annotations['mod:external']).toBeDefined(); // external entry survived
      expect(after.annotations['mod:valid']).toBeDefined();
      expect(after.annotations['mod:mine']).toBeDefined();
    });

    it('removes an entry only via explicit delete()', () => {
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:a', makeAnnotation('mod:a'));
      store.set('mod:b', makeAnnotation('mod:b'));
      store.flush();

      store.delete(['mod:a']);
      store.flush();

      const after = readRaw();
      expect(after.annotations['mod:a']).toBeUndefined();
      expect(after.annotations['mod:b']).toBeDefined();
    });

    it('writes atomically and leaves no temp file behind', () => {
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:x', makeAnnotation('mod:x'));
      store.flush();
      const leftovers = fs.readdirSync(tmpDir).filter(f => f.includes('.tmp.'));
      expect(leftovers).toHaveLength(0);
    });

    it('creates a backup when a write would shrink the file by >5%', () => {
      const store = AnnotationStore.createSync(tmpDir);
      for (let i = 0; i < 30; i++) store.set(`mod:${i}`, makeAnnotation(`mod:${i}`));
      store.flush();

      store.delete(Array.from({ length: 25 }, (_, i) => `mod:${i}`));
      store.flush();

      const backups = fs.readdirSync(tmpDir).filter(f => f.startsWith('annotations.backup.') && f.endsWith('.json'));
      expect(backups.length).toBeGreaterThan(0);
    });
  });

  describe('async factory', () => {
    it('create loads existing annotations', async () => {
      const store1 = AnnotationStore.createSync(tmpDir);
      store1.set('mod:async-test', makeAnnotation('mod:async-test'));
      store1.flush();

      const store2 = await AnnotationStore.create(tmpDir);
      expect(store2.get('mod:async-test')).toBeDefined();
    });
  });

  describe('file lock', () => {
    it('concurrent flushAsync calls use the async lock path without corrupting data', async () => {
      const store = await AnnotationStore.create(tmpDir);
      store.set('mod:a', makeAnnotation('mod:a'));
      store.set('mod:b', makeAnnotation('mod:b'));

      // Trigger multiple async flush cycles concurrently.
      const promises = Array.from({ length: 5 }, async (_, i) => {
        store.set(`mod:concurrent-${i}`, makeAnnotation(`mod:concurrent-${i}`));
        await store.flushAsync();
      });
      await Promise.all(promises);

      // Reload and verify no corruption
      const store2 = AnnotationStore.createSync(tmpDir);
      expect(store2.get('mod:a')).toBeDefined();
      expect(store2.get('mod:b')).toBeDefined();
      for (let i = 0; i < 5; i++) {
        expect(store2.get(`mod:concurrent-${i}`)).toBeDefined();
      }
      expect(fs.existsSync(path.join(tmpDir, `${ANNOTATIONS_FILENAME}.lock`))).toBe(false);
    });

    it('stale lock file (>10s old) is automatically removed', () => {
      const lockPath = path.join(tmpDir, `${ANNOTATIONS_FILENAME}.lock`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(lockPath, '99999');
      // Backdate the lock file mtime to 15 seconds ago
      const staleTime = new Date(Date.now() - 15_000);
      fs.utimesSync(lockPath, staleTime, staleTime);

      // Should succeed despite existing lock (stale detection)
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:after-stale', makeAnnotation('mod:after-stale'));
      store.flush();

      expect(fs.existsSync(path.join(tmpDir, ANNOTATIONS_FILENAME))).toBe(true);
      // Lock file should be cleaned up
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('lock file is cleaned up after normal flush', () => {
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:lock-cleanup', makeAnnotation('mod:lock-cleanup'));
      store.flush();

      const lockPath = path.join(tmpDir, `${ANNOTATIONS_FILENAME}.lock`);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('readers can load the last committed file while a writer lock exists', () => {
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:committed', makeAnnotation('mod:committed'));
      store.flush();

      const lockPath = path.join(tmpDir, `${ANNOTATIONS_FILENAME}.lock`);
      fs.writeFileSync(lockPath, String(process.pid));
      try {
        const reader = AnnotationStore.createSync(tmpDir);
        expect(reader.get('mod:committed')?.annotation.summary).toContain('mod:committed');
      } finally {
        fs.rmSync(lockPath, { force: true });
      }
    });

    it('retries a debounced save on lock timeout and surfaces a persistent failure', async () => {
      const store = AnnotationStore.createSync(tmpDir);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let attempts = 0;
      const saveAsyncSpy = jest
        .spyOn(store as unknown as { saveAsync(): Promise<void> }, 'saveAsync')
        .mockImplementation(async () => {
          attempts++;
          throw new AnnotationFileLockTimeoutError('/repo/annots.lock');
        });
      jest.useFakeTimers();

      try {
        // The shared save routine retries then throws on final failure (awaiting callers learn the outcome).
        const run = (store as unknown as { runSaveWithRetry(): Promise<void> }).runSaveWithRetry();
        const settled = run.then(() => 'resolved').catch(() => 'rejected');
        // Drive the two inter-attempt back-off delays (SAVE_DEBOUNCE_MS * attempt = 800ms, 1600ms).
        await jest.advanceTimersByTimeAsync(800);
        await jest.advanceTimersByTimeAsync(1600);

        // Lock timeouts are transient IO — retried up to MAX_SAVE_RETRIES (3), then surfaced.
        expect(await settled).toBe('rejected');
        expect(attempts).toBe(3);
        expect(store.lastSaveError).toContain('Timed out');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('save FAILED after 3 attempts'));
      } finally {
        jest.useRealTimers();
        saveAsyncSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  describe('save lifecycle (delta-scoped commit)', () => {
    type FinalizeWrite = { finalizeWrite(r: Record<string, unknown>, merged: boolean, g: Map<string, number>): void };
    type OpGen = { opGen: Map<string, number> };
    type Touched = { touched: Set<string> };

    // Guards the NEW-key set()-during-save wipe: a write for a key absent from the composed snapshot must
    // survive ingestRaw and stay pending. Mutation-verified: red against the old whole-record finalizeWrite.
    it('preserves a new write that lands during an in-flight merged save', () => {
      const store = AnnotationStore.createSync(tmpDir);
      const capturedGen = new Map((store as unknown as OpGen).opGen); // composed with nothing touched
      const during = makeAnnotation('mod:during');
      store.set('mod:during', during); // arrives after compose — newer than capturedGen

      const finalRaw: Record<string, unknown> = { 'mod:already': makeAnnotation('mod:already') };
      (store as unknown as FinalizeWrite).finalizeWrite(finalRaw, true, capturedGen);

      expect(store.get('mod:during')?.annotation.summary).toBe(during.annotation.summary);
      expect(store.get('mod:already')).toBeDefined();
      expect((store as unknown as Touched).touched.has('mod:during')).toBe(true);
    });

    // Guards the SAME-node re-write during a merged save (finding #2): a Set<nodeId> cannot tell a re-write
    // from the original, so the generation gate is required. Mutation-verified: red with a Set-only check.
    it('keeps a same-node re-write that changed during an in-flight merged save (generation gate)', () => {
      const store = AnnotationStore.createSync(tmpDir);
      const v1 = makeAnnotation('mod:x');
      v1.annotation.summary = 'version one summary text';
      store.set('mod:x', v1);
      const capturedGen = new Map((store as unknown as OpGen).opGen); // snapshot as at compose (v1 gen)

      const v2 = makeAnnotation('mod:x');
      v2.annotation.summary = 'version two summary text';
      store.set('mod:x', v2); // re-set during the "await" — newer generation

      // finalRaw was composed with v1 (before the re-set).
      const finalRaw: Record<string, unknown> = { 'mod:x': v1 };
      (store as unknown as FinalizeWrite).finalizeWrite(finalRaw, true, capturedGen);

      // v2 must survive (not reverted to v1) and mod:x stays pending for the follow-up save.
      expect(store.get('mod:x')?.annotation.summary).toBe('version two summary text');
      expect((store as unknown as Touched).touched.has('mod:x')).toBe(true);
    });

    it('sync flush() throws fast instead of stalling when an async save is in flight', async () => {
      const store = AnnotationStore.createSync(tmpDir);
      (store as unknown as { asyncSaveInFlight: boolean }).asyncSaveInFlight = true;
      expect(() => store.flush()).toThrow(/async save is in flight/);
    });

    // A failed flushAsync (e.g. durable write) must surface the error AND re-arm the debounce it cancelled,
    // so the pending write is retried later instead of stranded in memory with no scheduled save.
    it('re-arms the debounce and records lastSaveError when flushAsync fails', async () => {
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:a', makeAnnotation('mod:a'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const saveAsyncSpy = jest
        .spyOn(store as unknown as { saveAsync(): Promise<void> }, 'saveAsync')
        .mockImplementation(async () => { throw new Error('disk full'); });
      jest.useFakeTimers();

      try {
        const settled = store.flushAsync().then(() => 'resolved').catch(() => 'rejected');
        await jest.advanceTimersByTimeAsync(800);
        await jest.advanceTimersByTimeAsync(1600);

        expect(await settled).toBe('rejected');
        expect(store.lastSaveError).toContain('disk full');
        // Pending write is re-scheduled, not stranded.
        expect((store as unknown as { saveTimer: unknown }).saveTimer).not.toBeNull();
      } finally {
        const timer = (store as unknown as { saveTimer: ReturnType<typeof setTimeout> | null }).saveTimer;
        if (timer) clearTimeout(timer);
        jest.useRealTimers();
        saveAsyncSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('fails closed when the file changed externally to an unreadable/conflicted state', async () => {
      const p = path.join(tmpDir, ANNOTATIONS_FILENAME);
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:a', makeAnnotation('mod:a'));
      store.flush(); // clean baseline captured

      // An external writer (git merge) leaves conflict markers on disk AFTER our load/flush.
      const conflicted = '<<<<<<< HEAD\n{"version":1,"annotations":{}}\n=======\n{}\n>>>>>>> branch\n';
      fs.writeFileSync(p, conflicted);

      store.set('mod:b', makeAnnotation('mod:b'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        // The save refuses rather than overwrite their bytes with our memory.
        await expect(store.flushAsync()).rejects.toThrow(/changed externally and is now unreadable/);
        expect(fs.readFileSync(p, 'utf-8')).toBe(conflicted); // their bytes intact
        expect(store.get('mod:b')).toBeDefined();               // our delta is not lost
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('save FAILED after 3 attempts'));
      } finally {
        errorSpy.mockRestore();
      }
    });

    // A well-formed-JSON file with an INVALID annotations shape must also fail closed on save — accepting
    // it as an empty set would overwrite the external bytes. Mutation-verified against a lax shape check.
    it('fails closed on save when the external file has a valid-JSON but invalid annotations shape', async () => {
      const p = path.join(tmpDir, ANNOTATIONS_FILENAME);
      const store = AnnotationStore.createSync(tmpDir);
      store.set('mod:a', makeAnnotation('mod:a'));
      store.flush(); // clean baseline captured

      const invalid = '{"version":1,"annotations":"THEIRS"}'; // parses as JSON, not a valid annotations file
      fs.writeFileSync(p, invalid);

      store.set('mod:b', makeAnnotation('mod:b'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await expect(store.flushAsync()).rejects.toThrow(/changed externally and is now unreadable/);
        expect(fs.readFileSync(p, 'utf-8')).toBe(invalid); // external bytes intact, not overwritten
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('save FAILED after 3 attempts'));
      } finally {
        errorSpy.mockRestore();
      }
    });

    // C1 guard: two writers to the SAME node changing DIFFERENT fields must not clobber each other.
    // Mutation-verified: red with the old whole-record touched overlay.
    it('field-level merge keeps a concurrent writer\'s other fields on the same node', () => {
      const base = makeAnnotation('mod:shared');
      const withFields = (fields: Record<string, unknown>) => ({
        ...base,
        pass: 2,
        annotation: { summary: base.annotation.summary, ...fields },
      } as unknown as Parameters<AnnotationStore['set']>[1]);

      const storeA = AnnotationStore.createSync(tmpDir);
      storeA.set('mod:shared', base);
      storeA.flush(); // disk: { summary }

      // Process B loads the base and adds `invariants`.
      const storeB = AnnotationStore.createSync(tmpDir);
      storeB.set('mod:shared', withFields({ invariants: ['B-invariant'] }), ['invariants']);
      storeB.flush(); // disk: { summary, invariants }

      // Process A (loaded before B's write) adds `risks` — must not clobber B's invariants.
      storeA.set('mod:shared', withFields({ risks: ['A-risk'] }), ['risks']);
      storeA.flush();

      const storeC = AnnotationStore.createSync(tmpDir);
      const merged = storeC.get('mod:shared')!.annotation as unknown as Record<string, unknown>;
      expect(merged.summary).toBeDefined();
      expect(merged.invariants).toEqual(['B-invariant']); // survived A's write
      expect(merged.risks).toEqual(['A-risk']);           // A's field applied
    });
  });

  describe('reloadFromDisk', () => {
    const annPath = () => path.join(tmpDir, ANNOTATIONS_FILENAME);
    const writeExternal = (annotations: Record<string, unknown>) =>
      fs.writeFileSync(annPath(), JSON.stringify({ version: 1, annotations }, null, 2));

    // Never-drop (19b5491 guarantee): a persisted key absent from an externally-replaced file survives.
    // Mutation-verified: red if reload wholesale-replaces this.data from disk.
    it('keeps an in-memory annotation the external file no longer has', async () => {
      const store = await AnnotationStore.create(tmpDir);
      store.set('mod:held', makeAnnotation('mod:held'));
      await store.flushAsync(); // persisted; no longer touched

      writeExternal({ 'mod:other': makeAnnotation('mod:other') }); // external file drops mod:held
      await store.reloadFromDisk();

      expect(store.get('mod:held')).toBeDefined();  // never dropped
      expect(store.get('mod:other')).toBeDefined(); // external addition surfaced
    });

    // Field-merge a pending local change over an external add, rather than clobbering with the whole record.
    it('field-merges a pending write over an external field add during reload', async () => {
      const base = makeAnnotation('mod:shared');
      const store = await AnnotationStore.create(tmpDir);
      store.set('mod:shared', base);
      await store.flushAsync();

      // Pending local change to `risks`, not yet flushed.
      store.set('mod:shared', {
        ...base,
        annotation: { summary: base.annotation.summary, risks: ['local-risk'] },
      } as unknown as Parameters<AnnotationStore['set']>[1], ['risks']);

      // External writer added `invariants` to the same node.
      writeExternal({
        'mod:shared': { ...base, annotation: { summary: base.annotation.summary, invariants: ['ext-invariant'] } },
      });
      await store.reloadFromDisk();

      const merged = store.get('mod:shared')!.annotation as unknown as Record<string, unknown>;
      expect(merged.risks).toEqual(['local-risk']);        // our pending field survived
      expect(merged.invariants).toEqual(['ext-invariant']); // external field surfaced
    });

    // Fail-closed on an invalid external shape (not just bad JSON): keep memory, block writes.
    it('fails closed on an invalid external file shape', async () => {
      const store = await AnnotationStore.create(tmpDir);
      store.set('mod:a', makeAnnotation('mod:a'));
      await store.flushAsync();

      fs.writeFileSync(annPath(), '{"version":1,"annotations":"THEIRS"}'); // well-formed JSON, invalid shape
      await store.reloadFromDisk();

      expect(store.get('mod:a')).toBeDefined(); // in-memory state kept
      expect(() => store.set('mod:b', makeAnnotation('mod:b'))).toThrow(/Refusing to write/); // writes blocked
    });

    // H2: a refresh cancellation after disk IO must not publish the external snapshot into the shared
    // ready-store. The checkpoint-counting signal deterministically aborts at the post-read boundary.
    it('does not mutate live state when cancellation lands after the disk read', async () => {
      const store = await AnnotationStore.create(tmpDir);
      store.set('mod:live', makeAnnotation('mod:live'));
      store.set('mod:deleted', makeAnnotation('mod:deleted'));
      await store.flushAsync();

      store.set('mod:pending', makeAnnotation('mod:pending'));
      store.delete(['mod:deleted']);
      writeExternal({
        'mod:external': makeAnnotation('mod:external'),
        'mod:deleted': makeAnnotation('mod:deleted'),
      });

      let checkpoints = 0;
      const abortError = new DOMException('cancelled after disk read', 'AbortError');
      const signal = {
        throwIfAborted: () => {
          checkpoints++;
          if (checkpoints === 3) throw abortError;
        },
      } as unknown as AbortSignal;

      await expect(store.reloadFromDisk({ signal })).rejects.toBe(abortError);
      expect(checkpoints).toBe(3); // entered the lock and completed the read
      expect(store.get('mod:live')).toBeDefined();
      expect(store.get('mod:pending')).toBeDefined(); // local uncommitted delta survived
      expect(store.get('mod:deleted')).toBeUndefined(); // local uncommitted delete survived
      expect(store.get('mod:external')).toBeUndefined(); // cancelled disk snapshot was not published

      // Cancellation also restores persistence for the pending delta; the next flush still merges the
      // external writer rather than clobbering it.
      await store.flushAsync();
      const reloaded = await AnnotationStore.create(tmpDir);
      expect(reloaded.get('mod:live')).toBeDefined();
      expect(reloaded.get('mod:pending')).toBeDefined();
      expect(reloaded.get('mod:deleted')).toBeUndefined();
      expect(reloaded.get('mod:external')).toBeDefined();
    });
  });

  describe('annotation queue ordering', () => {
    it('orders first-run annotations bottom-up: dependencies before importers, domains last', () => {
      const store = AnnotationStore.createSync(tmpDir);
      const moduleIds = [
        'mod:leaf',
        'mod:barrel',
        'mod:featureA',
        'mod:featureB',
        'mod:entrypoint',
      ];
      const nodes: GraphNode[] = [
        ...moduleIds.map(id => ({ id, type: 'module' as const, label: id.replace(/^mod:/, ''), description: '' })),
        { id: 'template:app/templates/home.html', type: 'template', label: 'home.html', description: '' },
        { id: 'domain:feature', type: 'domain', label: 'feature', description: '' },
        { id: 'domain:feature/sub', type: 'domain', label: 'feature/sub', description: '' },
      ];
      const imports: GraphEdge[] = [
        // Imports point from importer to imported. The barrel has more downstream
        // consumers than leaf, but it still waits because it depends on leaf.
        { from: 'mod:barrel', to: 'mod:leaf', kind: 'imports' },
        { from: 'mod:featureA', to: 'mod:barrel', kind: 'imports' },
        { from: 'mod:featureB', to: 'mod:barrel', kind: 'imports' },
        { from: 'mod:entrypoint', to: 'mod:barrel', kind: 'imports' },
      ];
      const tags: GraphEdge[] = moduleIds.flatMap(id => [
        { from: id, to: 'domain:feature', kind: 'tagged' as const },
        { from: id, to: 'domain:feature/sub', kind: 'tagged' as const },
      ]);
      const graph = makeGraph(nodes, [...imports, ...tags]);
      const snapshot = makeSnapshot(moduleIds.map(id => makeMod(id)), [makeTemplate('app/templates/home.html')]);

      const queue = store.getQueue(graph, snapshot, { limit: 10 });
      const ids = queue.map(item => item.nodeId);

      expect(ids.indexOf('mod:leaf')).toBeLessThan(ids.indexOf('mod:barrel'));
      expect(ids.indexOf('mod:barrel')).toBeLessThan(ids.indexOf('mod:featureA'));
      expect(ids.indexOf('mod:barrel')).toBeLessThan(ids.indexOf('mod:featureB'));
      expect(ids.indexOf('mod:barrel')).toBeLessThan(ids.indexOf('mod:entrypoint'));
      expect(ids.indexOf('mod:entrypoint')).toBeLessThan(ids.indexOf('template:app/templates/home.html'));
      expect(ids.indexOf('template:app/templates/home.html')).toBeLessThan(ids.indexOf('domain:feature/sub'));
      expect(ids.indexOf('mod:entrypoint')).toBeLessThan(ids.indexOf('domain:feature/sub'));
      expect(ids.indexOf('domain:feature/sub')).toBeLessThan(ids.indexOf('domain:feature'));
      expect(queue.find(item => item.nodeId === 'mod:leaf')?.context.dependencyDepth).toBe(0);
      expect(queue.find(item => item.nodeId === 'mod:barrel')?.context.dependencyDepth).toBe(1);
      expect(queue.find(item => item.nodeId === 'domain:feature')?.context.annotationPhase).toBe('domain');
    });

    it('queues template nodes and marks template annotations fresh by contentHash', () => {
      const store = AnnotationStore.createSync(tmpDir);
      const graph = makeGraph([
        { id: 'template:app/templates/home.html', type: 'template', label: 'home.html', description: '' },
        { id: 'domain:ui', type: 'domain', label: 'ui', description: '' },
      ], [
        { from: 'template:app/templates/home.html', to: 'domain:ui', kind: 'tagged' },
      ]);
      const snapshot = makeSnapshot([], [makeTemplate('app/templates/home.html', 'tpl-h1')]);

      expect(store.getQueue(graph, snapshot, { limit: 10 })).toEqual([
        expect.objectContaining({
          nodeId: 'template:app/templates/home.html',
          moduleKind: 'template',
          context: expect.objectContaining({ annotationPhase: 'template' }),
        }),
        expect.objectContaining({ nodeId: 'domain:ui' }),
      ]);

      store.set('template:app/templates/home.html', makeAnnotation('template:app/templates/home.html', 'tpl-h1', 'template'));
      const stats = store.getStats(graph, snapshot);
      expect(stats.templates).toEqual({
        total: 1,
        annotated: 1,
        fresh: 1,
        stale: 0,
        unannotated: 0,
      });

      const staleSnapshot = makeSnapshot([], [makeTemplate('app/templates/home.html', 'tpl-h2')]);
      expect(store.getQueue(graph, staleSnapshot, { limit: 10 })[0]).toEqual(expect.objectContaining({
        nodeId: 'template:app/templates/home.html',
        status: 'stale',
        staleKind: 'content',
      }));
    });

    it('scanAnnotationHealth mirrors getQueue classification, ordering, counts, and sample', () => {
      const store = AnnotationStore.createSync(tmpDir);
      const moduleIds = ['mod:leaf', 'mod:barrel', 'mod:featureA', 'mod:featureB', 'mod:entrypoint'];
      const nodes: GraphNode[] = [
        ...moduleIds.map(id => ({ id, type: 'module' as const, label: id.replace(/^mod:/, ''), description: '' })),
        { id: 'template:app/templates/home.html', type: 'template', label: 'home.html', description: '' },
        { id: 'domain:feature', type: 'domain', label: 'feature', description: '' },
        { id: 'domain:feature/sub', type: 'domain', label: 'feature/sub', description: '' },
      ];
      const imports: GraphEdge[] = [
        { from: 'mod:barrel', to: 'mod:leaf', kind: 'imports' },
        { from: 'mod:featureA', to: 'mod:barrel', kind: 'imports' },
        { from: 'mod:featureB', to: 'mod:barrel', kind: 'imports' },
        { from: 'mod:entrypoint', to: 'mod:barrel', kind: 'imports' },
      ];
      const tags: GraphEdge[] = moduleIds.flatMap(id => [
        { from: id, to: 'domain:feature', kind: 'tagged' as const },
        { from: id, to: 'domain:feature/sub', kind: 'tagged' as const },
      ]);
      const graph = makeGraph(nodes, [...imports, ...tags]);
      const snapshot = makeSnapshot(moduleIds.map(id => makeMod(id)), [makeTemplate('app/templates/home.html')]);
      // One annotated-but-content-stale module; the rest unannotated.
      store.set('mod:leaf', makeAnnotation('mod:leaf', 'stale-hash'));

      const queue = store.getQueue(graph, snapshot, { limit: Number.MAX_SAFE_INTEGER });
      const scan = store.scanAnnotationHealth(graph, snapshot);

      // rows preserve getQueue's classification and priority ordering exactly.
      expect(scan.rows).toEqual(queue.map(item => ({
        nodeId: item.nodeId,
        status: item.status,
        ...(item.staleKind ? { staleKind: item.staleKind } : {}),
        phase: item.context.annotationPhase,
      })));

      // counts tally the same full queue.
      expect(scan.counts.needsWork).toBe(queue.length);
      expect(scan.counts.unannotated).toBe(queue.filter(i => i.status === 'unannotated').length);
      expect(scan.counts.staleContent).toBe(queue.filter(i => i.status === 'stale' && i.staleKind !== 'propagation').length);
      expect(scan.counts.stalePropagation).toBe(queue.filter(i => i.staleKind === 'propagation').length);
      expect(scan.counts.stale).toBe(scan.counts.staleContent + scan.counts.stalePropagation);

      // sample(K) is byte-identical to getQueue(limit:K) projected to the queueSample shape.
      const sampleShape = (item: typeof queue[number]) => ({
        nodeId: item.nodeId,
        status: item.status,
        ...(item.staleKind ? { staleKind: item.staleKind } : {}),
        moduleKind: item.moduleKind,
        reason: item.reason,
      });
      expect(scan.sample(3)).toEqual(store.getQueue(graph, snapshot, { limit: 3 }).map(sampleShape));

      // a scope predicate narrows the sample while preserving order.
      const scoped = scan.sample(10, row => row.nodeId.startsWith('mod:feature'));
      expect(scoped).toEqual(queue.filter(i => i.nodeId.startsWith('mod:feature')).map(sampleShape));
    });

    it('orders content-stale upstream before entrypoint-bounded propagation-stale downstream', () => {
      const store = AnnotationStore.createSync(tmpDir);
      const moduleIds = ['mod:leaf', 'mod:consumer', 'mod:side', 'mod:entrypoint'];
      const nodes: GraphNode[] = moduleIds.map(id => ({
        id,
        type: 'module' as const,
        label: id.replace(/^mod:/, ''),
        description: '',
      }));
      const imports: GraphEdge[] = [
        { from: 'mod:consumer', to: 'mod:leaf', kind: 'imports' },
        { from: 'mod:entrypoint', to: 'mod:consumer', kind: 'imports' },
        { from: 'mod:side', to: 'mod:leaf', kind: 'imports' },
      ];
      const graph = makeGraph(nodes, imports);
      const snapshot = makeSnapshot([
        makeMod('mod:leaf', 'h_leaf_v2'),
        makeMod('mod:consumer', 'h_consumer'),
        makeMod('mod:side', 'h_side'),
        makeMod('mod:entrypoint', 'h_entrypoint'),
      ]);

      store.set('mod:leaf', makeAnnotation('mod:leaf', 'h_leaf_v1'));
      store.set('mod:consumer', {
        ...makeAnnotation('mod:consumer', 'h_consumer'),
        importBaseline: { 'mod:leaf': 'h_leaf_v1' },
      });
      store.set('mod:side', {
        ...makeAnnotation('mod:side', 'h_side'),
        importBaseline: { 'mod:leaf': 'h_leaf_v1' },
      });
      store.set('mod:entrypoint', {
        ...makeAnnotation('mod:entrypoint', 'h_entrypoint'),
        importBaseline: { 'mod:consumer': 'h_consumer' },
      });

      const entrypoints = [{ kind: 'route', moduleId: 'mod:entrypoint', id: 'ep:entrypoint' }] as const;
      const options = {
        limit: Number.MAX_SAFE_INTEGER,
        propagation: { ...DEFAULT_PROPAGATION_CONFIG },
        entrypoints,
      };
      const queue = store.getQueue(graph, snapshot, options);
      const ids = queue.map(item => item.nodeId);

      expect(ids).toEqual(['mod:leaf', 'mod:consumer']);
      expect(queue[0]).toEqual(expect.objectContaining({
        nodeId: 'mod:leaf',
        status: 'stale',
        staleKind: 'content',
      }));
      expect(queue[1]).toEqual(expect.objectContaining({
        nodeId: 'mod:consumer',
        status: 'stale',
        staleKind: 'propagation',
        reason: expect.stringContaining('importBaseline stale'),
        context: expect.objectContaining({
          staleKind: 'propagation',
          upstreamTriggers: ['mod:leaf'],
        }),
      }));
      expect(ids).not.toContain('mod:side');

      const scan = store.scanAnnotationHealth(graph, snapshot, options);
      expect(scan.rows).toEqual([
        { nodeId: 'mod:leaf', status: 'stale', staleKind: 'content', phase: 'module' },
        { nodeId: 'mod:consumer', status: 'stale', staleKind: 'propagation', phase: 'module' },
      ]);
      expect(scan.counts).toEqual({
        needsWork: 2,
        stale: 2,
        staleContent: 1,
        stalePropagation: 1,
        unannotated: 0,
      });
      expect(store.getQueuePage(graph, snapshot, {
        ...options,
        staleKind: 'propagation',
      }).items).toEqual([queue[1]]);
    });

    it('queues infra modules and runtime resources using template and per-resource hashes', () => {
      const store = AnnotationStore.createSync(tmpDir);
      const infraId = 'infra:sam:template.yaml';
      const workerId = 'resource:aws-lambda:Worker';
      const infra: InfraModuleInfo = {
        id: infraId,
        kind: 'sam',
        filePath: '/repo/template.yaml',
        relativeFilePath: 'template.yaml',
        contentHash: 'template-v2',
        resources: [{
          id: 'Worker',
          kind: 'lambda',
          provider: 'aws',
          contentHash: 'worker-v2',
          attributes: { handler: 'src/worker.handler' },
        }],
      };
      const graph = makeGraph([
        { id: infraId, type: 'module', label: 'template.yaml', description: '' },
        {
          id: workerId,
          type: 'runtime-resource',
          label: 'Worker',
          description: '',
          data: { kind: 'lambda', provider: 'aws', contentHash: 'fallback-worker-v2' },
        },
        { id: 'domain:infra', type: 'domain', label: 'infra', description: '' },
      ], [
        { from: infraId, to: workerId, kind: 'contains' },
        { from: infraId, to: 'domain:infra', kind: 'tagged', metadata: { tagSource: 'package' } },
      ]);
      const snapshot = makeSnapshot([], []);
      snapshot.infraModules = [infra];

      store.set(infraId, makeAnnotation(infraId, 'template-v1'));
      store.set(workerId, makeAnnotation(workerId, 'worker-v1', 'runtime-resource'));

      const queue = store.getQueue(graph, snapshot, { domain: 'infra', limit: 10 });
      expect(queue).toEqual([
        expect.objectContaining({
          nodeId: workerId,
          status: 'stale',
          staleKind: 'content',
          moduleKind: 'runtime-resource',
          reason: 'IaC resource definition changed',
        }),
        expect.objectContaining({
          nodeId: infraId,
          status: 'stale',
          staleKind: 'content',
          moduleKind: 'infra',
          reason: 'IaC template content changed',
          context: expect.objectContaining({
            exportCount: 1,
            topExports: [{ name: 'Worker', kind: 'lambda' }],
          }),
        }),
      ]);

      const stats = store.getStats(graph, snapshot, { domainFilter: 'infra' });
      expect(stats.infraModules).toEqual({
        total: 1,
        annotated: 1,
        fresh: 0,
        stale: 1,
        unannotated: 0,
      });
      expect(stats.services).toEqual({
        total: 1,
        annotated: 1,
        fresh: 0,
        stale: 1,
        unannotated: 0,
      });
      expect(stats.byDomain.infra).toEqual({ total: 2, annotated: 2, fresh: 0 });
    });

    it('multi-declared runtime resource annotated with the write-path value stays fresh in queue and stats', () => {
      const store = AnnotationStore.createSync(tmpDir);
      const gatewayId = 'resource:aws-lambda:Gateway';
      const makeStack = (id: string, fileHash: string, resourceHash: string): InfraModuleInfo => ({
        id,
        kind: 'sam',
        filePath: `/repo/${id}.yaml`,
        relativeFilePath: `${id}.yaml`,
        contentHash: fileHash,
        resources: [{
          id: 'Gateway',
          kind: 'lambda',
          provider: 'aws',
          contentHash: resourceHash,
          attributes: { handler: 'src/gateway.handler' },
        }],
      });
      const stackA = makeStack('infra:sam:stack-a.yaml', 'file-a', 'decl-a');
      const stackB = makeStack('infra:sam:stack-b.yaml', 'file-b', 'decl-b');
      const graph = makeGraph([
        { id: stackA.id, type: 'module', label: 'stack-a.yaml', description: '' },
        { id: stackB.id, type: 'module', label: 'stack-b.yaml', description: '' },
        {
          id: gatewayId,
          type: 'runtime-resource',
          label: 'Gateway',
          description: '',
          data: { kind: 'lambda', provider: 'aws' },
        },
        { id: 'domain:infra', type: 'domain', label: 'infra', description: '' },
      ], [
        { from: stackA.id, to: gatewayId, kind: 'contains' },
        { from: stackB.id, to: gatewayId, kind: 'contains' },
        { from: stackA.id, to: 'domain:infra', kind: 'tagged', metadata: { tagSource: 'package' } },
        { from: stackB.id, to: 'domain:infra', kind: 'tagged', metadata: { tagSource: 'package' } },
      ]);
      const snapshot = makeSnapshot([], []);
      snapshot.infraModules = [stackA, stackB];

      const written = resolveServiceResourceContentHash(graph, snapshot, gatewayId)!;
      store.set(gatewayId, makeAnnotation(gatewayId, written, 'runtime-resource'));

      const queue = store.getQueue(graph, snapshot, { domain: 'infra', limit: 10 });
      expect(queue.some(item => item.nodeId === gatewayId)).toBe(false);
      expect(store.getStats(graph, snapshot, { domainFilter: 'infra' }).services).toEqual({
        total: 1,
        annotated: 1,
        fresh: 1,
        stale: 0,
        unannotated: 0,
      });

      const reversed = makeSnapshot([], []);
      reversed.infraModules = [stackB, stackA];
      expect(store.getStats(graph, reversed, { domainFilter: 'infra' }).services.fresh).toBe(1);
      expect(store.getQueue(graph, reversed, { domain: 'infra', limit: 10 }).some(item => item.nodeId === gatewayId)).toBe(false);
    });

    it('migrateServiceAnnotationHashesFromParentTemplate rewrites parent-hash records to the resolver value', () => {
      const store = AnnotationStore.createSync(tmpDir);
      const gatewayId = 'resource:aws-lambda:Gateway';
      const workerId = 'resource:aws-lambda:Worker';
      const makeStack = (id: string, fileHash: string, resourceId: string, resourceHash: string): InfraModuleInfo => ({
        id,
        kind: 'sam',
        filePath: `/repo/${id}.yaml`,
        relativeFilePath: `${id}.yaml`,
        contentHash: fileHash,
        resources: [{
          id: resourceId,
          kind: 'lambda',
          provider: 'aws',
          contentHash: resourceHash,
          attributes: { handler: `src/${resourceId}.handler` },
        }],
      });
      const stackA = makeStack('infra:sam:stack-a.yaml', 'file-a', 'Gateway', 'decl-a');
      const stackB = makeStack('infra:sam:stack-b.yaml', 'file-b', 'Gateway', 'decl-b');
      const stackC = makeStack('infra:sam:stack-c.yaml', 'file-c', 'Worker', 'worker-v2');
      const graph = makeGraph([
        { id: stackA.id, type: 'module', label: 'stack-a.yaml', description: '' },
        { id: stackB.id, type: 'module', label: 'stack-b.yaml', description: '' },
        { id: stackC.id, type: 'module', label: 'stack-c.yaml', description: '' },
        { id: gatewayId, type: 'runtime-resource', label: 'Gateway', description: '' },
        { id: workerId, type: 'runtime-resource', label: 'Worker', description: '' },
      ], [
        { from: stackA.id, to: gatewayId, kind: 'contains' },
        { from: stackB.id, to: gatewayId, kind: 'contains' },
        { from: stackC.id, to: workerId, kind: 'contains' },
      ]);
      const snapshot = makeSnapshot([], []);
      snapshot.infraModules = [stackA, stackB, stackC];

      // The migration gate consults only the first contains parent, so the legacy record must
      // carry stack-a's template hash; a record holding stack-b's hash would never migrate.
      store.set(gatewayId, makeAnnotation(gatewayId, 'file-a', 'runtime-resource'));
      store.set(workerId, makeAnnotation(workerId, 'file-c', 'runtime-resource'));

      expect(store.migrateServiceAnnotationHashesFromParentTemplate(graph, snapshot)).toBe(2);

      expect(store.get(workerId)?.contentHash).toBe('worker-v2');
      const setHash = getResourceContentHashForServiceId(snapshot, gatewayId)!;
      expect(store.get(gatewayId)?.contentHash).toBe(setHash);
      expect(setHash).not.toBe('decl-a');
      expect(setHash).not.toBe('decl-b');

      expect(store.migrateServiceAnnotationHashesFromParentTemplate(graph, snapshot)).toBe(0);
    });

    it('getQueuePage preserves queue ordering and hydrates only the requested page', () => {
      const store = AnnotationStore.createSync(tmpDir);
      const moduleIds = ['mod:leaf', 'mod:barrel', 'mod:featureA', 'mod:featureB', 'mod:entrypoint'];
      const nodes: GraphNode[] = moduleIds.map(id => ({
        id,
        type: 'module' as const,
        label: id.replace(/^mod:/, ''),
        description: '',
      }));
      const imports: GraphEdge[] = [
        { from: 'mod:barrel', to: 'mod:leaf', kind: 'imports' },
        { from: 'mod:featureA', to: 'mod:barrel', kind: 'imports' },
        { from: 'mod:featureB', to: 'mod:barrel', kind: 'imports' },
        { from: 'mod:entrypoint', to: 'mod:barrel', kind: 'imports' },
      ];
      const graph = makeGraph(nodes, imports);
      const snapshot = makeSnapshot(moduleIds.map(id => makeMod(id)));
      store.set('mod:leaf', makeAnnotation('mod:leaf', 'stale-hash'));

      const fullQueue = store.getQueue(graph, snapshot, { limit: Number.MAX_SAFE_INTEGER });
      const page = store.getQueuePage(graph, snapshot, { offset: 2, limit: 2 });

      expect(page.needsWork).toBe(fullQueue.length);
      expect(page.totalRemaining).toBe(fullQueue.length);
      expect(page.counts).toEqual({
        stale: fullQueue.filter(i => i.status === 'stale').length,
        staleContent: fullQueue.filter(i => i.status === 'stale' && i.staleKind !== 'propagation').length,
        stalePropagation: fullQueue.filter(i => i.staleKind === 'propagation').length,
        unannotated: fullQueue.filter(i => i.status === 'unannotated').length,
      });
      expect(page.items).toEqual(fullQueue.slice(2, 4));
    });
  });

  describe('getStats domain scoping', () => {
    function buildTwoDomainGraph() {
      const nodes: GraphNode[] = [
        { id: 'mod:a', type: 'module', label: 'a', description: '' },
        { id: 'mod:b', type: 'module', label: 'b', description: '' },
        { id: 'mod:c', type: 'module', label: 'c', description: '' },
        { id: 'domain:auth', type: 'domain', label: 'auth', description: '' },
        { id: 'domain:billing', type: 'domain', label: 'billing', description: '' },
      ];
      const tags: GraphEdge[] = [
        { from: 'mod:a', to: 'domain:auth', kind: 'tagged' },
        { from: 'mod:b', to: 'domain:auth', kind: 'tagged' },
        { from: 'mod:c', to: 'domain:billing', kind: 'tagged' },
      ];
      const graph = makeGraph(nodes, tags);
      const snapshot = makeSnapshot([makeMod('mod:a'), makeMod('mod:b'), makeMod('mod:c')]);
      return { graph, snapshot };
    }

    it('reports repo-wide totals with no filter and scoped totals with a domainFilter', () => {
      const store = AnnotationStore.createSync(tmpDir);
      const { graph, snapshot } = buildTwoDomainGraph();
      // Annotate mod:a fresh (hash matches makeMod's `${id}:hash`).
      store.set('mod:a', makeAnnotation('mod:a', 'mod:a:hash'));

      const all = store.getStats(graph, snapshot);
      expect(all.totalModules).toBe(3);
      expect(all.annotated).toBe(1);
      expect(all.fresh).toBe(1);
      expect(all.domainAnnotations.totalDomains).toBe(2);

      const auth = store.getStats(graph, snapshot, { domainFilter: 'auth' });
      expect(auth.totalModules).toBe(2); // mod:a + mod:b, not mod:c (billing)
      expect(auth.annotated).toBe(1);
      expect(auth.fresh).toBe(1);
      expect(auth.unannotated).toBe(1); // mod:b
      expect(auth.domainAnnotations.totalDomains).toBe(1); // only domain:auth

      const billing = store.getStats(graph, snapshot, { domainFilter: 'billing' });
      expect(billing.totalModules).toBe(1); // only mod:c
      expect(billing.annotated).toBe(0);
      expect(billing.unannotated).toBe(1);
      expect(billing.domainAnnotations.totalDomains).toBe(1);
    });
  });
});
