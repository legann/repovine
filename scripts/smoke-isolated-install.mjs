#!/usr/bin/env node
/**
 * Stage-8 gate: the packed engine analyses a project whose plugins came from three separate installs.
 *
 * What the two existing gates already prove, and why neither is this one:
 *
 *   - `smoke-pack-install` installs the packed engine and asserts the nine bundled packages resolve
 *     from it. It never installs an external plugin.
 *   - `smoke-canary-plugins` installs two external plugins into an analysed project, but drives
 *     `dist/mcp/index.js` out of this development checkout, where every workspace path resolves.
 *
 * Here both halves hold at once: the engine is the tarball, the SDK is the tarball, the two external
 * plugins are their own tarballs installed by a second `npm install`, and the analysed project is a
 * directory under `os.tmpdir()` that has never been a workspace member. The bundled default preset
 * and the external plugins reach the same build through the same loader, and nothing resolves back
 * into this repository — that last part is asserted, not assumed.
 *
 *   node scripts/smoke-isolated-install.mjs [--keep]
 *
 * Node `fs`/`path`/`os` only, no shell paths: one scenario for Linux, Windows and macOS CI.
 * Requires a built dist/ (npm run build) and registry access for third-party deps.
 */
import { nodeOutput, runNpm, spawnNode } from './lib/spawn.cjs';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enginePkg = JSON.parse(readFileSync(path.join(engineRoot, 'package.json'), 'utf-8'));
const fixtures = path.join(engineRoot, 'test', 'fixtures');
const keep = process.argv.includes('--keep');

const CANARIES = [
  { dir: 'go-source', pkg: 'repovine-plugin-go-canary', id: 'go' },
  { dir: 'orbit-iac', pkg: 'repovine-plugin-orbit-canary', id: 'orbit' },
];

/** The nine the bundled preset selects. Named here so a preset that lost one is caught by name. */
const PRESET_PLUGIN_IDS = [
  'docker-compose', 'dockerfile', 'helm', 'kubernetes', 'python', 'sam', 'terraform', 'typescript', 'vercel',
].sort();

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures.push(message);
};

/** Entry-by-entry copy: `fs.cpSync` fast-fails on Windows under a path with spaces and non-ASCII. */
function copyDirSync(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(from, to);
    else copyFileSync(from, to);
  }
}

function npm(args, cwd) {
  const res = runNpm(args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`npm ${args.join(' ')} exited ${res.status}\n${res.stderr || ''}`);
  return res.stdout;
}

/** True when `candidate` sits inside `root`, both canonicalized (macOS /var vs /private/var). */
function contains(root, candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  try {
    const rel = path.relative(realpathSync(root), realpathSync(candidate));
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Drive an MCP server binary over stdio, one call at a time.
 *
 * Sequential on purpose: a tool called before the graph settles answers `status:"building"`, so a
 * batch written at once would read an unbuilt repository.
 */
function mcpSession(binPath, cwd) {
  const child = spawnNode([binPath], {
    cwd,
    env: { ...process.env, REPOVINE_ROOT: cwd },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const answers = new Map();
  const waiters = new Map();
  let stdout = '';
  let stderr = '';
  let closed;
  const closedPromise = new Promise(resolve => { closed = resolve; });

  child.stdout.on('data', d => {
    stdout += d;
    for (const line of stdout.split('\n')) {
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id !== 'number' || answers.has(message.id)) continue;
      answers.set(message.id, message);
      waiters.get(message.id)?.(message);
    }
  });
  child.stderr.on('data', d => { stderr += d; });
  child.on('close', () => closed());

  let nextId = 1;
  const send = (method, params) => {
    const id = nextId++;
    const answered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`MCP did not answer ${method} in 180s. stderr: ${stderr.slice(0, 800)}`));
      }, 180_000);
      waiters.set(id, message => { clearTimeout(timer); resolve(message); });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return answered;
  };

  return {
    async start() {
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'isolated-install', version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    async call(name, args = {}) {
      const message = await send('tools/call', { name, arguments: args });
      const text = message?.result?.content?.[0]?.text;
      try { return JSON.parse(text); } catch { return { error: { message: String(text).slice(0, 300) } }; }
    },
    stderrSoFar: () => stderr,
    async stop() {
      child.stdin.end();
      await closedPromise;
    },
  };
}

