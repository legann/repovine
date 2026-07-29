import { asHostPath, asPkgRelPath, asRepoRelPath } from '@repovine/plugin-sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createFileCache, snapshotContentFingerprint, extractOutputFingerprint } from '../../../src/stage1/cache.js';
import type { ModuleInfo, RepositoryFactsSnapshot } from '../../../src/types.js';

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `repovine-${label}-`));
}

const SNAPSHOT_FILENAME = 'repository-facts-snapshot.json';
const RELATIVE_FILES = ['packages/foo/src/index.ts', 'packages/bar/lib/util.ts'];

function makeModule(root: string, rel: string): ModuleInfo {
  return {
    id: `pkg/${rel}`,
    packageName: 'pkg',
    absPath: asHostPath(path.join(root, ...rel.split('/'))),
    pkgRelPath: asPkgRelPath(rel),
    contentHash: `hash-${rel}`,
    imports: [],
    exports: [],
  };
}

function makeSnapshot(root: string, rels: string[] = RELATIVE_FILES): RepositoryFactsSnapshot {
  return {
    repoRoot: root,
    timestamp: '2026-06-26T00:00:00.000Z',
    analysisVersion: 7,
    packages: [],
    modules: rels.map(rel => makeModule(root, rel)),
  };
}

describe('snapshot cache absPath portability', () => {
  it('stores module absPath repo-root-relative (POSIX) on disk', () => {
    const rootA = tempDir('rootA');
    const cacheDir = tempDir('cache');
    createFileCache(cacheDir, rootA).save(makeSnapshot(rootA));

    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, SNAPSHOT_FILENAME), 'utf-8'));
    const stored = raw.modules.map((m: ModuleInfo) => m.absPath);
    expect(stored).toEqual(RELATIVE_FILES);
    for (const fp of stored) {
      expect(path.isAbsolute(fp)).toBe(false);
      expect(fp).not.toContain(rootA);
      expect(fp).not.toContain('\\');
    }
  });

  it('reconstructs absolute absPath against a different root on load (cross-worktree)', () => {
    const rootA = tempDir('worktreeA');
    const rootB = tempDir('worktreeB');
    const cacheDir = tempDir('cache');

    createFileCache(cacheDir, rootA).save(makeSnapshot(rootA));
    // Same cacheDir (the copied .repovine), but the runtime now sits under rootB.
    const loaded = createFileCache(cacheDir, rootB).load();

    expect(loaded).not.toBeNull();
    for (let i = 0; i < RELATIVE_FILES.length; i++) {
      const rel = RELATIVE_FILES[i];
      expect(loaded!.modules[i].absPath).toBe(path.resolve(rootB, rel));
      expect(loaded!.modules[i].absPath.startsWith(rootB)).toBe(true);
    }
  });

  it('round-trips to the same absolute absPath under one root', async () => {
    const root = tempDir('sameroot');
    const cacheDir = tempDir('cache');
    const cache = createFileCache(cacheDir, root);
    const original = makeSnapshot(root);

    cache.save(original);
    const loaded = cache.load();
    const loadedAsync = await cache.loadAsync();

    for (let i = 0; i < original.modules.length; i++) {
      expect(loaded!.modules[i].absPath).toBe(original.modules[i].absPath);
      expect(loadedAsync!.modules[i].absPath).toBe(original.modules[i].absPath);
    }
  });

  it('never writes a portable value into the in-memory HostPath field', () => {
    const root = tempDir('brand-window');
    const snapshot = makeSnapshot(root, [RELATIVE_FILES[0]]);
    const module = snapshot.modules[0];
    let absPath = module.absPath;
    let writes = 0;
    Object.defineProperty(module, 'absPath', {
      enumerable: true,
      configurable: true,
      get: () => absPath,
      set: (next: ModuleInfo['absPath']) => {
        writes++;
        absPath = next;
      },
    });

    createFileCache(tempDir('brand-window-cache'), root).save(snapshot);

    expect(writes).toBe(0);
    expect(module.absPath).toBe(path.join(root, ...RELATIVE_FILES[0].split('/')));
  });

  it('saveAsync produces the same portable on-disk format as save', async () => {
    const root = tempDir('async');
    const cacheDir = tempDir('cache');
    await createFileCache(cacheDir, root).saveAsync(makeSnapshot(root));

    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, SNAPSHOT_FILENAME), 'utf-8'));
    expect(raw.modules.map((m: ModuleInfo) => m.absPath)).toEqual(RELATIVE_FILES);
  });

  it('tolerates a stray absolute absPath entry on load', () => {
    const root = tempDir('mixed');
    const cacheDir = tempDir('cache');
    const strayAbs = path.join(root, 'packages/legacy/old.ts');
    fs.writeFileSync(
      path.join(cacheDir, SNAPSHOT_FILENAME),
      JSON.stringify({
        repoRoot: root,
        timestamp: '2026-06-26T00:00:00.000Z',
        analysisVersion: 7,
        packages: [],
        modules: [
          { ...makeModule(root, RELATIVE_FILES[0]), absPath: RELATIVE_FILES[0] },
          { ...makeModule(root, 'packages/legacy/old.ts'), absPath: strayAbs },
        ],
      }),
    );

    const loaded = createFileCache(cacheDir, root).load();
    expect(loaded!.modules[0].absPath).toBe(path.resolve(root, RELATIVE_FILES[0]));
    expect(loaded!.modules[1].absPath).toBe(strayAbs);
  });

  it('returns null when the cache file is absent', () => {
    expect(createFileCache(tempDir('empty'), tempDir('root')).load()).toBeNull();
  });

  it('saveAsync streams byte-for-byte identical output to save, preserving post-modules fields', async () => {
    const root = tempDir('streamcache');
    const snap = makeSnapshot(root);
    // Fields that serialize AFTER modules: exercises position-preserving streaming and the rule that
    // only modules[].absPath is path-transformed (infra/template paths stay as-is).
    snap.infraModules = [{
      id: 'infra1',
      kind: 'terraform',
      absPath: asHostPath(path.join(root, 'infra', 'main.tf')),
      repoRelPath: asRepoRelPath('infra/main.tf'),
      contentHash: 'infra-hash',
      resources: [],
    }];
    snap.templates = [{
      id: 'template:web/index.html',
      relPath: 'web/index.html',
      contentHash: 'template-hash',
    }];

    const syncDir = tempDir('cacheSync');
    const asyncDir = tempDir('cacheAsync');
    createFileCache(syncDir, root).save(structuredClone(snap));
    await createFileCache(asyncDir, root).saveAsync(structuredClone(snap));

    const syncBytes = fs.readFileSync(path.join(syncDir, SNAPSHOT_FILENAME), 'utf-8');
    const asyncBytes = fs.readFileSync(path.join(asyncDir, SNAPSHOT_FILENAME), 'utf-8');
    expect(asyncBytes).toBe(syncBytes);

    const raw = JSON.parse(asyncBytes);
    expect(raw.modules.map((m: ModuleInfo) => m.absPath)).toEqual(RELATIVE_FILES);
    expect(raw.infraModules[0].absPath).toBe(path.join(root, 'infra', 'main.tf'));
    expect(raw.templates[0].relPath).toBe('web/index.html');

    const loaded = createFileCache(asyncDir, root).load();
    expect(loaded!.modules[0].absPath).toBe(path.resolve(root, RELATIVE_FILES[0]));
  });

  it('exists() reflects whether the cache file is present', () => {
    const cache = createFileCache(tempDir('cache'), tempDir('root'));
    expect(cache.exists()).toBe(false);
    cache.save(makeSnapshot(tempDir('snaproot')));
    expect(cache.exists()).toBe(true);
  });
});

