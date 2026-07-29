#!/usr/bin/env node
/**
 * Canary gate: two plugins written outside this repository carry their ecosystems into the graph.
 *
 * One owns Go — `go.mod` discovery, its import syntax, its export rule and its own route syntax. The
 * other owns "orbit", an infrastructure ecosystem that exists nowhere else: its provider, its
 * resource kind, its trigger type, its file format and its identity keys are all invented in the
 * fixture. Neither is a workspace member, neither is bundled, and the engine carries no branch on
 * either of them.
 *
 * Both are built and packed against the packed SDK, installed into an analyzed project that is not
 * this repository, and switched on by that project's own `repovine.config.json`. The engine then
 * runs against it over MCP stdio, exactly as a host does.
 *
 *   node scripts/smoke-canary-plugins.mjs [--keep]
 *
 * Requires a built dist/ (npm run build) and registry access for the SDK's zod dependency.
 */
import { runNode, runNpm, spawnNode } from './lib/spawn.cjs';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures.push(message);
};

/** Copy a tree entry by entry: `fs.cpSync` fast-fails on Windows under a path with spaces and
 *  non-ASCII segments, which is exactly the shape of every path this gate uses. */
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

/**
 * Drive the engine's MCP server over stdio, one call at a time.
 *
 * Sequential on purpose: a tool called before the graph settles answers `status:"building"`, so a
 * batch of requests written at once would read an unbuilt repository and pass or fail for a reason
 * that has nothing to do with the plugins. The first call is the one that waits for the build.
 */
function mcpSession(cwd) {
  const child = spawnNode([path.join(engineRoot, 'dist', 'mcp', 'index.js')], {
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
      waiters.set(id, resolve);
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
        clientInfo: { name: 'canary', version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    /** Every tool answers in one envelope whose payload is JSON in the first content block. */
    async call(name, args = {}) {
      const message = await send('tools/call', { name, arguments: args });
      const text = message?.result?.content?.[0]?.text;
      try { return JSON.parse(text); } catch { return { error: { message: String(text).slice(0, 300) } }; }
    },
    async stop() {
      child.stdin.end();
      await closedPromise;
    },
  };
}

/** Ask the analyzed project the same questions, with the plugins listed in the given order. */
async function askInOrder(project, order) {
  writeFileSync(path.join(project, 'repovine.config.json'), `${JSON.stringify({
    plugins: { defaults: true, add: order },
  }, null, 2)}\n`);
  rmSync(path.join(project, '.repovine'), { recursive: true, force: true });

  const session = mcpSession(project);
  try {
    await session.start();
    const status = await session.call('get_build_status', { waitSec: 55 });
    const entrypoints = await session.call('get_entrypoints', { limit: 50 });
    const resource = await session.call('inspect_node', { scope: 'resource:orbit:service:checkout' });
    const graph = await session.call('map_context', { scope: 'all' });
    const search = await session.call('search_context', { query: 'orbit deployment' });
    const handler = await session.call('inspect_node', { nodeId: 'mod:example.com/shop/cmd/checkout/main' });
    return { status, entrypoints, resource, graph, search, handler };
  } finally {
    await session.stop();
  }
}

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'repovine canary ünï-'));
const project = path.join(workRoot, 'analyzed project');

