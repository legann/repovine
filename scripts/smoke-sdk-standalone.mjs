#!/usr/bin/env node
/**
 * Standalone plugin-package gate: author a plugin outside this repository and prove it compiles and
 * conforms against nothing but the packed SDK.
 *
 * The in-repo built-ins resolve `@repovine/plugin-sdk` through npm workspaces, so they cannot tell
 * whether the published contract is complete — a type that never left `packages/` still resolves for
 * them. This smoke packs the SDK, installs it into a fixture that is not a workspace member, and
 * compiles a plugin whose only product import is the installed tarball.
 *
 *   node scripts/smoke-sdk-standalone.mjs [--keep]
 *
 * Requires registry access for the SDK's zod peer dependency.
 */
import { nodeOutput, runNode, runNpm } from './lib/spawn.cjs';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enginePkg = JSON.parse(readFileSync(path.join(engineRoot, 'package.json'), 'utf-8'));
const sdkPkg = JSON.parse(readFileSync(path.join(engineRoot, 'packages', 'plugin-sdk', 'package.json'), 'utf-8'));
const keep = process.argv.includes('--keep');

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures.push(message);
};

/**
 * Run a probe inside the fixture and parse its JSON. A probe that cannot even start is a failed
 * check with a named cause, not a stack trace out of this script: the operator needs to know which
 * question went unanswered.
 */
function probe(what, args, options, fallback) {
  try {
    return JSON.parse(nodeOutput(args, options));
  } catch (e) {
    const detail = String(e.stderr ?? e.message ?? e).split('\n').slice(0, 3).join(' ');
    check(false, `${what} (probe failed: ${detail})`);
    return fallback;
  }
}

function npm(args, cwd) {
  const res = runNpm(args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`npm ${args.join(' ')} exited ${res.status}\n${res.stderr || ''}`);
  return res.stdout;
}

/**
 * The fixture plugin, authored the way an independent package is: one product dependency, the
 * public root barrel and the `./plugin` subpath, no relative path out of its own `src`.
 *
 * It carries every capability the contract defines and, beside the honest descriptor, three mutants
 * a JavaScript plugin could ship. The mutants are what the conformance gate has to reject.
 */
const FIXTURE_SOURCE = `import {
  definePlugin,
  checkPluginConformance,
  makeResourceId,
} from '@repovine/plugin-sdk';
import type {
  DocumentLoader,
  PluginProjectionBatch,
  PluginRuntimeDescriptor,
  ProjectionContributor,
  ReadonlyProjectionInput,
  SourceRuntimeCapability,
} from '@repovine/plugin-sdk/plugin';

const NAMESPACE = 'standalone';

const source: SourceRuntimeCapability = {
  fileMatch: { extensions: ['.sa'] },
  capabilities: { extensions: ['.sa'], moduleIdNormalize: { stripSuffixes: ['.sa'] } },
  discover() {
    return { packages: [], pendingByAbsPath: new Map() };
  },
  extract() {
    return { deltas: [], reused: 0, rescanned: 0 };
  },
};

const loader: DocumentLoader = {
  id: 'standalone-json',
  load(input) {
    return [{ documentKey: input.repoRelPath, value: JSON.parse(new TextDecoder().decode(input.content)) }];
  },
};

/** One resource, one link and one namespaced extension, all through structured references. */
const projector: ProjectionContributor = {
  id: 'standalone-projector',
  requires: [{ schema: 'standalone/stack@1' }],
  project(input: ReadonlyProjectionInput): readonly PluginProjectionBatch[] {
    const moduleId = input.facts.moduleIds()[0];
    if (moduleId === undefined) return [];
    return [{
      batchId: 'stack.json',
      delta: {
        resources: [{
          namespace: NAMESPACE,
          localKey: 'queue:orders',
          provider: 'standalone',
          kind: 'queue',
          contentHash: 'abc123',
        }],
        links: [{
          from: { type: 'module', moduleId },
          to: { type: 'resource', namespace: NAMESPACE, localKey: 'queue:orders' },
          relation: 'publishes',
        }],
        entrypoints: [{ kind: 'api-route', moduleRef: { type: 'module', moduleId }, path: '/orders', method: 'GET' }],
        extensions: [{ schema: 'standalone/stack@1', localKey: 'orders', payload: { retries: 3 } }],
      },
    }];
  },
};

const descriptor: PluginRuntimeDescriptor = definePlugin({
  id: 'standalone',
  capabilities: { source, iac: undefined, loaders: [loader], projectors: [projector] },
});

/** A batch whose link points at a module the fact view never carried. */
const danglingRefProjector: ProjectionContributor = {
  id: 'dangling',
  project() {
    return [{
      batchId: 'dangling',
      delta: {
        links: [{
          from: { type: 'module', moduleId: 'mod:nowhere/absent' },
          to: { type: 'resource', namespace: NAMESPACE, localKey: 'queue:orders' },
          relation: 'consumes',
        }],
      },
    }];
  },
};

/** A batch that publishes under another owner's schema. */
const foreignExtensionProjector: ProjectionContributor = {
  id: 'foreign',
  project() {
    return [{
      batchId: 'foreign',
      delta: { extensions: [{ schema: 'typescript/routes@1', localKey: 'k', payload: {} }] },
    }];
  },
};

/** A batch that spells a minted node id where an identity component belongs. */
const rawNodeIdProjector: ProjectionContributor = {
  id: 'raw-id',
  project() {
    const raw = makeResourceId({ namespace: NAMESPACE, localKey: 'queue:orders' });
    return [{
      batchId: 'raw',
      delta: {
        resources: [{
          namespace: NAMESPACE,
          localKey: raw,
          provider: 'standalone',
          kind: 'queue',
          contentHash: 'abc123',
        }],
      },
    } as unknown as PluginProjectionBatch];
  },
};

const mutantOf = (projector: ProjectionContributor): PluginRuntimeDescriptor =>
  definePlugin({ id: 'standalone', capabilities: { projectors: [projector] } });

export const mutants: Record<string, PluginRuntimeDescriptor> = {
  'dangling reference': mutantOf(danglingRefProjector),
  'foreign extension owner': mutantOf(foreignExtensionProjector),
  'raw node id as identity component': mutantOf(rawNodeIdProjector),
};

export { checkPluginConformance };
export default descriptor;
`;

