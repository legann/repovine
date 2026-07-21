import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLUGIN_API_VERSION } from '@repovine/plugin-sdk';
import typescriptPlugin from '../../src/source-plugins/typescript/index.js';
import pythonPlugin from '../../src/source-plugins/python/index.js';
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
  const ALLOWED_ENGINE_UTILS = new Set(
    [
      'stage1/utils.ts',
      'stage1/iac/utils.ts',
      'stage1/k8s-workload.ts',
      'scan-filters.ts',
      'cli/ui.ts',
    ].map(rel => rel.replace(/\//g, path.sep)),
  );

  it('plugins import only the SDK + allowlisted engine utils, never any other core module', () => {
    const srcRoot = findSrcRoot();
    const pluginRoots = [path.join(srcRoot, 'source-plugins'), path.join(srcRoot, 'iac-plugins')];
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
          if (rel.startsWith('source-plugins' + path.sep) || rel.startsWith('iac-plugins' + path.sep)) {
            continue;
          }
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
});
