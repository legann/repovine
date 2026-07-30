import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { PLUGIN_API_VERSION, validatePluginManifest, validatePluginRuntimeDescriptor } from '@repovine/plugin-sdk';
import { repoRoot } from './graph-law-helpers.js';

/**
 * Law: the public plugin API is written down, entered by four authoring subpaths, and still loads a
 * plugin built against API 1.
 *
 * Four separate claims, because they fail for different reasons:
 *
 *   1. the inventory in `docs/plugin-api-report.md` matches the built declarations, so a change to
 *      the surface arrives as a reviewable diff instead of as a surprise for an author;
 *   2. the runtime surface matches the written register in `docs/plugin-api-contract.json`. The
 *      register is written, not derived: counting importers was measured against all 78 runtime
 *      exports of the pre-move surface and misclassified roughly 20 names in both directions,
 *      because a built-in writes a closed-vocabulary literal rather than importing the constant that
 *      publishes it. A closed vocabulary exists so an author CAN enumerate it, so a missing import
 *      says nothing about whether the name is contract;
 *   3. the `exports` map is the whole entrance, and the AUTHORING half of it is exactly four
 *      subpaths. A fifth may exist — `./internal` does — and then it carries no compatibility
 *      promise: it is marked not-contract in the report and left out of the frozen count. A private
 *      path still does not resolve for an installed plugin;
 *   4. a plugin frozen against API 1 still validates. That fixture is never recompiled, which is
 *      what makes it different from every other gate here.
 *
 * None of this declares API 1 stable. It is the machinery a stability decision rests on, and under
 * preview the register covers runtime names only — type exports are the named remainder.
 */

const SDK_ROOT = path.join(repoRoot(), 'packages', 'plugin-sdk');
const AUTHORING_SUBPATHS = ['.', './iac-plugin', './plugin', './source-plugin'];

interface SdkManifest {
  version?: string;
  type?: string;
  exports?: Record<string, Record<string, string>>;
}

interface ContractRegister {
  why?: string[];
  contractSubpaths: string[];
  nonContractSubpaths: Record<string, string>;
  values: Record<string, string[]>;
}

function sdkManifest(): SdkManifest {
  return JSON.parse(fs.readFileSync(path.join(SDK_ROOT, 'package.json'), 'utf8')) as SdkManifest;
}

function contractRegister(): ContractRegister {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot(), 'docs', 'plugin-api-contract.json'), 'utf8'),
  ) as ContractRegister;
}

function reportText(): string {
  return fs.readFileSync(path.join(repoRoot(), 'docs', 'plugin-api-report.md'), 'utf8');
}

/** The report's per-subpath sections, keyed by subpath, with each export's kind. */
function reportSections(report: string): Map<string, { body: string; exports: Array<{ name: string; kind: string }> }> {
  const out = new Map<string, { body: string; exports: Array<{ name: string; kind: string }> }>();
  for (const chunk of report.split(/^## `/m).slice(1)) {
    const specifier = chunk.slice(0, chunk.indexOf('`'));
    const subpath = specifier === '@repovine/plugin-sdk'
      ? '.'
      : `.${specifier.slice('@repovine/plugin-sdk'.length)}`;
    const exports = [...chunk.matchAll(/^\| `([^`]+)` \| (\w+) \|$/gm)]
      .map(m => ({ name: m[1]!, kind: m[2]! }));
    out.set(subpath, { body: chunk, exports });
  }
  return out;
}

const valueExports = (entries: Array<{ name: string; kind: string }>): string[] =>
  entries.filter(entry => entry.kind !== 'type' && entry.kind !== 'interface')
    .map(entry => entry.name)
    .sort();

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

  it('reports a non-trivial surface on every authoring subpath', () => {
    // A report generated from a broken build would be a short file that agrees with itself, and the
    // check above would pass. The counts are read back so vacuity is caught here.
    const report = reportText();
    for (const subpath of AUTHORING_SUBPATHS) {
      const specifier = `@repovine/plugin-sdk${subpath.slice(1)}`;
      const row = new RegExp(`\\| \`${specifier.replace(/[/.]/g, '\\$&')}\` \\| (\\d+) \\|`).exec(report);
      expect({ specifier, found: row !== null }).toEqual({ specifier, found: true });
      expect({ specifier, count: Number(row![1]) > 10 }).toEqual({ specifier, count: true });
    }
    expect(report).toContain('do not edit by hand');
  });
});