const FIXTURE_MANIFEST = {
  kind: 'plugin',
  id: 'standalone',
  apiVersion: 1,
  entry: 'dist/index.js',
  declarations: {
    ecosystem: 'standalone',
    dirs: [{ name: '.standalone-out', role: 'tool-output', because: 'standalone build artifacts' }],
    resourceKinds: [{ namespace: 'standalone', provider: 'standalone', kind: 'queue' }],
    triggerTypes: [{ type: 'standalone-http', namespace: 'standalone', provider: 'standalone', entrypointKind: 'api' }],
  },
};

// Spaces + non-ASCII in every path the install and the compiler touch.
const workRoot = mkdtempSync(path.join(os.tmpdir(), 'repovine sdk ünï-'));
const fixture = path.join(workRoot, 'standalone plugin');

try {
  console.log(`Packing @repovine/plugin-sdk@${sdkPkg.version}…`);
  check(sdkPkg.version === '0.1.0', `SDK stays on the unreleased 0.1.0 line (got ${sdkPkg.version})`);
  const sdkTgz = path.join(
    workRoot,
    npm(['pack', '-w', '@repovine/plugin-sdk', '--pack-destination', workRoot], engineRoot).trim().split('\n').pop(),
  );

  mkdirSync(path.join(fixture, 'src'), { recursive: true });
  writeFileSync(path.join(fixture, 'package.json'), `${JSON.stringify({
    name: 'repovine-plugin-standalone-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: 'dist/index.js',
    repovine: FIXTURE_MANIFEST,
  }, null, 2)}\n`);
  writeFileSync(path.join(fixture, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      declaration: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['src'],
  }, null, 2)}\n`);
  writeFileSync(path.join(fixture, 'src', 'index.ts'), FIXTURE_SOURCE);

  console.log('Installing the packed SDK into a package that is not a workspace member…');
  npm(['install', sdkTgz, `zod@${enginePkg.dependencies.zod}`, '--no-audit', '--no-fund'], fixture);

  // The fixture must reach the SDK through its own node_modules. The probe lives inside the fixture
  // and resolves the way an ESM import does — resolving from this script would find the workspace
  // copy and pass for the wrong reason.
  writeFileSync(path.join(fixture, 'resolve-probe.mjs'), `
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = {};
for (const specifier of ['@repovine/plugin-sdk', '@repovine/plugin-sdk/plugin']) {
  try { out[specifier] = realpathSync(fileURLToPath(import.meta.resolve(specifier))); }
  catch (error) { out[specifier] = { error: error?.code ?? String(error) }; }
}
process.stdout.write(JSON.stringify(out));
`);
  const resolveProbe = probe(
    'the fixture resolves the SDK',
    [path.join(fixture, 'resolve-probe.mjs')],
    { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] },
    {},
  );
  const fixtureModules = realpathSync(path.join(fixture, 'node_modules'));
  const workspaceModules = realpathSync(path.join(engineRoot, 'node_modules'));
  const insideFixture = resolved => {
    if (typeof resolved !== 'string' || !path.isAbsolute(resolved)) return false;
    const rel = path.relative(fixtureModules, resolved);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  for (const specifier of ['@repovine/plugin-sdk', '@repovine/plugin-sdk/plugin']) {
    const resolved = resolveProbe[specifier];
    check(insideFixture(resolved), `${specifier} resolves inside the fixture's own node_modules`);
    check(
      typeof resolved === 'string' && !resolved.startsWith(`${workspaceModules}${path.sep}`),
      `${specifier} does not fall back to the workspace tree`,
    );
  }

  console.log('Type-checking the standalone package against the installed tarball…');
  // The compiler binary comes from this checkout; module resolution is anchored at the fixture, so
  // what is being proven is the fixture's dependency graph, not the compiler's location.
  const tsc = runNode(
    [path.join(engineRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(fixture, 'tsconfig.json')],
    { cwd: fixture, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  check(
    tsc.status === 0,
    `standalone package compiles against @repovine/plugin-sdk alone${tsc.status === 0 ? '' : `\n${tsc.stdout || tsc.stderr}`}`,
  );
  check(
    !/from '\.\.|packages\/|repovine\/src/.test(FIXTURE_SOURCE),
    'fixture source uses no workspace, relative-escape or engine-internal import',
  );

  console.log('Running the conformance gate from the installed tarball…');
  const conformance = probe('the standalone plugin runs its conformance kit', ['--input-type=module', '-e', `
      import { pathToFileURL } from 'node:url';
      import { readFileSync } from 'node:fs';
      const entry = await import(pathToFileURL(process.env.FIXTURE_ENTRY).href);
      const manifest = JSON.parse(readFileSync(process.env.FIXTURE_MANIFEST, 'utf-8')).repovine;
      const modules = [{ moduleId: 'mod:app/index', packageName: 'app', repoRelPath: 'src/index.ts' }];
      const honest = entry.checkPluginConformance({ manifest, descriptor: entry.default, modules });
      const mutants = {};
      for (const [name, descriptor] of Object.entries(entry.mutants)) {
        const report = entry.checkPluginConformance({ manifest, descriptor, modules });
        mutants[name] = {
          passed: report.passed,
          firstFailure: report.checks.find(c => !c.ok)?.name ?? null,
        };
      }
      process.stdout.write(JSON.stringify({
        honest: { passed: honest.passed, failures: honest.checks.filter(c => !c.ok) },
        mutants,
      }));
    `],
    {
      cwd: fixture,
      env: {
        ...process.env,
        FIXTURE_ENTRY: path.join(fixture, 'dist', 'index.js'),
        FIXTURE_MANIFEST: path.join(fixture, 'package.json'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
    { honest: { passed: false, failures: ['probe did not run'] }, mutants: {} },
  );
  check(
    conformance.honest.passed,
    `the standalone plugin passes conformance${conformance.honest.passed ? '' : ` (${JSON.stringify(conformance.honest.failures)})`}`,
  );
  // A probe that never ran would report zero mutants, and zero failing mutants reads the same as
  // zero mutants rejected. The count is asserted so silence cannot pass for a verdict.
  check(
    Object.keys(conformance.mutants).length === 3,
    `the gate exercised all three rejection mutants (got ${Object.keys(conformance.mutants).length})`,
  );
  for (const [name, result] of Object.entries(conformance.mutants)) {
    check(result.passed === false, `conformance rejects a plugin with a ${name}`);
  }
} finally {
  if (keep) console.log(`\nKept: ${workRoot}`);
  else rmSync(workRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} standalone check(s) failed — the published SDK does not stand on its own.`);
  process.exit(1);
}
console.log(`\nStandalone gate passed: a plugin outside this repository compiles and conforms against @repovine/plugin-sdk@${sdkPkg.version} alone.`);