describe('snapshotContentFingerprint (P2 dirty-skip signal)', () => {
  it('is stable for identical content', () => {
    const root = tempDir('fp');
    expect(snapshotContentFingerprint(makeSnapshot(root))).toBe(snapshotContentFingerprint(makeSnapshot(root)));
  });

  it('is path-independent: same relative content under a different root yields the same fingerprint', () => {
    expect(snapshotContentFingerprint(makeSnapshot(tempDir('rootA'))))
      .toBe(snapshotContentFingerprint(makeSnapshot(tempDir('rootB'))));
  });

  it('changes when a module contentHash changes', () => {
    const root = tempDir('fp');
    const changed = makeSnapshot(root);
    changed.modules[0].contentHash = 'different-content-hash';
    expect(snapshotContentFingerprint(changed)).not.toBe(snapshotContentFingerprint(makeSnapshot(root)));
  });

  it('changes when a module is added or removed', () => {
    const root = tempDir('fp');
    const more = makeSnapshot(root, [...RELATIVE_FILES, 'packages/baz/src/extra.ts']);
    expect(snapshotContentFingerprint(more)).not.toBe(snapshotContentFingerprint(makeSnapshot(root)));
  });

  it('changes when a template or infra member changes (covers non-module members)', () => {
    const root = tempDir('fp');
    const base = snapshotContentFingerprint(makeSnapshot(root));

    const withTemplate = makeSnapshot(root);
    withTemplate.templates = [{ id: 'template:web/index.html', contentHash: 'tpl-hash' }] as unknown as RepositoryFactsSnapshot['templates'];
    expect(snapshotContentFingerprint(withTemplate)).not.toBe(base);

    const withInfra = makeSnapshot(root);
    withInfra.infraModules = [{ id: 'infra:main.tf', contentHash: 'infra-hash' }] as unknown as RepositoryFactsSnapshot['infraModules'];
    expect(snapshotContentFingerprint(withInfra)).not.toBe(base);
  });

  it('changes when analysisVersion changes', () => {
    const root = tempDir('fp');
    const bumped = makeSnapshot(root);
    bumped.analysisVersion = (bumped.analysisVersion ?? 0) + 1;
    expect(snapshotContentFingerprint(bumped)).not.toBe(snapshotContentFingerprint(makeSnapshot(root)));
  });

  it('changes when the extraction config fingerprint changes', () => {
    const root = tempDir('fp');
    const changed = makeSnapshot(root);
    changed.extractionConfigFingerprint = 'config-b';
    const baseline = makeSnapshot(root);
    baseline.extractionConfigFingerprint = 'config-a';
    expect(snapshotContentFingerprint(changed)).not.toBe(snapshotContentFingerprint(baseline));
  });
});

