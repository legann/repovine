import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { PLUGIN_API_VERSION, validatePluginManifest, validatePluginRuntimeDescriptor } from '@repovine/plugin-sdk';
import { repoRoot } from './graph-law-helpers.js';

/**
 * Law: the public plugin API is written down, entered by four subpaths, and still loads a plugin
 * built against API 1.
 *
 * Three separate claims, because they fail for different reasons:
 *
 *   1. the inventory in `docs/plugin-api-report.md` matches the built declarations, so a change to
 *      the surface arrives as a reviewable diff instead of as a surprise for an author;
 *   2. the `exports` map is the whole entrance, so a private path does not resolve for an installed
 *      plugin — the resolver refuses, rather than a guard noticing afterwards;
 *   3. a plugin frozen against API 1 still validates. That fixture is never recompiled, which is
 *      what makes it different from every other gate here.
 *
 * None of this declares API 1 stable. It is the machinery a stability decision would rest on.
 */

const SDK_ROOT = path.join(repoRoot(), 'packages', 'plugin-sdk');
const EXPECTED_SUBPATHS = ['.', './iac-plugin', './plugin', './source-plugin'];

interface SdkManifest {
  version?: string;
  type?: string;
  exports?: Record<string, Record<string, string>>;
}

function sdkManifest(): SdkManifest {
  return JSON.parse(fs.readFileSync(path.join(SDK_ROOT, 'package.json'), 'utf8')) as SdkManifest;
}

describe('core-laws the public plugin API surface is inventoried', () => {
  it('has a report that matches the built declarations', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot(), 'scripts', 'generate-plugin-api-report.mjs'), '--check'],
      { cwd: repoRoot(), encoding: 'utf8' },
    );
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().length).toBeGreaterThan(0);
    expect({ status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` })
      .toEqual({ status: 0, output: expect.stringContaining('is current') });
  });

  it('reports a non-trivial surface on every published subpath', () => {
    // A report generated from a broken build would be a short file that agrees with itself, and the
    // check above would pass. The counts are read back so vacuity is caught here.
    const report = fs.readFileSync(path.join(repoRoot(), 'docs', 'plugin-api-report.md'), 'utf8');
    for (const subpath of EXPECTED_SUBPATHS) {
      const specifier = `@repovine/plugin-sdk${subpath.slice(1)}`;
      const row = new RegExp(`\\| \`${specifier.replace(/[/.]/g, '\\$&')}\` \\| (\\d+) \\|`).exec(report);
      expect({ specifier, found: row !== null }).toEqual({ specifier, found: true });
      expect({ specifier, count: Number(row![1]) > 10 }).toEqual({ specifier, count: true });
    }
    expect(report).toContain('do not edit by hand');
  });
});

