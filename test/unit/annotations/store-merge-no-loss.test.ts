/**
 * Regression: the annotation store must never lose a persisted annotation when the file is changed
 * out of band before the next save (concurrent writer, interrupted debounced save, git checkout).
 * mergeWithDisk previously took disk as the base and re-applied only `touched` keys, so an entry
 * persisted in an earlier cycle (touched already cleared) vanished when the disk snapshot lacked it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnnotationStore } from '../../../src/annotations/store.js';
import type { StoredAnnotation } from '../../../src/types.js';

function ann(nodeId: string, summary: string): StoredAnnotation {
  return {
    nodeId,
    nodeType: 'module',
    contentHash: 'h',
    pass: 1,
    updatedAt: '2026-07-12T00:00:00.000Z',
    annotation: { summary },
    schemaVersion: 1,
  };
}

function readAnnotations(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8')).annotations;
}

describe('AnnotationStore merge never drops in-memory annotations', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annstore-'));
    file = path.join(dir, 'repovine.annots.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a persisted annotation when the file is reset out of band before the next save', () => {
    const store = AnnotationStore.createSync(dir);
    store.set('mod:a', ann('mod:a', 'annotation A for module a'));
    store.flush(); // disk now has A; `touched` is cleared
    expect(readAnnotations(file)['mod:a']).toBeDefined();

    // An external writer (git checkout / concurrent store / half-flushed save) resets the file to a
    // snapshot that does NOT contain A, changing mtime/size so fileChangedExternally() fires.
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, annotations: { 'mod:ext': ann('mod:ext', 'external annotation added out of band') } }),
    );

    store.set('mod:b', ann('mod:b', 'annotation B for module b'));
    store.flush(); // takes the mergeWithDisk path

    const onDisk = readAnnotations(file);
    expect(onDisk['mod:a']).toBeDefined(); // regression guard: must survive the merge
    expect(onDisk['mod:b']).toBeDefined(); // our new write lands
    expect(onDisk['mod:ext']).toBeDefined(); // external addition is adopted
  });

  it('still honors an explicit delete across a merge', () => {
    const store = AnnotationStore.createSync(dir);
    store.set('mod:a', ann('mod:a', 'annotation A for module a'));
    store.set('mod:keep', ann('mod:keep', 'annotation to keep across the merge'));
    store.flush();

    // External change so the next save merges with disk.
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, annotations: { 'mod:a': ann('mod:a', 'annotation A for module a'), 'mod:keep': ann('mod:keep', 'annotation to keep across the merge') } }),
    );

    store.delete(['mod:a']);
    store.flush();

    const onDisk = readAnnotations(file);
    expect(onDisk['mod:a']).toBeUndefined(); // explicit delete is honored
    expect(onDisk['mod:keep']).toBeDefined(); // untouched entry preserved
  });
});
