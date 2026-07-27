import { jest } from '@jest/globals';
import * as actualFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compileScanPatterns } from '../../src/scan-filters.js';
import { compareCodeUnits } from '../../src/platform/ordering.js';
import { collectTemplates } from '../../src/stage1/templates.js';
import { discoverPackages } from '../../src/source-plugins/typescript/packages.js';
import { detectPython, discoverPython } from '../../src/source-plugins/python/discover.js';

/**
 * Graph node order follows discovery order, so an unsorted `readdirSync` makes the projection a
 * property of the host filesystem. NTFS collates `[`, `(` and `+` after letters; a code-unit
 * comparison puts them before. The sveltekit fixture carries all three shapes, so the same
 * repository projected differently on Windows and Linux until discovery sorted explicitly.
 *
 * Asserting sorted output alone would not catch a regression here: this filesystem already hands
 * back sorted entries, so the assertion passes with or without the fix. The guard therefore forces
 * the hostile order — every directory read in reverse — and requires discovery to correct it.
 */
describe('law: discovery order does not depend on filesystem enumeration order', () => {
  it('yields the same module order when the host enumerates directories in reverse', async () => {
    jest.resetModules();
    jest.unstable_mockModule('node:fs', () => ({
      ...actualFs,
      default: actualFs,
      readdirSync: ((dir: string, options?: unknown) => {
        const entries = (actualFs.readdirSync as (d: string, o?: unknown) => unknown[])(dir, options);
        return [...entries].reverse();
      }),
    }));

    const { readDirSorted } = await import('../../src/fs/read-dir-sorted.js');
    const names = readDirSorted('test/fixtures/sveltekit/src/routes').map(e => e.name);

    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    // The bracketed and parenthesised route segments are the ones NTFS orders differently; pin them
    // so a future comparator swap (e.g. localeCompare) is caught rather than silently accepted.
    expect(names.indexOf('(marketing)')).toBeLessThan(names.indexOf('api'));
    expect(names.indexOf('[[lang]]')).toBeLessThan(names.indexOf('api'));
    expect(names.indexOf('+page.svelte')).toBeLessThan(names.indexOf('[[lang]]'));
  });
});

/**
 * The second host axis: collation. `readDirSorted` orders by code unit, but a caller that re-sorted
 * that output with `localeCompare` put the enumeration order back under `LANG`/`LC_ALL` and under
 * whether Node was built with full ICU. `'ä'.localeCompare('z')` is -1 under an ICU default
 * collation and +1 under C/POSIX or small-icu, so a repository with a non-ASCII file name built a
 * differently-ordered graph on two machines.
 *
 * The same trap as the law above applies, one axis over: a single-locale CI run makes "sorted on
 * the way out" green with or without the fix. So this guard forces hostile collations — it replaces
 * `String.prototype.localeCompare` itself — and requires discovery to produce the same order
 * anyway. Post-fix the stub is never consulted; pre-fix each collation reorders discovery.
 * `String.prototype.localeCompare` is the target rather than a stubbed module because it is the API
 * the defect uses: code that never calls it cannot be affected by the stub, which is the property
 * under test.
 *
 * WHAT THIS DOES NOT CATCH
 * - Ordering the collation runs never reach. The runs drive stage-1 discovery; domain clustering,
 *   MCP response assembly, graph dumps and annotation reports are covered only by the text guard,
 *   which reads what the source says rather than what an execution does.
 * - Unicode normalization. The law asserts order is a function of the bytes the filesystem reports.
 *   A host that reports NFD where another reports NFC still yields a different order, and both
 *   hosts pass this law. That is a separate defect class.
 * - Locale sensitivity reached indirectly. The text guard reads source text, so a comparator
 *   imported from elsewhere, built from `new Intl.Collator(…).compare` and passed in as a value, or
 *   assembled at runtime is invisible to it. The collation runs above cover the discovery entry
 *   points regardless of how the comparator was obtained; nothing covers the rest of the surface.
 * - Python discovery when no interpreter is present: `discoverPython` returns empty and the Python
 *   half of the comparison is skipped, reported by `PYTHON_AVAILABLE` below.
 * - Stage 2. This exercises stage-1 discovery only, so it does not prove the composed graph is
 *   collation-independent end to end.
 */