describe('core-laws the written contract register is what the barrel publishes', () => {
  it('registers exactly the four authoring subpaths, and accounts for every other one', () => {
    const register = contractRegister();
    expect([...register.contractSubpaths].sort()).toEqual(AUTHORING_SUBPATHS);

    // Every subpath the manifest publishes is classified, one way or the other. A new subpath that
    // nobody classified is the failure this catches: it would otherwise arrive unmarked and be read
    // as contract by the next person who looks at the report.
    const published = Object.keys(sdkManifest().exports ?? {}).sort();
    const classified = [
      ...register.contractSubpaths,
      ...Object.keys(register.nonContractSubpaths),
    ].sort();
    expect(classified).toEqual(published);

    // Each non-contract subpath states WHY in a sentence a reader can act on, not a bare flag.
    for (const [subpath, reason] of Object.entries(register.nonContractSubpaths)) {
      expect({ subpath, explained: reason.trim().length > 40 }).toEqual({ subpath, explained: true });
    }
  });

  it('lists the same runtime names the built declarations publish', () => {
    // Value exports only. Type exports are the named remainder of preview: nothing registers them,
    // and this law says so rather than pretending the register is complete.
    const register = contractRegister();
    const sections = reportSections(reportText());
    for (const subpath of register.contractSubpaths) {
      const section = sections.get(subpath);
      expect({ subpath, inReport: section !== undefined }).toEqual({ subpath, inReport: true });
      // A register entry that is not published, and a published name that nobody registered, are
      // both failures: the second is the surface growing where nobody looked.
      expect({ subpath, names: valueExports(section!.exports) })
        .toEqual({ subpath, names: [...register.values[subpath] ?? []].sort() });
    }
  });

  it('registers no name that only a non-contract subpath publishes', () => {
    // The relocation this law was rewritten for: ten host names left the authoring barrels for
    // `./internal`. A name that reappeared in the register would be back on the contract without
    // anyone deciding it, which is exactly the move `./internal` exists to prevent.
    const register = contractRegister();
    const sections = reportSections(reportText());
    const registered = new Set(Object.values(register.values).flat());
    const contractPublished = new Set(
      register.contractSubpaths.flatMap(subpath => valueExports(sections.get(subpath)?.exports ?? [])),
    );

    const leaked: string[] = [];
    for (const subpath of Object.keys(register.nonContractSubpaths)) {
      for (const name of valueExports(sections.get(subpath)?.exports ?? [])) {
        if (registered.has(name) && !contractPublished.has(name)) leaked.push(`${subpath}: ${name}`);
      }
    }
    expect(leaked).toEqual([]);

    // Non-vacuity: the non-contract half is not empty, so the sweep above ran over something.
    const nonContractNames = Object.keys(register.nonContractSubpaths)
      .flatMap(subpath => valueExports(sections.get(subpath)?.exports ?? []));
    expect(nonContractNames.length).toBeGreaterThan(0);
  });

  it('marks every non-contract subpath in the report and leaves it out of the frozen count', () => {
    const register = contractRegister();
    const report = reportText();
    const sections = reportSections(report);

    for (const subpath of Object.keys(register.nonContractSubpaths)) {
      const section = sections.get(subpath);
      expect({ subpath, inReport: section !== undefined }).toEqual({ subpath, inReport: true });
      expect({ subpath, marked: section!.body.includes('**NOT CONTRACT.**') })
        .toEqual({ subpath, marked: true });
    }
    for (const subpath of register.contractSubpaths) {
      expect({ subpath, marked: sections.get(subpath)!.body.includes('**NOT CONTRACT.**') })
        .toEqual({ subpath, marked: false });
    }

    // The frozen number is the sum over contract subpaths alone. Asserted against the sections
    // rather than restated: a total copied from the summary row would agree with itself.
    const frozen = Number(/\| \*\*contract total\*\* \| \*\*(\d+)\*\* \|/.exec(report)?.[1]);
    const expected = register.contractSubpaths
      .reduce((sum, subpath) => sum + (sections.get(subpath)?.exports.length ?? 0), 0);
    expect({ frozen, expected }).toEqual({ frozen: expected, expected });

    const outside = Number(/\| outside the contract \| (\d+) \|/.exec(report)?.[1]);
    const outsideExpected = Object.keys(register.nonContractSubpaths)
      .reduce((sum, subpath) => sum + (sections.get(subpath)?.exports.length ?? 0), 0);
    expect({ outside, outsideExpected }).toEqual({ outside: outsideExpected, outsideExpected });
    // The two halves are disjoint and cover the whole map: a subpath counted in neither, or in both,
    // would leave a name reachable and unaccounted for.
    const everySection = [...sections.values()].reduce((sum, section) => sum + section.exports.length, 0);
    expect(frozen + outside).toBe(everySection);
  });

  it('turns red when a subpath appears without being classified (kill mutation)', () => {
    // The register is data, so the mutation is data: publish a subpath and register nothing about
    // it. Run against copies, so the tree is untouched.
    const register = contractRegister();
    const manifest = sdkManifest();
    const published = Object.keys({ ...manifest.exports, './experimental': {} }).sort();
    const classified = [
      ...register.contractSubpaths,
      ...Object.keys(register.nonContractSubpaths),
    ].sort();
    expect(classified).not.toEqual(published);

    // And the reverse form: a subpath registered as contract that the manifest does not publish.
    const overRegistered = [...register.contractSubpaths, './ghost'].sort();
    expect(overRegistered).not.toEqual(Object.keys(manifest.exports ?? {}).sort());
  });
});

