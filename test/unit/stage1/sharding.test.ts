import {
  splitIntoShards,
  dedupByModuleIdPreservingOrder,
} from '../../../src/stage1/index.js';
import type { PendingModule } from '../../../src/types.js';

function pending(filePath: string, moduleId: string): PendingModule {
  return {
    filePath,
    relPath: filePath.replace(/^\/repo\/pkg\//, ''),
    moduleId,
    pkg: { name: 'pkg', path: 'pkg'},
  };
}

function mod(n: number): PendingModule {
  return pending(`/repo/pkg/src/m${n}.ts`, `mod:pkg/src/m${n}`);
}

describe('splitIntoShards', () => {
  it('returns a single shard when below 2× target size', () => {
    const mods = Array.from({ length: 500 }, (_, i) => mod(i));
    const shards = splitIntoShards(mods, 800);
    expect(shards).toHaveLength(1);
    expect(shards[0]).toHaveLength(500);
  });

  it('returns a single shard exactly at 2× threshold boundary', () => {
    const mods = Array.from({ length: 1599 }, (_, i) => mod(i));
    expect(splitIntoShards(mods, 800)).toHaveLength(1);
  });

  it('splits at 2× threshold boundary', () => {
    const mods = Array.from({ length: 1600 }, (_, i) => mod(i));
    const shards = splitIntoShards(mods, 800);
    expect(shards).toHaveLength(2);
  });

  it('produces ceil(N / targetSize) shards for larger N', () => {
    const mods = Array.from({ length: 9033 }, (_, i) => mod(i));
    const shards = splitIntoShards(mods, 800);
    expect(shards).toHaveLength(12); // ceil(9033 / 800)
  });

  it('shards never overlap and union to original (no module lost/duplicated)', () => {
    const mods = Array.from({ length: 9033 }, (_, i) => mod(i));
    const shards = splitIntoShards(mods, 800);
    const flat = shards.flat();
    expect(flat).toHaveLength(mods.length);
    expect(new Set(flat.map(p => p.moduleId)).size).toBe(mods.length);
    // First module of shard 0 is first module overall, last module of last shard is last overall.
    expect(shards[0]![0]!.moduleId).toBe(mods[0]!.moduleId);
    expect(shards[shards.length - 1]![shards[shards.length - 1]!.length - 1]!.moduleId)
      .toBe(mods[mods.length - 1]!.moduleId);
  });

  it('handles empty input', () => {
    expect(splitIntoShards([], 800)).toEqual([[]]);
  });
});

describe('dedupByModuleIdPreservingOrder', () => {
  it('passes through non-colliding pendings unchanged', () => {
    const ps = [
      pending('/repo/pkg/src/a.ts', 'mod:pkg/src/a'),
      pending('/repo/pkg/src/b.ts', 'mod:pkg/src/b'),
    ];
    const out = dedupByModuleIdPreservingOrder(ps);
    expect(out).toEqual(ps);
  });

  it('picks file form over index form for colliding moduleId', () => {
    const fileForm = pending('/repo/pkg/src/foo.ts', 'mod:pkg/src/foo');
    const indexForm = pending('/repo/pkg/src/foo/index.ts', 'mod:pkg/src/foo');
    expect(dedupByModuleIdPreservingOrder([indexForm, fileForm])).toEqual([fileForm]);
    expect(dedupByModuleIdPreservingOrder([fileForm, indexForm])).toEqual([fileForm]);
  });

  it('picks .ts over .tsx when both forms collide on moduleId', () => {
    const ts = pending('/repo/pkg/src/foo.ts', 'mod:pkg/src/foo');
    const tsx = pending('/repo/pkg/src/foo.tsx', 'mod:pkg/src/foo');
    expect(dedupByModuleIdPreservingOrder([tsx, ts])).toEqual([ts]);
  });

  it('preserves first-seen order of surviving entries', () => {
    const a = pending('/repo/pkg/src/a.ts', 'mod:pkg/src/a');
    const dup1 = pending('/repo/pkg/src/b/index.ts', 'mod:pkg/src/b');
    const c = pending('/repo/pkg/src/c.ts', 'mod:pkg/src/c');
    const dup2 = pending('/repo/pkg/src/b.ts', 'mod:pkg/src/b');
    const out = dedupByModuleIdPreservingOrder([a, dup1, c, dup2]);
    // First-seen for `mod:pkg/src/b` was dup1 (index form), the winner is dup2 (file form),
    // but it still occupies the "b" slot (second position).
    expect(out.map(p => p.moduleId)).toEqual(['mod:pkg/src/a', 'mod:pkg/src/b', 'mod:pkg/src/c']);
    expect(out[1]).toBe(dup2);
  });
});