describe('core-laws the SDK exports map is the whole entrance', () => {
  it('publishes exactly the four subpaths, import-only, with types', () => {
    const manifest = sdkManifest();
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual(EXPECTED_SUBPATHS);
    expect(manifest.type).toBe('module');
    for (const [subpath, conditions] of Object.entries(manifest.exports ?? {})) {
      // `import` and `types` only. A `require` condition would publish a second resolution of the
      // same surface under CJS conditions, and `./package.json` would hand out the manifest.
      expect({ subpath, conditions: Object.keys(conditions).sort() })
        .toEqual({ subpath, conditions: ['import', 'types'] });
      expect({ subpath, dist: conditions.import.startsWith('./dist/') })
        .toEqual({ subpath, dist: true });
    }
    expect(manifest.exports?.['./package.json']).toBeUndefined();
  });

  it('refuses every private path for an installed plugin', () => {
    // Node's own resolver, in its own process, against a fixture that carries only the manifest:
    // `exports` is consulted before the file is looked for, so the verdict does not need a built dist.
    const probes = [
      '@repovine/plugin-sdk/dist/index.js',
      '@repovine/plugin-sdk/dist/plugin/index.js',
      '@repovine/plugin-sdk/src/index.ts',
      '@repovine/plugin-sdk/package.json',
      '@repovine/plugin-sdk/internal',
    ];
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-exports-'));
    try {
      const installed = path.join(tmpRoot, 'node_modules', '@repovine', 'plugin-sdk');
      fs.mkdirSync(installed, { recursive: true });
      fs.copyFileSync(path.join(SDK_ROOT, 'package.json'), path.join(installed, 'package.json'));
      fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{"name":"sdk-exports-probe","type":"module"}\n');

      // Control package: same layout, no `exports` map. Without it, an assertion that nothing
      // resolves would also pass in a fixture where nothing can resolve at all.
      const control = path.join(tmpRoot, 'node_modules', 'no-exports-control');
      fs.mkdirSync(path.join(control, 'dist'), { recursive: true });
      fs.writeFileSync(
        path.join(control, 'package.json'),
        '{"name":"no-exports-control","version":"0.0.0","type":"module"}\n',
      );
      fs.writeFileSync(path.join(control, 'dist', 'internal.js'), 'export const reached = true;\n');

      const specs = [...probes, 'no-exports-control/dist/internal.js', '@repovine/plugin-sdk'];
      const probe = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', [
          'const out = {};',
          'for (const spec of JSON.parse(process.env.PROBE_SPECS)) {',
          // Resolution either answers or throws, and the throw carries the verdict.
          '  try { import.meta.resolve(spec); out[spec] = "RESOLVED"; }',
          '  catch (e) { out[spec] = e.code ?? "UNKNOWN"; }',
          '}',
          'process.stdout.write(JSON.stringify(out));',
        ].join('\n')],
        { cwd: tmpRoot, encoding: 'utf8', env: { ...process.env, PROBE_SPECS: JSON.stringify(specs) } },
      );
      expect(probe.status).toBe(0);
      const verdicts = JSON.parse(probe.stdout) as Record<string, string>;

      // Positive control, from a package that is not the one under test.
      expect({ control: 'no-exports package', verdict: verdicts['no-exports-control/dist/internal.js'] })
        .toEqual({ control: 'no-exports package', verdict: 'RESOLVED' });
      // The public entrance is open: a law where nothing resolves proves nothing about the map.
      expect({ entrance: '.', verdict: verdicts['@repovine/plugin-sdk'] })
        .toEqual({ entrance: '.', verdict: 'RESOLVED' });

      // `ERR_PACKAGE_PATH_NOT_EXPORTED` is the map refusing. `ERR_MODULE_NOT_FOUND` would mean the
      // map is gone and the path merely happens to be absent from this fixture.
      const reachable = probes.filter(spec => verdicts[spec] !== 'ERR_PACKAGE_PATH_NOT_EXPORTED');
      expect(reachable).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('core-laws a plugin frozen against API 1 still loads', () => {
  const fixture = path.join(repoRoot(), 'test', 'fixtures', 'api-1-compat');

  it('is checked in prebuilt, with no build step of its own', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      repovine?: { apiVersion?: number; entry?: string };
    };
    // No devDependencies and no scripts: there is nothing here that a `npm run build` could refresh,
    // which is what makes the fixture able to fail.
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.repovine?.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(fs.existsSync(path.join(fixture, 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(fixture, 'tsconfig.json'))).toBe(false);

    // It reaches the SDK for nothing at all, so a helper changing shape cannot be what breaks it.
    const source = fs.readFileSync(path.join(fixture, 'index.js'), 'utf8');
    expect(source).not.toContain('@repovine/plugin-sdk');
    expect(source).not.toContain('import ');
  });

  it('validates as a manifest and a descriptor against today\'s contract', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8')) as {
      repovine: unknown;
    };
    const manifestVerdict = validatePluginManifest(manifest.repovine);
    expect(manifestVerdict.ok ? [] : manifestVerdict.error).toEqual([]);
    expect(manifestVerdict.ok).toBe(true);

    const descriptor = (await import(path.join(fixture, 'index.js'))).default as unknown;
    const descriptorVerdict = validatePluginRuntimeDescriptor(descriptor);
    expect(descriptorVerdict.ok ? [] : descriptorVerdict.error).toEqual([]);
    expect(descriptorVerdict.ok).toBe(true);
    expect((descriptor as { id: string }).id).toBe('legacy-api-1');
  });

  it('still parses its document into resources and a declared trigger', async () => {
    const descriptor = (await import(path.join(fixture, 'index.js'))).default as {
      capabilities: {
        iac: {
          parsers: Array<{
            kind: string;
            supports(absPath: string, doc: unknown): boolean;
            parse(absPath: string, repoRelPath: string, doc: unknown): {
              kind: string;
              resources: Array<{ identity: { namespace: string; localKey: string }; contentHash: string;
                triggers?: Array<{ type: string }>; }>;
            } | null;
          }>;
        };
      };
    };
    const parser = descriptor.capabilities.iac.parsers[0]!;
    const doc = JSON.parse(fs.readFileSync(path.join(fixture, 'repo', 'legacy-stack.json'), 'utf8'));

    expect(parser.supports('legacy-stack.json', doc)).toBe(true);
    const delta = parser.parse('/repo/legacy-stack.json', 'legacy-stack.json', doc);
    expect(delta?.kind).toBe('legacy-stack');
    expect(delta?.resources.map(resource => resource.identity.localKey)).toEqual(['reaper', 'sweeper']);
    // Producer-owned hashes, and distinct per resource: a constant would satisfy a presence check.
    const hashes = delta!.resources.map(resource => resource.contentHash);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(delta?.resources[0]?.triggers?.[0]?.type).toBe('legacy-tick');
  });
});