describe('core-laws the SDK exports map is the whole entrance', () => {
  it('publishes the four authoring subpaths plus the classified rest, import-only, with types', () => {
    const manifest = sdkManifest();
    const register = contractRegister();
    const published = Object.keys(manifest.exports ?? {}).sort();
    // Four authoring subpaths, and every additional one accounted for as not-contract. A fifth
    // authoring subpath cannot arrive silently: it would have to be added to the register first.
    expect(published.filter(subpath => register.contractSubpaths.includes(subpath)))
      .toEqual(AUTHORING_SUBPATHS);
    expect(published.filter(subpath => !register.contractSubpaths.includes(subpath)))
      .toEqual(Object.keys(register.nonContractSubpaths).sort());

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
      // `./internal` resolves; the path BEHIND it does not. A subpath outside semver is still a
      // single named door, not a hole in the map.
      '@repovine/plugin-sdk/dist/internal/index.js',
      '@repovine/plugin-sdk/internal/index.js',
      '@repovine/plugin-sdk/src/index.ts',
      '@repovine/plugin-sdk/package.json',
      '@repovine/plugin-sdk/experimental',
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

      const specs = [
        ...probes,
        'no-exports-control/dist/internal.js',
        '@repovine/plugin-sdk',
        '@repovine/plugin-sdk/internal',
      ];
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
      // Both open doors: a law where nothing resolves proves nothing about the map.
      expect({ entrance: '.', verdict: verdicts['@repovine/plugin-sdk'] })
        .toEqual({ entrance: '.', verdict: 'RESOLVED' });
      expect({ entrance: './internal', verdict: verdicts['@repovine/plugin-sdk/internal'] })
        .toEqual({ entrance: './internal', verdict: 'RESOLVED' });

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