// Spaces and non-ASCII in every path, so a quoting defect surfaces here rather than for a user.
const workRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'repovine isolated ünï-')));
const project = path.join(workRoot, 'analyzed project');

try {
  console.log(`Packing repovine@${enginePkg.version}, the SDK and both external plugins…`);
  const sdkTgz = path.join(
    workRoot,
    npm(['pack', '-w', '@repovine/plugin-sdk', '--pack-destination', workRoot], engineRoot).trim().split('\n').pop(),
  );
  const enginePack = JSON.parse(npm(['pack', '--json', '--pack-destination', workRoot], engineRoot))[0];
  const engineTgz = path.join(workRoot, enginePack.filename);
  check(
    (enginePack.bundled ?? []).includes('@repovine/plugin-default-preset'),
    'the engine tarball bundles the default preset',
  );

  // Each external plugin is built against the packed SDK alone, in its own directory, before the
  // engine is anywhere near the picture.
  const canaryTarballs = [];
  for (const canary of CANARIES) {
    const build = path.join(workRoot, canary.dir);
    copyDirSync(path.join(fixtures, 'canary-plugins', canary.dir), build);
    // `--no-save`, and it is load-bearing rather than tidy. Without it npm rewrites the manifest's
    // `@repovine/plugin-sdk` spec to `file:../repovine-plugin-sdk-0.1.0.tgz`, that rewrite is what
    // gets packed, and installing the result into the analysed project fails: the relative path is
    // resolved from wherever the install runs, where no such tarball exists. The published manifest
    // has to say what an author would write — a version — and the tarball is only how this build
    // obtains it locally.
    npm([
      'install', sdkTgz,
      `zod@${enginePkg.dependencies.zod}`,
      `@types/node@${enginePkg.devDependencies['@types/node']}`,
      '--no-save', '--no-audit', '--no-fund',
    ], build);
    const tsc = nodeOutputOrNull([
      path.join(engineRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p', path.join(build, 'tsconfig.json'),
    ], build);
    check(tsc.ok, `${canary.pkg} compiles against the packed SDK alone${tsc.ok ? '' : `\n${tsc.output}`}`);
    canaryTarballs.push(
      path.join(workRoot, npm(['pack', '--pack-destination', workRoot], build).trim().split('\n').pop()),
    );
  }

  /* ---- the analysed project: three installs, none of them a workspace ---- */

  console.log('Installing the engine, then the external plugins, into a project outside this repository…');
  copyDirSync(path.join(fixtures, 'canary-repo'), project);
  // Install 1: the engine and the SDK.
  npm(['install', sdkTgz, engineTgz, '--no-audit', '--no-fund'], project);
  // Install 2: the external plugins, as a separate operation — a user adding a plugin to a project
  // that already has repovine. A single combined install would not distinguish the two.
  npm(['install', ...canaryTarballs, '--no-audit', '--no-fund'], project);

  const installedEngine = path.join(project, 'node_modules', 'repovine');
  const bin = path.join(installedEngine, 'dist', 'mcp', 'index.js');
  check(existsSync(bin), 'the packed engine installed into the analysed project');
  for (const canary of CANARIES) {
    check(
      existsSync(path.join(project, 'node_modules', canary.pkg, 'package.json')),
      `${canary.pkg} installed into the analysed project as its own package`,
    );
  }

  // Nothing resolves back here. Asked from a child anchored the way the engine anchors — its own
  // installed manifest for what it bundles, the project's for what the project installed — because
  // this runner lives in the development checkout and would answer for it.
  //
  // Three resolution forms, and which one answers is a fact about the package rather than noise:
  //
  //   - the SDK's `exports` map publishes the `import` condition only, and withholds
  //     `./package.json`. Both are deliberate, so a probe that asked `require.resolve` would report
  //     an intact boundary as a failed install. An author reaches the SDK with `import`, and that is
  //     the question asked here;
  //   - a plugin package publishes `default` beside `import`, so the engine can resolve it anchored
  //     on its own manifest before importing it.
  const resolution = JSON.parse(nodeOutput(['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    import { readFileSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';

    const anchored = createRequire(process.env.PROBE_ENGINE_MANIFEST);
    const fromProject = createRequire(process.env.PROBE_PROJECT_MANIFEST);

    const locate = (req, name) => {
      for (const [form, spec] of [['manifest', name + '/package.json'], ['entry-require', name]]) {
        try { return { form, resolved: req.resolve(spec) }; } catch { /* try the next form */ }
      }
      // The ESM condition, resolved from this process's base — which is the analysed project, since
      // that is the cwd the child was given.
      try { return { form: 'entry-import', resolved: fileURLToPath(import.meta.resolve(name)) }; }
      catch { /* fall through to the verdict below */ }
      return { form: 'none', resolved: 'ERR:unresolvable' };
    };

    const out = { fromEngine: {}, fromProject: {}, presetMembers: {} };
    for (const name of JSON.parse(process.env.PROBE_FROM_ENGINE)) out.fromEngine[name] = locate(anchored, name);
    for (const name of JSON.parse(process.env.PROBE_FROM_PROJECT)) out.fromProject[name] = locate(fromProject, name);

    // The preset's members, resolved the way the loader resolves them: by name, anchored on the
    // engine that bundles the preset. Their location is npm's choice (nested or hoisted).
    try {
      const presetManifest = anchored.resolve(process.env.PROBE_PRESET + '/package.json');
      const preset = JSON.parse(readFileSync(presetManifest, 'utf-8'));
      for (const name of preset.repovine?.plugins ?? []) {
        const found = locate(anchored, name);
        let id;
        try { id = JSON.parse(readFileSync(anchored.resolve(name + '/package.json'), 'utf-8')).repovine?.id; }
        catch { id = null; }
        out.presetMembers[name] = { ...found, id };
      }
    } catch (error) {
      out.presetError = String(error?.code ?? error);
    }
    process.stdout.write(JSON.stringify(out));
  `], {
    cwd: project,
    env: {
      ...process.env,
      PROBE_ENGINE_MANIFEST: path.join(installedEngine, 'package.json'),
      PROBE_PROJECT_MANIFEST: path.join(project, 'package.json'),
      // The preset is bundled inside the engine, so the engine's anchor is the one that finds it.
      // The SDK is not an engine dependency at all — a plugin author installs it, and it is found
      // from the project alongside the plugins that peer-depend on it.
      PROBE_FROM_ENGINE: JSON.stringify(['@repovine/plugin-default-preset']),
      PROBE_FROM_PROJECT: JSON.stringify(['@repovine/plugin-sdk', ...CANARIES.map(c => c.pkg)]),
      PROBE_PRESET: '@repovine/plugin-default-preset',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));

  for (const [name, found] of [
    ...Object.entries(resolution.fromEngine),
    ...Object.entries(resolution.fromProject),
  ]) {
    check(
      contains(project, found.resolved),
      `${name} resolves inside the analysed project via its ${found.form} (got ${found.resolved})`,
    );
    check(!contains(engineRoot, found.resolved), `${name} does not resolve into this repository`);
  }

  /* ---- one build: bundled preset and external plugins through the same loader ---- */

  writeFileSync(path.join(project, 'repovine.config.json'), `${JSON.stringify({
    plugins: { defaults: true, add: CANARIES.map(c => c.pkg) },
  }, null, 2)}\n`);
  rmSync(path.join(project, '.repovine'), { recursive: true, force: true });

  console.log('Building the analysed project with the installed engine…');
  const session = mcpSession(bin, project);
  let status;
  let entrypoints;
  let resource;
  try {
    await session.start();
    status = await session.call('get_build_status', { waitSec: 55 });
    entrypoints = await session.call('get_entrypoints', { limit: 50 });
    resource = await session.call('inspect_node', { scope: 'resource:orbit:service:checkout' });
  } finally {
    await session.stop();
  }

  check(
    status?.result?.status === 'ready',
    `the installed engine built the project (got ${JSON.stringify(status?.result?.status ?? status?.result?.error ?? 'nothing')})`,
  );
  const refusals = status?.result?.buildRefusals ?? [];
  check(refusals.length === 0, `the build refused nothing (got ${JSON.stringify(refusals).slice(0, 400)})`);
  check(
    !/ERR_MODULE_NOT_FOUND|Cannot find package/.test(session.stderrSoFar()),
    'no unresolved runtime import in the installed engine',
  );

  // Both external projectors ran, which is the loader treating a separately installed package the
  // way it treats a bundled one.
  const contributors = status?.result?.projection?.contributors ?? [];
  const applied = contributors.filter(c => c.status === 'applied').map(c => `${c.pluginId}/${c.contributorId}`).sort();
  check(
    applied.join(',') === 'go/go-routes,orbit/orbit-stack',
    `both external projectors applied under the installed engine (got ${JSON.stringify(applied)})`,
  );

  // The bundled preset is loaded in the same build, not displaced by the external plugins.
  const loadedIds = [...new Set(contributors.map(c => c.pluginId))];
  check(
    CANARIES.every(c => loadedIds.includes(c.id)),
    `the external plugin ids are in the run (got ${JSON.stringify(loadedIds)})`,
  );
  // The preset's members, as resolved by the loader's own anchor rather than at a path this script
  // guesses: npm may place a bundled dependency nested under the engine or hoisted beside it, and
  // both layouts are correct.
  const members = Object.entries(resolution.presetMembers ?? {});
  check(resolution.presetError === undefined, `the preset manifest is readable (got ${resolution.presetError})`);
  check(
    JSON.stringify(members.map(([, member]) => member.id).sort()) === JSON.stringify(PRESET_PLUGIN_IDS),
    `every plugin the bundled preset names declares its id (got ${JSON.stringify(members.map(([, m]) => m.id).sort())})`,
  );
  const unresolvedMembers = members
    .filter(([, member]) => !contains(project, member.resolved))
    .map(([name, member]) => `${name} -> ${member.resolved}`);
  check(
    unresolvedMembers.length === 0,
    `every plugin the bundled preset names resolves inside the analysed project${unresolvedMembers.length ? ` (stray: ${JSON.stringify(unresolvedMembers)})` : ''}`,
  );

  const entries = entrypoints?.result?.entrypoints ?? entrypoints?.result?.items ?? [];
  check(
    entries.some(e => e.path === '/checkout' && e.method === 'POST' && e.kind === 'api'),
    `the external Go route reaches get_entrypoints as a canonical api entrypoint (got ${JSON.stringify(entries).slice(0, 400)})`,
  );
  check(
    resource?.result?.id === 'resource:orbit:service:checkout',
    `the external IaC resource is a graph node (got ${resource?.result?.id})`,
  );
} finally {
  if (keep) console.log(`\nKept: ${workRoot}`);
  else rmSync(workRoot, { recursive: true, force: true });
}

function nodeOutputOrNull(args, cwd) {
  try {
    return { ok: true, output: nodeOutput(args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, output: String(error?.stdout ?? '') + String(error?.stderr ?? error?.message ?? '') };
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} isolated-install check(s) failed — a real install does not carry this plugin set.`);
  process.exit(1);
}
console.log('\nIsolated install passed: the packed engine, its bundled preset and two separately installed external plugins share one loader.');
