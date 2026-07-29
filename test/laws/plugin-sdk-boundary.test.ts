import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_API_VERSION } from '@repovine/plugin-sdk';
import typescriptPlugin from '../../packages/plugins/source-typescript/src/plugin.js';
import pythonPlugin from '../../packages/plugins/source-python/src/plugin.js';
import samIacPlugin from '../../src/iac-plugins/sam/index.js';
import helmIacPlugin from '../../src/iac-plugins/helm/index.js';
import kubernetesIacPlugin from '../../src/iac-plugins/kubernetes/index.js';
import dockerComposeIacPlugin from '../../src/iac-plugins/docker-compose/index.js';
import dockerfileIacPlugin from '../../src/iac-plugins/dockerfile/index.js';
import terraformIacPlugin from '../../src/iac-plugins/terraform/index.js';
import vercelIacPlugin from '../../src/iac-plugins/vercel/index.js';

// The SDK boundary is cut at the FACT layer. Built-in plugins are the dogfood: they are authored
// against the public `@repovine/plugin-sdk` package exactly as a third-party plugin would be. This law cements
// three consequences ts-jest's transpile-only mode cannot (no compile guard fires in test/):
//   - a plugin never imports the core types/ontology/projection layers directly — only `@repovine/plugin-sdk`
//     plus a small allowlist of mechanical engine utilities.
//   - every built-in plugin went through a `define*` factory (carries the stamped apiVersion).
//   - the SDK facade does not re-export the ontology (GraphDelta/NodeType/EdgeKind/Interpreter).
describe('core-laws plugin-sdk boundary (facts-only SDK seam)', () => {
  function findSrcRoot(): string {
    const candidates = [
      path.resolve(process.cwd(), 'src'),
      path.resolve(process.cwd(), 'repovine', 'src'),
    ];
    const root = candidates.find(candidate => fs.existsSync(candidate));
    if (!root) throw new Error(`Could not find src root. Tried: ${candidates.join(', ')}`);
    return root;
  }

  function* walkTsFiles(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkTsFiles(full);
        continue;
      }
      if (entry.isFile() && full.endsWith('.ts')) yield full;
    }
  }

  // Mechanical engine utilities a producer legitimately shares (hashing, scan filters, id/path
  // helpers, logging). These are plumbing, not the contract/ontology, so they stay allowlisted —
  // relocating them into the published SDK package is a packaging concern, not a boundary
  // violation today. This Set is the ONLY core surface a plugin may reach by relative import; the
  // check below is a strict allowlist, not a denylist, so a NEW core module is forbidden by default
  // (no need to enumerate every layer — anything not listed here that resolves into core src/ fails).
  // What is left of the allowlist, and for whom.
  //
  // A plugin that still lives inside the engine tree reaches a small set of mechanical utilities by
  // relative import. The source vertical no longer does: it ships as its own packages, where a
  // relative escape cannot even resolve, and every one of these utilities reached it through the
  // published SDK instead. The remainder belongs to the IaC vertical until it moves too, and the
  // check stays a strict allowlist, so a NEW core module is forbidden by default.
  const ALLOWED_ENGINE_UTILS = new Set(
    [
      'stage1/utils.ts',
      'stage1/iac/utils.ts',
      'stage1/k8s-workload.ts',
      'scan-filters.ts',
      'cli/ui.ts',
      'platform/paths.ts',
      'platform/ordering.ts',
      'fs/read-dir-sorted.ts',
    ].map(rel => rel.replace(/\//g, path.sep)),
  );

  it('the migrated source vertical is gone from the engine tree', () => {
    // The allowlist above exists for plugins inside `src/`. A source implementation left there would
    // keep using it, and the law below would report a clean sweep while the coupling stayed.
    expect(fs.existsSync(path.join(findSrcRoot(), 'source-plugins'))).toBe(false);
  });

  it('plugins import only the SDK + allowlisted engine utils, never any other core module', () => {
    const srcRoot = findSrcRoot();
    const pluginRoots = [path.join(srcRoot, 'iac-plugins')];
    const importRe = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
    // A `from` clause is not the only way into a module. Side-effect imports (`import '…'`),
    // dynamic `import(…)`, and `require(…)` each reach a target with no `from`, so the primary
    // regex above misses them entirely. Scan those three no-`from` forms too, over source text, so
    // a plugin cannot smuggle a core-module reference past this law by dropping the `from` clause.
    const sideEffectImportRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
    const dynamicImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    const offenders: string[] = [];

    for (const pluginRoot of pluginRoots) {
      for (const file of walkTsFiles(pluginRoot)) {
        const text = fs.readFileSync(file, 'utf8');
        const specs: string[] = [];
        for (const re of [importRe, sideEffectImportRe, dynamicImportRe, requireRe]) {
          for (const m of text.matchAll(re)) specs.push(m[1]!);
        }
        for (const spec of specs) {
          // Bare specifiers are the SDK contract (`@repovine/plugin-sdk`), node builtins, and
          // language tooling (typescript / ts-morph / vue) — none is the core-boundary concern.
          if (!spec.startsWith('.')) continue;
          // Resolve to an absolute .ts path (specifiers use the .js extension at runtime).
          const absJs = path.resolve(path.dirname(file), spec);
          const absTs = absJs.replace(/\.js$/, '.ts');
          const rel = path.relative(srcRoot, absTs);
          // Intra-plugin imports stay within the producer's own tree.
          if (rel.startsWith('iac-plugins' + path.sep)) continue;
          // Allowlist: every relative import that escapes the plugin tree must land on a sanctioned
          // mechanical engine util. Anything else resolving into core src/ — ontology (`types`),
          // projection (`graph`), interpreters, MCP, analysis, OR any not-yet-classified core module
          // — is a boundary violation and is reported.
          if (ALLOWED_ENGINE_UTILS.has(rel)) continue;
          offenders.push(`${path.relative(srcRoot, file)} → ${spec}`);
        }
      }
    }
    // A new core import from a plugin is exactly the coupling this law forbids. Route the fact type
    // through `@repovine/plugin-sdk`, or move the dependency into the engine.
    expect(offenders).toEqual([]);
  });

  it('every built-in plugin was authored through a define* factory (stamped apiVersion)', () => {
    const sourcePlugins = [typescriptPlugin, pythonPlugin];
    const iacPlugins = [
      samIacPlugin,
      helmIacPlugin,
      kubernetesIacPlugin,
      dockerComposeIacPlugin,
      dockerfileIacPlugin,
      terraformIacPlugin,
      vercelIacPlugin,
    ];
    for (const plugin of [...sourcePlugins, ...iacPlugins]) {
      expect(plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    }
  });

  it('the SDK facade never re-exports the ontology (layer-2/3 stays core-only)', () => {
    const srcRoot = findSrcRoot();
    const sdkIndex = fs.readFileSync(path.join(srcRoot, '..', 'packages', 'plugin-sdk', 'src', 'index.ts'), 'utf8');
    // Scan only `export …` statements, not the doc comments (which intentionally NAME the excluded
    // ontology types to document the boundary). Strip /* */ blocks and // lines first.
    const exportLines = sdkIndex
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(line => line.trim().startsWith('export ') && !line.trim().startsWith('//'));
    const exportSource = exportLines.join('\n');
    const FORBIDDEN_EXPORTS = ['GraphDelta', 'RepositoryGraph', 'NodeType', 'EdgeKind', 'Interpreter'];
    for (const name of FORBIDDEN_EXPORTS) {
      // Word-boundary match so a substring like `EdgeKindMeta` would not false-positive; there is no
      // such export today, this guards future drift.
      const re = new RegExp(`\\b${name}\\b`);
      expect({ name, leaks: re.test(exportSource) }).toEqual({ name, leaks: false });
    }
    // Name-grepping the five types is blind to a wildcard re-export: `export * from '…'` pulls in
    // every name of its target (including the ontology) without spelling any forbidden name. The
    // facade curates named exports only. A wildcard whose target escapes the SDK package (into core
    // src/), or any bare-specifier wildcard, re-exports an unbounded surface and can leak the
    // ontology — so flag those forms. None exist today.
    const sdkSrcDir = path.join(srcRoot, '..', 'packages', 'plugin-sdk', 'src');
    const wildcardRe = /export\s+(?:type\s+)?\*\s*(?:as\s+\w+\s+)?from\s*['"]([^'"]+)['"]/g;
    const wildcardLeaks: string[] = [];
    for (const m of exportSource.matchAll(wildcardRe)) {
      const spec = m[1]!;
      if (spec.startsWith('.')) {
        // A same-package relative wildcard re-exports only SDK-local facts; an escape reaches core.
        const absTs = path.resolve(sdkSrcDir, spec).replace(/\.js$/, '.ts');
        if (!path.relative(sdkSrcDir, absTs).startsWith('..' + path.sep) && path.relative(sdkSrcDir, absTs) !== '..') {
          continue;
        }
      }
      wildcardLeaks.push(spec);
    }
    expect(wildcardLeaks).toEqual([]);
  });

  // The three checks above bind the FIRST party: they read this repository's own sources. An
  // installed plugin runs none of them, so for a third party the boundary holds only as far as
  // packaging enforces it. Without an `exports` map Node resolves any path inside the package
  // directory, and `repovine/dist/graph/index.js` hands out the projection layer the facade
  // deliberately withholds. The map makes Node itself refuse — detection is not needed when the
  // resolver never completes.
  it('an installed engine exposes no importable module path (the SDK package is the only way in)', () => {
    const repoRoot = path.resolve(findSrcRoot(), '..');
    const srcRoot = findSrcRoot();

    // Probe list is DERIVED from the tree, so a new core directory is covered the day it appears
    // and an empty list cannot pass this law by vacuity.
    const internals: string[] = [];
    for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) internals.push(`repovine/dist/${entry.name}/index.js`);
      else if (entry.name.endsWith('.ts')) internals.push(`repovine/dist/${entry.name.replace(/\.ts$/, '.js')}`);
    }
    expect(internals.length).toBeGreaterThan(20);

    // A minimal installed-package fixture: the published manifest, nothing else. `exports` is
    // consulted before the file is looked for, so the verdict does not depend on a built `dist/`.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-exports-'));
    try {
      const installed = path.join(tmpRoot, 'node_modules', 'repovine');
      fs.mkdirSync(installed, { recursive: true });
      fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(installed, 'package.json'));
      fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{"name":"boundary-probe","type":"module"}\n');

      // Control package: same layout, no `exports` map. It proves the probe below can REACH an
      // internal path when nothing refuses it — a control taken from the package under test would
      // only prove that package agrees with itself.
      const control = path.join(tmpRoot, 'node_modules', 'no-exports-control');
      fs.mkdirSync(path.join(control, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(control, 'package.json'), '{"name":"no-exports-control","version":"0.0.0","type":"module"}\n');
      fs.writeFileSync(path.join(control, 'dist', 'internal.js'), 'export const reached = true;\n');

      // Resolution has to be Node's own, in Node's own process: the jest resolver answers from this
      // repository's layout and would never consult the installed manifest.
      const specs = [...internals, 'repovine/package.json', 'no-exports-control/dist/internal.js'];
      const probe = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', [
          'const out = {};',
          'for (const spec of JSON.parse(process.env.PROBE_SPECS)) {',
          '  try { await import(spec); out[spec] = "RESOLVED"; }',
          '  catch (e) { out[spec] = e.code ?? "UNKNOWN"; }',
          '}',
          'process.stdout.write(JSON.stringify(out));',
        ].join('\n')],
        { cwd: tmpRoot, encoding: 'utf8', env: { ...process.env, PROBE_SPECS: JSON.stringify(specs) } },
      );
      expect(probe.status).toBe(0);
      const verdicts = JSON.parse(probe.stdout) as Record<string, string>;

      // Positive control, taken from a package that is NOT the one under test: an internal path of a
      // package without an `exports` map resolves. Without this the assertion below would also pass
      // in a fixture where nothing resolves at all, and it would prove nothing about the map.
      expect({ control: 'no-exports package', verdict: verdicts['no-exports-control/dist/internal.js'] })
        .toEqual({ control: 'no-exports package', verdict: 'RESOLVED' });

      // The manifest stays readable: closed to code, open to introspection. Asserted separately from
      // the control above, so a change to either is legible on its own.
      const manifest = verdicts['repovine/package.json'];
      expect({ subpath: 'package.json', blockedByExports: manifest === 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
        .toEqual({ subpath: 'package.json', blockedByExports: false });

      // `ERR_PACKAGE_PATH_NOT_EXPORTED` is the map refusing. `ERR_MODULE_NOT_FOUND` would mean the
      // map is gone and the path merely happens to be absent from this fixture — a green that says
      // nothing about an installed tree, where the file is present.
      const reachable = internals.filter(spec => verdicts[spec] !== 'ERR_PACKAGE_PATH_NOT_EXPORTED');
      expect(reachable).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