// A fact-carrying module whose `contentHash` is a fixed constant. Mutating an extracted fact while
// keeping `contentHash` pinned reproduces the stale-cache class this repo regressed on: source is
// byte-identical, extract output differs. The fingerprint MUST move on the fact, not the source hash.
function richModule(root: string): ModuleInfo {
  return {
    id: 'pkg/src/service.ts',
    packageName: 'pkg',
    absPath: asHostPath(path.join(root, 'pkg', 'src', 'service.ts')),
    pkgRelPath: asPkgRelPath('pkg/src/service.ts'),
    contentHash: 'stable-service-hash',
    imports: [
      {
        moduleSpecifier: './dep',
        resolvedModuleId: 'pkg/src/dep.ts',
        importedNames: ['helper'],
        isTypeOnly: false,
        isExternal: false,
      },
    ],
    exports: [
      {
        name: 'doWork',
        kind: 'function',
        isDefault: false,
        signature: 'doWork(): void',
        returnType: 'void',
        calls: ['helper'],
        lineRange: { start: 1, end: 5 },
      },
    ],
    calls: ['topLevelInit'],
    semanticHints: {
      envVars: ['API_URL'],
      runtimeActions: [{ action: 'sqs.sendMessage', envVar: 'QUEUE_URL', lineRange: { start: 10, end: 12 } }],
    },
    sourcePluginId: 'typescript',
  };
}

