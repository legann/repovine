import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_API_VERSION, validatePluginRuntimeDescriptor } from '@repovine/plugin-sdk';
import typescriptPlugin from '../../packages/plugins/source-typescript/src/index.js';
import pythonPlugin from '../../packages/plugins/source-python/src/index.js';
import { samIacPlugin } from '../../packages/plugins/iac-sam/src/index.js';
import { helmIacPlugin } from '../../packages/plugins/iac-helm/src/index.js';
import { kubernetesIacPlugin } from '../../packages/plugins/iac-kubernetes/src/index.js';
import { dockerComposeIacPlugin } from '../../packages/plugins/iac-docker-compose/src/index.js';
import { dockerfileIacPlugin } from '../../packages/plugins/iac-dockerfile/src/index.js';
import { terraformIacPlugin } from '../../packages/plugins/iac-terraform/src/index.js';
import { vercelIacPlugin } from '../../packages/plugins/iac-vercel/src/index.js';

// The SDK boundary is cut at the FACT layer. Built-in plugins are the dogfood: they are authored
// against the public `@repovine/plugin-sdk` package exactly as a third-party plugin would be. This law cements
// three consequences ts-jest's transpile-only mode cannot (no compile guard fires in test/):
//   - no producer implementation is left inside the engine tree.
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

  /**
   * The allowlist of mechanical engine utilities is gone, and so is the scan that consulted it.
   *
   * It existed for producers that lived inside `src/`: they reached hashing, scan filters, id/path
   * helpers and logging by relative import, and the allowlist recorded which of those reaches were
   * sanctioned. Both verticals now ship as their own packages, and inside a package a relative
   * escape does not resolve at all — `plugin-workspace-boundary` reads every specifier in
   * `packages/plugins/**` and reports one that leaves its package. Keeping a second scan here over
   * an empty allowlist and a directory that no longer exists would report a clean sweep of nothing.
   *
   * What remains here is the premise that retirement rests on: no producer tree in `src/`. A
   * producer put back would be outside `packages/plugins/**`, so the workspace law would not see it
   * either, and this is where that reappearance is caught.
   */
  it('no producer implementation is left in the engine tree', () => {
    const srcRoot = findSrcRoot();
    const producerTrees = fs.readdirSync(srcRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /-plugins$/.test(entry.name))
      .map(entry => entry.name)
      .sort();
    expect(producerTrees).toEqual([]);
  });

  it('every built-in package publishes a valid runtime descriptor', () => {
    const descriptors = [
      typescriptPlugin,
      pythonPlugin,
      samIacPlugin,
      helmIacPlugin,
      kubernetesIacPlugin,
      dockerComposeIacPlugin,
      dockerfileIacPlugin,
      terraformIacPlugin,
      vercelIacPlugin,
    ];
    for (const descriptor of descriptors) {
      const validated = validatePluginRuntimeDescriptor(descriptor);
      expect(validated.ok ? validated.declared : validated.error).not.toHaveLength(0);
      expect(validated.ok).toBe(true);
    }
    // The API version is the manifest's, not a field a descriptor stamps: one number per package,
    // read before any of this code runs.
    expect(PLUGIN_API_VERSION).toBe(1);
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
