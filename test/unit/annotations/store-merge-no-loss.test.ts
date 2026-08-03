/**
 * Regression: the annotation store must never lose a persisted annotation when the file is changed
 * out of band before the next save (concurrent writer, interrupted debounced save, git checkout).
 * mergeWithDisk previously took disk as the base and re-applied only `touched` keys, so an entry
 * persisted in an earlier cycle (touched already cleared) vanished when the disk snapshot lacked it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AnnotationStore, describeMergeKeeps } from '../../../src/annotations/store.js';
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

  // The mirror image of the drop above: the disk copy is present but REGRESSED. Once a debounced save
  // clears `touched`, an in-memory update is protected only by the disk snapshot, so an out-of-band reset
  // reverted the record whole — content, contentHash, pass and updatedAt — on the next refresh_context.
  it('keeps a persisted update when the disk copy regresses to an older version', async () => {
    const store = await AnnotationStore.create(dir);
    store.set('mod:a', { ...ann('mod:a', 'the original summary for module a'), pass: 9 });
    await store.flushAsync();
    const headBytes = fs.readFileSync(file);

    store.set('mod:a', {
      ...ann('mod:a', 'the corrected summary for module a'),
      pass: 10,
      contentHash: 'h2',
      updatedAt: '2026-07-13T00:00:00.000Z',
    }, ['summary']);
    store.set('mod:new', ann('mod:new', 'a node the file has never held'));
    await store.flushAsync(); // both land; `touched` is cleared

    fs.writeFileSync(file, headBytes); // out-of-band reset to the committed copy
    await store.reloadFromDisk();

    const kept = store.get('mod:a')!;
    expect(kept.annotation.summary).toBe('the corrected summary for module a');
    expect(kept.pass).toBe(10);          // whole record survives, not just its content
    expect(kept.contentHash).toBe('h2'); // so the next write does not re-derive pass from the old record
    expect(store.get('mod:new')).toBeDefined(); // never-drop still covers a node absent from disk
  });

  // A newer external record still wins: the guard overrides a regression, not an update.
  it('adopts an external update that supersedes ours', async () => {
    const store = await AnnotationStore.create(dir);
    store.set('mod:a', { ...ann('mod:a', 'our summary for module a'), pass: 3 });
    await store.flushAsync();

    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      annotations: { 'mod:a': { ...ann('mod:a', 'a teammate rewrote this summary'), pass: 4 } },
    }));
    await store.reloadFromDisk();

    expect(store.get('mod:a')!.annotation.summary).toBe('a teammate rewrote this summary');
    expect(store.get('mod:a')!.pass).toBe(4);
  });

  // A write that changed no annotation content must not stamp our contentHash over disk's content:
  // that reports a record as fresh while it holds the older text.
  it('never reports a record fresh while it carries the disk copy\'s content', async () => {
    const store = await AnnotationStore.create(dir);
    store.set('mod:a', ann('mod:a', 'the summary as first written'));
    await store.flushAsync();

    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      annotations: { 'mod:a': { ...ann('mod:a', 'a teammate rewrote this summary'), pass: 2 } },
    }));
    // changedAnnotationFields returned [] — this write carries no content change.
    store.set('mod:a', { ...ann('mod:a', 'the summary as first written'), contentHash: 'h2' }, []);
    await store.reloadFromDisk();

    const merged = store.get('mod:a')!;
    expect(merged.annotation.summary).toBe('a teammate rewrote this summary');
    expect(merged.contentHash).toBe('h'); // disk's hash, matching disk's content
    expect(merged.pass).toBe(2);
  });

  // The regress net must not reach the field-level merge. `write_annotation` derives `pass` from our own
  // possibly-stale copy (`existing.pass + 1`) and stamps `updatedAt` from the wall clock, so one concurrent
  // write ties on `pass` and loses the timestamp comparison — reading that as a regression would discard the
  // very field additions the field merge exists to keep, and the loser has no way to recover them.
  it('keeps a concurrent writer\'s added field when our own write ties on pass', async () => {
    const store = await AnnotationStore.create(dir);
    store.set('mod:a', { ...ann('mod:a', 'shared summary'), pass: 1 });
    await store.flushAsync();

    // Another process wrote first: same node, next pass, an added field, an earlier wall clock than ours.
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      annotations: {
        'mod:a': {
          ...ann('mod:a', 'shared summary'),
          pass: 2,
          updatedAt: '2026-07-12T10:00:01.000Z',
          annotation: { summary: 'shared summary', invariants: ['written by the other process'] },
        },
      },
    }));

    // Ours derives pass from the stale in-memory copy, so it ties, and stamps a later timestamp.
    store.set('mod:a', {
      ...ann('mod:a', 'shared summary'),
      pass: 2,
      updatedAt: '2026-07-12T10:00:02.000Z',
      annotation: { summary: 'shared summary', risks: ['written by this process'] },
    }, ['risks']);
    await store.flushAsync();

    const merged = readAnnotations(file)['mod:a'] as { annotation: Record<string, unknown> };
    expect(merged.annotation.risks).toEqual(['written by this process']);
    expect(merged.annotation.invariants).toEqual(['written by the other process']);
  });

  // The serializer elides `pass` when it is 1 and the loader hydrates the absence back to 1. Reading a raw
  // disk record's missing key as 0 would rank every first-pass record as superseded, so an external update
  // to the most common kind of record would be reverted.
  it('does not read a disk record whose elided pass is 1 as a regression', async () => {
    const store = await AnnotationStore.create(dir);
    store.set('mod:a', ann('mod:a', 'our first-pass summary')); // pass 1
    await store.flushAsync();
    expect(readAnnotations(file)['mod:a']).not.toHaveProperty('pass'); // the elision this guards

    // A teammate rewrote it, also at pass 1, with a later timestamp: a genuine update, not a rollback.
    // Written the way the serializer writes it — WITHOUT the elided `pass` key, which is the whole point.
    const { pass: _elided, ...teammate } = {
      ...ann('mod:a', 'a teammate rewrote this summary'),
      updatedAt: '2026-07-14T00:00:00.000Z',
    };
    fs.writeFileSync(file, JSON.stringify({ version: 1, annotations: { 'mod:a': teammate } }));
    await store.reloadFromDisk();

    expect(store.get('mod:a')!.annotation.summary).toBe('a teammate rewrote this summary');
  });

  // `pass` is derived per process from a possibly-stale read, so two writers reach the same pass with
  // different content and `updatedAt` is all that separates them. Both directions of that tiebreak decide
  // real records, and neither is exercised by the pass-differs cases above.
  it.each([
    ['keeps ours when the disk copy shares our pass but is older', '2026-07-12T09:00:00.000Z', 'our newer summary'],
    ['adopts the disk copy when it shares our pass and is newer', '2026-07-12T11:00:00.000Z', 'their newer summary'],
  ])('%s', async (_name, diskUpdatedAt, expected) => {
    const store = await AnnotationStore.create(dir);
    store.set('mod:a', {
      ...ann('mod:a', 'our newer summary'),
      pass: 4,
      updatedAt: '2026-07-12T10:00:00.000Z',
    });
    await store.flushAsync(); // persisted, so `touched` is clear and the sweep decides

    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      annotations: { 'mod:a': { ...ann('mod:a', 'their newer summary'), pass: 4, updatedAt: diskUpdatedAt } },
    }));
    await store.reloadFromDisk();

    expect(store.get('mod:a')!.annotation.summary).toBe(expected);
  });

  // The net exists so an interrupted save cannot lose a note, but it also outlives a deliberate revert.
  // Reporting what it kept is what tells the operator why their revert did not stick.
  it('reports what the merge kept over a disagreeing file, per cause', async () => {
    const store = await AnnotationStore.create(dir);
    store.set('mod:a', { ...ann('mod:a', 'the corrected summary'), pass: 9 });
    store.set('mod:new', ann('mod:new', 'a node the committed file never held'));
    await store.flushAsync(); // both persisted; `touched` cleared

    // A revert to a committed copy that predates both: mod:a rolled back, mod:new absent entirely.
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      annotations: { 'mod:a': { ...ann('mod:a', 'the original summary'), pass: 8 } },
    }));
    await store.reloadFromDisk();

    const keeps = store.lastMergeKeeps;
    // Sample order follows the sweep, which walks our records in insertion order.
    expect(keeps).toEqual({ readded: 1, reverted: 1, sample: ['mod:a', 'mod:new'] });
    const warning = describeMergeKeeps(keeps)!;
    expect(warning).toContain('1 the file no longer held');
    expect(warning).toContain('1 the file held in an older version');
    expect(warning).toContain('does not stick');
  });

  it('reports nothing when the merge kept nothing', async () => {
    const store = await AnnotationStore.create(dir);
    store.set('mod:a', ann('mod:a', 'a summary the file agrees with'));
    await store.flushAsync();
    await store.reloadFromDisk();

    expect(store.lastMergeKeeps).toEqual({ readded: 0, reverted: 0, sample: [] });
    expect(describeMergeKeeps(store.lastMergeKeeps)).toBeUndefined();
  });

  it('describes the latest merge, not an accumulation', async () => {
    const store = await AnnotationStore.create(dir);
    store.set('mod:a', { ...ann('mod:a', 'the corrected summary'), pass: 9 });
    await store.flushAsync();
    const good = fs.readFileSync(file);

    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      annotations: { 'mod:a': { ...ann('mod:a', 'the original summary'), pass: 8 } },
    }));
    await store.reloadFromDisk();
    expect(store.lastMergeKeeps.reverted).toBe(1);

    fs.writeFileSync(file, good); // file agrees again
    await store.reloadFromDisk();
    expect(store.lastMergeKeeps).toEqual({ readded: 0, reverted: 0, sample: [] });
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