try {
  console.log('Packing the SDK and both canary plugins…');
  const sdkTgz = path.join(
    workRoot,
    npm(['pack', '-w', '@repovine/plugin-sdk', '--pack-destination', workRoot], engineRoot).trim().split('\n').pop(),
  );

  const tarballs = [];
  for (const canary of CANARIES) {
    const build = path.join(workRoot, canary.dir);
    copyDirSync(path.join(fixtures, 'canary-plugins', canary.dir), build);
    npm(['install', sdkTgz, `zod@${enginePkg.dependencies.zod}`, `@types/node@${enginePkg.devDependencies['@types/node']}`, '--no-audit', '--no-fund'], build);
    const tsc = runNode(
      [path.join(engineRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(build, 'tsconfig.json')],
      { cwd: build, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    check(
      tsc.status === 0,
      `${canary.pkg} compiles against the packed SDK alone${tsc.status === 0 ? '' : `\n${tsc.stdout || tsc.stderr}`}`,
    );
    const source = readFileSync(path.join(fixtures, 'canary-plugins', canary.dir, 'src', 'index.ts'), 'utf-8');
    check(
      !/from '\.\.|packages\/|repovine\/src|plugin-sdk\/src/.test(source),
      `${canary.pkg} imports no workspace, relative-escape or engine-internal path`,
    );
    tarballs.push(path.join(workRoot, npm(['pack', '--pack-destination', workRoot], build).trim().split('\n').pop()));
  }

  console.log('Installing both canaries into an analyzed project that is not this repository…');
  copyDirSync(path.join(fixtures, 'canary-repo'), project);
  npm(['install', sdkTgz, ...tarballs, '--no-audit', '--no-fund'], project);

  const order = CANARIES.map(c => c.pkg);
  const reversed = [...order].reverse();

  console.log('Building the analyzed project with both plugins…');
  const first = await askInOrder(project, order);
  console.log('Rebuilding with the registration order reversed…');
  const second = await askInOrder(project, reversed);

  /* ---- the graph took both ecosystems, and refused nothing ---- */

  check(
    first.status?.result?.status === 'ready',
    `the build is ready (got ${JSON.stringify(first.status?.result?.status ?? first.status?.result?.error ?? 'nothing')})`,
  );
  const refusals = first.status?.result?.buildRefusals ?? [];
  check(refusals.length === 0, `the build refused nothing (got ${JSON.stringify(refusals).slice(0, 300)})`);

  const contributors = first.status?.result?.projection?.contributors ?? [];
  const applied = contributors.filter(c => c.status === 'applied').map(c => `${c.pluginId}/${c.contributorId}`).sort();
  check(
    applied.join(',') === 'go/go-routes,orbit/orbit-stack',
    `both projectors applied (got ${JSON.stringify(applied)})`,
  );

  /* ---- the Go route reaches MCP as a canonical entrypoint ---- */

  const entries = first.entrypoints?.result?.entrypoints ?? first.entrypoints?.result?.items ?? [];
  const checkout = entries.find(e => e.path === '/checkout' && e.method === 'POST');
  check(Boolean(checkout), `the Go route POST /checkout is an entrypoint (got ${JSON.stringify(entries).slice(0, 400)})`);
  check(checkout?.kind === 'api', `that entrypoint is canonical api, not a Go-shaped one (got ${checkout?.kind})`);
  check(
    typeof checkout?.moduleId === 'string' && checkout.moduleId.includes('checkout'),
    `it anchors on the Go module that declares it (got ${checkout?.moduleId})`,
  );
  check(
    entries.some(e => e.path === '/healthz' && e.method === 'GET'),
    'the second Go route is there too',
  );

  /* ---- the fictional topology reaches the graph ---- */

  const node = first.resource?.result ?? {};
  check(node.id === 'resource:orbit:service:checkout', `the orbit service is a graph node (got ${node.id})`);
  const links = node.links ?? [];
  check(
    links.some(l => l.relation === 'routes-to' || String(l.targetId ?? '').includes('checkout')),
    `the service links to the Go handler it deploys (got ${JSON.stringify(links).slice(0, 300)})`,
  );

  /* ---- the cross-plugin reference resolves ---- */

  // The Go plugin names a resource it does not create and cannot see while it runs. Only the index
  // built from every accepted batch can resolve it, so this edge existing is that index working.
  const handlerLinks = first.handler?.result?.links ?? [];
  check(
    handlerLinks.some(l => String(l.targetId) === 'resource:orbit:service:checkout'),
    `the Go module binds to the orbit service the other plugin contributed (got ${JSON.stringify(handlerLinks).slice(0, 300)})`,
  );

  /* ---- the extension is beside the graph, not inside it ---- */

  const extensions = node.extensions ?? [];
  const deployment = extensions.find(e => e.schema === 'orbit/deployment@1');
  check(Boolean(deployment), `the namespaced extension is on the node's sidecar (got ${JSON.stringify(extensions).slice(0, 300)})`);
  check(deployment?.pluginId === 'orbit', `the host stamped its owner (got ${deployment?.pluginId})`);
  check(
    deployment?.payload?.rolloutStrategy === 'blue-green',
    'its payload is echoed verbatim',
  );
  // The map has to have found the repository for its silence about the extension to mean anything.
  const mapped = JSON.stringify(first.graph?.result ?? {});
  check(mapped.includes('orbit'), 'the repository map sees the orbit ecosystem');
  check(
    !mapped.includes('orbit/deployment@1'),
    'the extension is not a node in the repository map — it is echoed, never interpreted',
  );
  const found = JSON.stringify(first.search?.result ?? {});
  check(
    !found.includes('orbit/deployment@1'),
    'and search does not offer it as a graph node either',
  );

  /* ---- registration order is not an input ---- */

  const shape = run => JSON.stringify({
    entrypoints: (run.entrypoints?.result?.entrypoints ?? run.entrypoints?.result?.items ?? [])
      .map(e => [e.id, e.kind, e.path ?? null, e.method ?? null]).sort(),
    resource: [run.resource?.result?.id, (run.resource?.result?.links ?? []).map(l => [l.relation, l.targetId]).sort()],
    handler: (run.handler?.result?.links ?? []).map(l => [l.relation, l.targetId]).sort(),
    extensions: (run.resource?.result?.extensions ?? []).map(e => [e.pluginId, e.schema, e.localKey]).sort(),
    contributors: (run.status?.result?.projection?.contributors ?? []).map(c => [c.pluginId, c.contributorId, c.status]).sort(),
  });
  const firstShape = shape(first);
  const secondShape = shape(second);
  if (firstShape !== secondShape) {
    // The whole point of the check is that nothing a reader sees moved, so name what did.
    console.log(`    first:  ${firstShape}`);
    console.log(`    second: ${secondShape}`);
  }
  check(firstShape === secondShape, 'reversing the plugin order changes nothing a reader can see');
} finally {
  if (keep) console.log(`\nKept: ${workRoot}`);
  else rmSync(workRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} canary check(s) failed — the plugin contract does not carry an outside ecosystem.`);
  process.exit(1);
}
console.log('\nCanary gate passed: two ecosystems written outside this repository reach the graph and MCP with no core branch.');
