import { makeModuleId, modulePathResolverPriority } from '../../../src/stage1/utils.js';

describe('makeModuleId', () => {
  it('normalizes Windows separators before stripping extensions and index', () => {
    expect(makeModuleId('pkg', 'src\\features\\orders\\index.ts'))
      .toBe('mod:pkg/src/features/orders');
  });

  it('strips .d.ts as a unit, leaving no trailing .d', () => {
    // The dedicated .d.ts strip must run BEFORE the general single-extension strip.
    // If removed or reordered after it, the general strip removes only `.ts`,
    // leaving a trailing `.d` (→ 'mod:pkg/src/types/global.d').
    expect(makeModuleId('pkg', 'src/types/global.d.ts'))
      .toBe('mod:pkg/src/types/global');
  });
});

describe('modulePathResolverPriority', () => {
  it('orders extensions: ts > tsx > d.ts > js > jsx > mjs > cjs', () => {
    const ts = modulePathResolverPriority('/a/foo.ts');
    const tsx = modulePathResolverPriority('/a/foo.tsx');
    const dts = modulePathResolverPriority('/a/foo.d.ts');
    const js = modulePathResolverPriority('/a/foo.js');
    const jsx = modulePathResolverPriority('/a/foo.jsx');
    const mjs = modulePathResolverPriority('/a/foo.mjs');
    const cjs = modulePathResolverPriority('/a/foo.cjs');
    expect(ts).toBeLessThan(tsx);
    expect(tsx).toBeLessThan(dts);
    expect(dts).toBeLessThan(js);
    expect(js).toBeLessThan(jsx);
    expect(jsx).toBeLessThan(mjs);
    expect(mjs).toBeLessThan(cjs);
  });

  it('prefers file form over index form (foo.ts beats foo/index.ts)', () => {
    const file = modulePathResolverPriority('/a/foo.ts');
    const indexFile = modulePathResolverPriority('/a/foo/index.ts');
    expect(file).toBeLessThan(indexFile);
  });

  it('orders index-form variants by same extension precedence', () => {
    const indexTs = modulePathResolverPriority('/a/foo/index.ts');
    const indexJs = modulePathResolverPriority('/a/foo/index.js');
    expect(indexTs).toBeLessThan(indexJs);
  });

  it('file form .cjs still beats any index form (worst file > best index)', () => {
    const worstFile = modulePathResolverPriority('/a/foo.cjs');
    const bestIndex = modulePathResolverPriority('/a/foo/index.ts');
    expect(worstFile).toBeLessThan(bestIndex);
  });

  it('returns large priority for unknown extensions', () => {
    const unknown = modulePathResolverPriority('/a/foo.json');
    const ts = modulePathResolverPriority('/a/foo.ts');
    expect(unknown).toBeGreaterThan(ts);
    expect(unknown).toBeGreaterThan(1500);
  });

  it('is case-insensitive on extension', () => {
    const lower = modulePathResolverPriority('/a/foo.ts');
    const upper = modulePathResolverPriority('/a/FOO.TS');
    expect(lower).toBe(upper);
  });
});