describe('law: discovery order does not depend on the runtime collation', () => {
  const PYTHON_AVAILABLE = detectPython() !== null;

  /** Approximates an ICU-style locale: diacritics fold onto their base letter, so 'ä' sorts by 'a'. */
  function foldDiacritics(value: string): string {
    return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  }

  function compareFolded(a: string, b: string): number {
    return compareCodeUnits(foldDiacritics(a), foldDiacritics(b)) || compareCodeUnits(a, b);
  }

  const COLLATIONS: { name: string; compare: ((a: string, b: string) => number) | null }[] = [
    { name: 'host default', compare: null },
    { name: 'diacritic-folding', compare: compareFolded },
    { name: 'inverted code unit', compare: (a, b) => -compareCodeUnits(a, b) },
  ];

  function underCollation<T>(compare: ((a: string, b: string) => number) | null, run: () => T): T {
    if (!compare) return run();
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = function (this: string, that: string): number {
      return compare(String(this), String(that));
    } as typeof String.prototype.localeCompare;
    try {
      return run();
    } finally {
      String.prototype.localeCompare = original;
    }
  }

  /**
   * Names chosen so code-unit order and a folding collation disagree: 'ä' (U+00E4) is above 'z'
   * (U+007A) by code unit and below it once the diacritic folds. The fixture is written at runtime
   * rather than committed — a checked-in non-ASCII name is normalized differently by git and by
   * macOS, which would make the fixture itself the variable under test.
   */
  const PACKAGE_DIRS = ['alpha', 'zulu', 'ärger'];
  const TEMPLATE_FILES = ['apple.html', 'zebra.html', 'ärger.html'];

  let repoRoot: string;

  beforeAll(() => {
    repoRoot = actualFs.mkdtempSync(path.join(os.tmpdir(), 'repovine-collation-law-'));
    const templatesDir = path.join(repoRoot, 'templates');
    actualFs.mkdirSync(templatesDir);
    for (const name of TEMPLATE_FILES) {
      actualFs.writeFileSync(path.join(templatesDir, name), '<p>{% block body %}{% endblock %}</p>\n');
    }
    for (const dir of PACKAGE_DIRS) {
      const abs = path.join(repoRoot, dir);
      actualFs.mkdirSync(abs);
      actualFs.writeFileSync(path.join(abs, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
      actualFs.writeFileSync(path.join(abs, 'package.json'), JSON.stringify({ name: `pkg-${dir}` }));
      actualFs.writeFileSync(path.join(abs, 'pyproject.toml'), `[project]\nname = "pkg-${dir}"\n`);
      actualFs.writeFileSync(path.join(abs, 'mod.py'), 'VALUE = 1\n');
    }
  });

  afterAll(() => {
    if (repoRoot) actualFs.rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Every stage-1 order that becomes graph node insertion order. */
  function discoveryOrder(): Record<string, string[] | null> {
    const scanPatterns = compileScanPatterns([], []);
    const python = PYTHON_AVAILABLE ? discoverPython(repoRoot, { scanPatterns }) : null;
    return {
      templates: collectTemplates({ repoRoot, scanPatterns }).map(t => t.relPath),
      tsPackages: discoverPackages(repoRoot).map(p => p.path),
      pythonPackages: python ? python.packages.map(p => p.path) : null,
      // Map insertion order is what stage 1 consumes downstream, so read it back as an order.
      pythonModules: python ? [...python.pendingByPath.values()].map(m => `${m.pkg.path}/${m.relPath}`) : null,
    };
  }

  it('the fixture actually distinguishes the collations under test', () => {
    // Without this the law could pass on a host whose filesystem folded the non-ASCII names into
    // something both collations order identically — green for the wrong reason, again.
    const onDisk = actualFs.readdirSync(path.join(repoRoot, 'templates'));
    expect(onDisk).toHaveLength(TEMPLATE_FILES.length);
    expect([...onDisk].sort(compareFolded)).not.toEqual([...onDisk].sort(compareCodeUnits));

    const dirs = actualFs.readdirSync(repoRoot).filter(name => name !== 'templates');
    expect([...dirs].sort(compareFolded)).not.toEqual([...dirs].sort(compareCodeUnits));
  });

  it('yields the same discovery order under every collation', () => {
    const [baseline, ...rest] = COLLATIONS.map(c => ({
      name: c.name,
      order: underCollation(c.compare, discoveryOrder),
    }));

    expect(baseline!.order.templates).toHaveLength(TEMPLATE_FILES.length);
    expect(baseline!.order.tsPackages).toHaveLength(PACKAGE_DIRS.length);
    if (PYTHON_AVAILABLE) {
      expect(baseline!.order.pythonPackages).toHaveLength(PACKAGE_DIRS.length);
      expect(baseline!.order.pythonModules).toHaveLength(PACKAGE_DIRS.length);
    }

    for (const run of rest) {
      expect({ collation: baseline!.name, order: run!.order }).toEqual({
        collation: baseline!.name,
        order: baseline!.order,
      });
    }
  });

  it('orders discovery by code unit, not by any collation', () => {
    const order = underCollation(null, discoveryOrder);
    const onDisk = actualFs.readdirSync(path.join(repoRoot, 'templates'));

    expect(order.templates).toEqual([...onDisk].sort(compareCodeUnits).map(name => `templates/${name}`));
    expect(order.tsPackages).toEqual([...order.tsPackages!].sort(compareCodeUnits));
    // The concrete divergence this law exists for: bytes put 'ä' after 'z', collation need not.
    expect(compareCodeUnits('ä', 'z')).toBe(1);
  });

  /**
   * Source files whose ordering decisions land in the graph or in a persisted build artifact. The
   * collation runs above cover the discovery entry points; this guard covers the rest of the same
   * surface, where forcing every code path from a test would cost more than reading the text.
   */
  /**
   * Every source file, not a named list.
   *
   * The guard began as a list of the files whose ordering reaches the graph, because those were the
   * ones that had to be fixed first. A list is also a place a new file can fail to appear, so once
   * no file in `src/` collated by locale the guard grew to the whole tree: ordering that leaves this
   * engine — the graph, a persisted artifact, or a response an agent pages through — is a property
   * of the bytes, and there is no file where that stops being true.
   */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of actualFs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sourceFiles(full, out);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('no source file sorts by a locale-sensitive comparator', () => {
    const candidates = [process.cwd(), path.resolve(process.cwd(), 'repovine')];
    const root = candidates.find(c => actualFs.existsSync(path.join(c, 'src', 'platform', 'ordering.ts')));
    if (!root) throw new Error(`Could not find repo root. Tried: ${candidates.join(', ')}`);

    const files = sourceFiles(path.join(root, 'src'));
    // A move that emptied the tree would otherwise pass with nothing to check.
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const abs of files) {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      // Comments discuss `localeCompare` by name; only calls are the defect. Stripping is crude —
      // a `//` inside a string literal blinds the rest of that line — so it can under-report, never
      // over-report.
      const code = actualFs
        .readFileSync(abs, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

      if (/\.localeCompare\s*\(/.test(code)) offenders.push(`${rel}: .localeCompare(`);
      if (/\bIntl\.Collator\b/.test(code)) offenders.push(`${rel}: Intl.Collator`);
    }

    expect(offenders.sort()).toEqual([]);
  });
});
