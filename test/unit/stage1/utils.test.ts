import { makeModuleId, modulePathResolverPriority } from '../../../src/stage1/utils.js';

// The engine mints ids; a plugin only declares its ecosystem's facts. This is a hand-written
// TypeScript-shaped normalization, sized for the cases below. The built-in plugin's own
// `capabilities.moduleIdNormalize` declares more suffixes (`.mts`, `.cts`) and is pinned by
// test/laws/path-label-identity.test.ts.
const TS_NORMALIZE = {
  stripSuffixes: ['.d.ts', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  indexBasenames: ['index'],
};

describe('makeModuleId', () => {
  it('normalizes Windows separators before stripping extensions and index', () => {
    expect(makeModuleId('pkg', 'src\\features\\orders\\index.ts', TS_NORMALIZE))
      .toBe('mod:pkg/src/features/orders');
  });

  it('strips .d.ts as a unit, leaving no trailing .d', () => {
    // Suffixes are tried longest-first, so `.d.ts` wins over `.ts`. Sorting shortest-first instead
    // would strip only `.ts` and leave 'mod:pkg/src/types/global.d'.
    expect(makeModuleId('pkg', 'src/types/global.d.ts', TS_NORMALIZE))
      .toBe('mod:pkg/src/types/global');
  });

  it('uses the path verbatim when the ecosystem declares no normalization', () => {
    // An external plugin that declares nothing still gets a well-formed id — it just keeps the
    // suffix, rather than the engine guessing at another language's conventions.
    expect(makeModuleId('go-app', 'cmd/server/main.go'))
      .toBe('mod:go-app/cmd/server/main.go');
  });

  it('collapses the ecosystem-declared package-index basename', () => {
    expect(makeModuleId('pkg', 'a/b/__init__.py', { stripSuffixes: ['.py'], indexBasenames: ['__init__'] }))
      .toBe('mod:pkg/a/b');
  });
});

describe('modulePathResolverPriority', () => {
  // Best first, every extension the resolver ranks. The list is hand-written: derived from the
  // engine's own priority list, dropping an extension would drop the case that covers it.
  const RANKED_PATHS = [
    '/a/foo.ts',
    '/a/foo.tsx',
    '/a/foo.mts',
    '/a/foo.cts',
    '/a/foo.d.ts',
    '/a/foo.js',
    '/a/foo.jsx',
    '/a/foo.mjs',
    '/a/foo.cjs',
  ];

  it('orders extensions: ts > tsx > mts > cts > d.ts > js > jsx > mjs > cjs', () => {
    // Pairwise and strict. A sort of the ranks reads a tie as agreement, so two extensions sharing
    // the no-match sentinel would pass; comparing neighbours names the pair that broke.
    const expected = RANKED_PATHS.slice(1).map((worse, i) => `${RANKED_PATHS[i]} < ${worse}`);
    const actual = RANKED_PATHS.slice(1).map((worse, i) => {
      const betterRank = modulePathResolverPriority(RANKED_PATHS[i]);
      const worseRank = modulePathResolverPriority(worse);
      return betterRank < worseRank
        ? `${RANKED_PATHS[i]} < ${worse}`
        : `${RANKED_PATHS[i]} !< ${worse} (${betterRank} vs ${worseRank})`;
    });
    expect(actual).toEqual(expected);
  });

  it('keeps every ranked extension off the unknown sentinel', () => {
    // The priority list and the pattern that reads a path are two spellings of one set. When they
    // drift, the extension the pattern lost scores the unknown sentinel and loses a collision to the
    // index form it ranks ahead of. Every path above is `/`-spelled, which is the only spelling the
    // index-form penalty reads; the case below measures the other one.
    const bestIndex = modulePathResolverPriority('/a/foo/index.ts');
    const losers = RANKED_PATHS.filter(file => modulePathResolverPriority(file) >= bestIndex);
    expect(losers).toEqual([]);
  });

  it('applies the index-form penalty to the `/` spelling only', () => {
    // The production caller ranks `pending.filePath`, but its spelling is producer-dependent:
    // TypeScript's tsconfig parser normalizes to `/` even on win32, while filesystem-walk branches
    // may retain `\`. These synthetic inputs pin both spellings. Ranks are literals — a comparison
    // between two calls would agree with itself when both collapsed. Widening the pattern turns this
    // red and the docstring that states the boundary moves with it.
    const observed = {
      'posix: foo.ts': modulePathResolverPriority('/a/foo.ts'),
      'posix: foo/index.ts': modulePathResolverPriority('/a/foo/index.ts'),
      'backslash: foo.ts': modulePathResolverPriority('C:\\a\\foo.ts'),
      'backslash: foo\\index.ts': modulePathResolverPriority('C:\\a\\foo\\index.ts'),
      'backslash: foo.d.ts': modulePathResolverPriority('C:\\a\\foo.d.ts'),
      'backslash: foo\\index.mts': modulePathResolverPriority('C:\\a\\foo\\index.mts'),
    };
    expect(observed).toEqual({
      'posix: foo.ts': 0,
      'posix: foo/index.ts': 1000,
      // Tied with the file form: the index segment is not seen, so the caller keeps what it saw first.
      'backslash: foo.ts': 0,
      'backslash: foo\\index.ts': 0,
      // And an index form can outrank a file form outright once the penalty is missing.
      'backslash: foo.d.ts': 4,
      'backslash: foo\\index.mts': 2,
    });
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