function richSnapshot(root: string): RepositoryFactsSnapshot {
  return {
    repoRoot: root,
    timestamp: '2026-06-26T00:00:00.000Z',
    analysisVersion: 7,
    packages: [],
    modules: [richModule(root), makeModule(root, RELATIVE_FILES[0])],
  };
}

describe('extractOutputFingerprint folds extracted facts (stale-cache guard)', () => {
  it('is stable when nothing changes', () => {
    expect(extractOutputFingerprint(richSnapshot('/repo'))).toBe(extractOutputFingerprint(richSnapshot('/repo')));
  });

  it('is order-independent: reversing member order does not change it', () => {
    const a = richSnapshot('/repo');
    const b = richSnapshot('/repo');
    b.modules = [...b.modules].reverse();
    expect(extractOutputFingerprint(b)).toBe(extractOutputFingerprint(a));
  });

  it('changes when a call is added to an export while contentHash is unchanged', () => {
    const base = richSnapshot('/repo');
    const mutated = richSnapshot('/repo');
    mutated.modules[0].exports[0].calls = [...(mutated.modules[0].exports[0].calls ?? []), 'newCallee'];
    expect(mutated.modules[0].contentHash).toBe(base.modules[0].contentHash); // source byte-identical
    expect(extractOutputFingerprint(mutated)).not.toBe(extractOutputFingerprint(base));
  });

  it('changes when an import isTypeOnly flag flips while contentHash is unchanged', () => {
    const base = richSnapshot('/repo');
    const mutated = richSnapshot('/repo');
    mutated.modules[0].imports[0].isTypeOnly = !mutated.modules[0].imports[0].isTypeOnly;
    expect(mutated.modules[0].contentHash).toBe(base.modules[0].contentHash);
    expect(extractOutputFingerprint(mutated)).not.toBe(extractOutputFingerprint(base));
  });

  it('changes when a semanticHint is added while contentHash is unchanged', () => {
    const base = richSnapshot('/repo');
    const mutated = richSnapshot('/repo');
    mutated.modules[0].semanticHints = { ...mutated.modules[0].semanticHints, hasRoutes: true };
    expect(mutated.modules[0].contentHash).toBe(base.modules[0].contentHash);
    expect(extractOutputFingerprint(mutated)).not.toBe(extractOutputFingerprint(base));
  });

  it('does NOT change when only a semanticHint lineRange moves (position excluded)', () => {
    const base = richSnapshot('/repo');
    const moved = richSnapshot('/repo');
    moved.modules[0].semanticHints!.runtimeActions![0].lineRange = { start: 200, end: 202 };
    expect(extractOutputFingerprint(moved)).toBe(extractOutputFingerprint(base));
  });
});

describe('load()/loadAsync() malformed-snapshot fallback (cold-rebuild path)', () => {
  it('returns null on non-JSON snapshot content without throwing', async () => {
    const cacheDir = tempDir('badjson-cache');
    fs.writeFileSync(path.join(cacheDir, SNAPSHOT_FILENAME), 'not-json');
    const cache = createFileCache(cacheDir, tempDir('badjson-root'));
    expect(cache.load()).toBeNull();
    await expect(cache.loadAsync()).resolves.toBeNull();
  });

  it('returns null when modules is not an array (non-array modules field)', async () => {
    const cacheDir = tempDir('nonarray-cache');
    fs.writeFileSync(path.join(cacheDir, SNAPSHOT_FILENAME), '{"modules":"x"}');
    const cache = createFileCache(cacheDir, tempDir('nonarray-root'));
    expect(cache.load()).toBeNull();
    await expect(cache.loadAsync()).resolves.toBeNull();
  });
});
