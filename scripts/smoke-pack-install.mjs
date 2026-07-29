#!/usr/bin/env node
/**
 * Release smoke test: pack both packages, install them into a throwaway repo, and
 * drive the MCP server over stdio — the same path `npx -y repovine@<version>` takes
 * from a plugin bundle's MCP config.
 *
 * Catches what an in-repo `node dist/mcp/index.js --help` cannot: a runtime import
 * that resolves only because devDependencies are present in the engine checkout.
 *
 *   node scripts/smoke-pack-install.mjs [--keep]
 *
 * Requires a built dist/ (npm run build) and registry access for third-party deps.
 */
import { nodeOutput, runBinShim, runNode, runNpm, spawnNode } from './lib/spawn.cjs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(engineRoot, 'package.json'), 'utf-8'));
const keep = process.argv.includes('--keep');

/** Tools the MCP server publishes; a short install that starts but exposes nothing is a failure. */
const MIN_TOOLS = 18;
// Plugin id and what the package activates: a migrated vertical exports a working plugin, a package
// still waiting for its migration exports only its identity. The distinction is asserted per package
// so a package that quietly stopped carrying its implementation is caught by name.
const BUNDLED_PLUGIN_PACKAGES = {
  '@repovine/plugin-source-typescript': ['typescript', 'source-plugin'],
  '@repovine/plugin-source-python': ['python', 'source-plugin'],
  '@repovine/plugin-iac-sam': ['sam', 'iac-plugin'],
  '@repovine/plugin-iac-kubernetes': ['kubernetes', 'iac-plugin'],
  '@repovine/plugin-iac-helm': ['helm', 'iac-plugin'],
  '@repovine/plugin-iac-terraform': ['terraform', 'iac-plugin'],
  '@repovine/plugin-iac-vercel': ['vercel', 'iac-plugin'],
  '@repovine/plugin-iac-dockerfile': ['dockerfile', 'iac-plugin'],
  '@repovine/plugin-iac-docker-compose': ['docker-compose', 'iac-plugin'],
};
const DEFAULT_PRESET_PACKAGE = '@repovine/plugin-default-preset';
const EXPECTED_BUNDLED_PACKAGES = [
  DEFAULT_PRESET_PACKAGE,
  ...Object.keys(BUNDLED_PLUGIN_PACKAGES),
].sort();

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures.push(message);
};

function npm(args, cwd) {
  const res = runNpm(args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`npm ${args.join(' ')} exited ${res.status}\n${res.stderr || ''}`);
  return res.stdout;
}

/** Resolve and import the bundled packages from a child whose module base is
 * the installed engine. The smoke runner itself lives in the development
 * checkout, so resolving here would be a false positive through workspaces. */
function probeInstalledPluginPackages(installed) {
  const probe = `
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';

    const expected = JSON.parse(process.env.REPOVINE_SMOKE_PLUGIN_SPECS);
    const anchoredRequire = createRequire(process.env.REPOVINE_SMOKE_ENGINE_MANIFEST);
    const direct = new Map();
    const packages = {};
    for (const [name, [pluginId]] of Object.entries(expected)) {
      try {
        const resolved = anchoredRequire.resolve(name);
        const mod = await import(pathToFileURL(resolved).href);
        direct.set(name, mod.default);
        packages[name] = {
          resolved,
          pluginId: mod.default?.pluginId,
          activation: mod.default?.activation,
          expectedPluginId: pluginId,
        };
      } catch (error) {
        packages[name] = { error: error?.code ?? error?.message ?? String(error) };
      }
    }
    let preset;
    try {
      const resolved = anchoredRequire.resolve(process.env.REPOVINE_SMOKE_PRESET);
      const mod = await import(pathToFileURL(resolved).href);
      const value = mod.default;
      preset = {
        resolved,
        activation: value?.activation,
        pluginCount: Array.isArray(value?.plugins) ? value.plugins.length : -1,
        sameInstances: Array.isArray(value?.plugins)
          && value.plugins.every(plugin => direct.get(plugin.packageName) === plugin),
      };
    } catch (error) {
      preset = { error: error?.code ?? error?.message ?? String(error) };
    }
    process.stdout.write(JSON.stringify({ packages, preset }));
  `;
  return JSON.parse(nodeOutput(
    ['--input-type=module', '-e', probe],
    {
      cwd: installed,
      env: {
        ...process.env,
        REPOVINE_SMOKE_ENGINE_MANIFEST: path.join(installed, 'package.json'),
        REPOVINE_SMOKE_PLUGIN_SPECS: JSON.stringify(BUNDLED_PLUGIN_PACKAGES),
        REPOVINE_SMOKE_PRESET: DEFAULT_PRESET_PACKAGE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ));
}

/** Send initialize + tools/list to the packed server over stdio, as an MCP client
 * does, then close stdin and require a clean exit — the host-disconnect lifecycle. */
function mcpHandshake(binPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawnNode([binPath], {
      cwd,
      env: { ...process.env, REPOVINE_ROOT: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let tools;
    let eofTimedOut = false;
    let eofTimer;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP server did not answer in 90s. stderr: ${stderr.slice(0, 500)}`));
    }, 90_000);

    child.stdout.on('data', (d) => {
      stdout += d;
      for (const line of stdout.split('\n')) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 2 && tools === undefined) {
          clearTimeout(timer);
          tools = message.result?.tools ?? [];
          child.stdin.end();
          eofTimer = setTimeout(() => {
            eofTimedOut = true;
            child.kill('SIGKILL');
          }, 20_000);
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    // 'close', not 'exit': stdio can still hold buffered data at 'exit', and the
    // stdout-purity check must see everything written during the shutdown window.
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(eofTimer);
      if (tools !== undefined) resolve({ tools, stderr, stdout, eofExit: !eofTimedOut && code === 0 });
      else reject(new Error(`MCP server exited with ${code} before tools/list. stderr: ${stderr.slice(0, 500)}`));
    });

    for (const request of [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
  });
}

// Spaces + non-ASCII in every path the install and the server touch. The prefix
// avoids cmd metacharacters so the ComSpec adapter paths stay valid.
const workRoot = mkdtempSync(path.join(os.tmpdir(), 'repovine smoke ünï-'));
const consumer = path.join(workRoot, 'consumer');

try {
  console.log(`Packing repovine@${pkg.version} and @repovine/plugin-sdk…`);
  const sdkTgz = npm(['pack', '-w', '@repovine/plugin-sdk', '--pack-destination', workRoot], engineRoot).trim().split('\n').pop();
  const enginePack = JSON.parse(
    npm(['pack', '--json', '--pack-destination', workRoot], engineRoot),
  )[0];
  const engineTgz = enginePack.filename;
  check(
    JSON.stringify([...(enginePack.bundled ?? [])].sort()) === JSON.stringify(EXPECTED_BUNDLED_PACKAGES),
    'repovine tarball bundles the default preset and all nine private plugin packages',
  );

  // A consumer repo with one TS file: enough for a graph build and a real tools/list.
  mkdirSync(path.join(consumer, 'src'), { recursive: true });
  writeFileSync(path.join(consumer, 'package.json'), '{"name":"repovine-smoke-consumer","version":"1.0.0"}\n');
  writeFileSync(path.join(consumer, 'src', 'index.ts'), 'export const hello = (name: string): string => `hi ${name}`;\n');

  console.log('Installing the tarballs into a clean repo…');
  npm(['install', path.join(workRoot, sdkTgz), path.join(workRoot, engineTgz), '--no-audit', '--no-fund'], consumer);

  const installed = path.join(consumer, 'node_modules', 'repovine');
  check(existsSync(installed), 'repovine installs from the tarball');
  const pluginProbe = probeInstalledPluginPackages(installed);
  const installedTree = path.join(consumer, 'node_modules');
  const resolvesInsideInstalledTree = resolved => {
    if (typeof resolved !== 'string' || !path.isAbsolute(resolved)) return false;
    const rel = path.relative(installedTree, resolved);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  for (const [packageName, [pluginId, activation]] of Object.entries(BUNDLED_PLUGIN_PACKAGES)) {
    const result = pluginProbe.packages[packageName];
    check(
      resolvesInsideInstalledTree(result?.resolved),
      `${packageName} resolves from installed repovine/package.json`,
    );
    check(
      result?.pluginId === pluginId && result?.activation === activation,
      `${packageName} public entrypoint imports from the installed tarball (${activation})`,
    );
  }
  check(
    resolvesInsideInstalledTree(pluginProbe.preset?.resolved),
    `${DEFAULT_PRESET_PACKAGE} resolves from installed repovine/package.json`,
  );
  check(
    pluginProbe.preset?.activation === 'scaffold-only'
      && pluginProbe.preset?.pluginCount === Object.keys(BUNDLED_PLUGIN_PACKAGES).length,
    'default preset imports all nine bundled public entrypoints',
  );
  check(
    pluginProbe.preset?.sameInstances === true,
    'default preset and direct imports resolve the same bundled module instances',
  );
  check(
    existsSync(path.join(consumer, 'node_modules', 'typescript')),
    'typescript resolves at runtime (declared as a dependency, not a devDependency)',
  );
  check(
    existsSync(path.join(consumer, 'node_modules', 'ts-morph')),
    'ts-morph resolves at runtime for the bundled TypeScript plugin (peer, not a second copy)',
  );
  check(
    !existsSync(path.join(consumer, 'node_modules', '@huggingface')),
    '@huggingface/transformers stays opt-in (an install does not pull ~700MB of ONNX runtime)',
  );
  for (const doc of ['docs/agent-protocol.md', 'docs/context-quality.md']) {
    check(existsSync(path.join(installed, doc)), `${doc} ships in the package (AGENTS.md points agents at it)`);
  }
  // The Python plugin runs this script as a subprocess and resolves it beside its own compiled
  // entry, so the asset is asserted where that resolution lands rather than at a path the engine
  // tarball happens to have used before the vertical moved into its own package.
  const pythonPackageEntry = pluginProbe.packages['@repovine/plugin-source-python']?.resolved;
  check(
    typeof pythonPackageEntry === 'string'
      && existsSync(path.join(path.dirname(pythonPackageEntry), 'route-ast-script.py')),
    'bundled Python AST asset ships beside the compiled Python plugin',
  );

  const bin = path.join(installed, 'dist', 'mcp', 'index.js');
  let version = '';
  try {
    version = nodeOutput([bin, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    version = `crashed: ${(e.stderr ?? e.message ?? '').toString().split('\n').slice(0, 3).join(' ')}`;
  }
  check(version === pkg.version, `bin starts from a clean install and reports ${pkg.version} (got: ${version})`);

  // The OS-generated bin shim, run as a user would (`repovine --help`).
  const shim = path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'repovine.cmd' : 'repovine');
  check(existsSync(shim), 'npm generates the repovine bin shim');
  const shimHelp = runBinShim(shim, ['--help'], { cwd: consumer, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  check(
    shimHelp.status === 0 && /repovine/i.test(String(shimHelp.stdout)),
    'bin shim runs as a user (repovine --help)',
  );
  const execHelp = runNpm(['exec', '--', 'repovine', '--help'], { cwd: consumer, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  check(
    execHelp.status === 0 && /repovine/i.test(String(execHelp.stdout)),
    'npm exec -- repovine --help resolves the installed bin',
  );

  const { tools, stderr, stdout: mcpStdout, eofExit } = await mcpHandshake(bin, consumer);
  check(tools.length >= MIN_TOOLS, `MCP handshake lists ${MIN_TOOLS}+ tools (got ${tools.length})`);
  const crashed = /ERR_MODULE_NOT_FOUND|Cannot find package/.test(stderr);
  check(!crashed, 'no unresolved runtime import on the MCP path');
  check(eofExit, 'server exits cleanly on stdin EOF (host-disconnect lifecycle)');
  // stdout carries JSON-RPC frames only. pop() drops a possibly-partial trailing
  // fragment; JSON.parse tolerates a trailing \r on CRLF frames.
  const frames = mcpStdout.split('\n');
  frames.pop();
  const nonRpc = frames
    .filter((l) => l.trim() !== '')
    .filter((l) => {
      try { return JSON.parse(l).jsonrpc !== '2.0'; } catch { return true; }
    });
  check(
    nonRpc.length === 0,
    `stdout carries only JSON-RPC frames${nonRpc[0] ? ` (bad: ${JSON.stringify(nonRpc[0].slice(0, 80))})` : ''}`,
  );
  check(
    existsSync(path.join(consumer, 'repovine.annots.json')) && existsSync(path.join(consumer, '.repovine')),
    'MCP start bootstraps workspace artifacts (annots + .repovine) in the spaced+Unicode consumer',
  );

  // The npx layout: repovine runs from its own tree (here: the consumer install) against a
  // separate workspace. A bare specifier cannot see the workspace's node_modules, so embeddings
  // reach the engine only through workspace resolution. A stub package stands in for the real
  // 700MB one; jest cannot cover this, because it synthesizes named exports for CJS modules.
  const workspace = path.join(workRoot, 'workspace');
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  writeFileSync(path.join(workspace, 'package.json'), '{"name":"repovine-smoke-workspace","version":"1.0.0"}\n');
  writeFileSync(path.join(workspace, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2022","module":"NodeNext","strict":true},"include":["src"]}\n');
  writeFileSync(path.join(workspace, 'src', 'index.ts'), 'export const hello = (name: string): string => `hi ${name}`;\n');

  // Both streams: the build prints its pipeline on stdout and the missing-package warning on stderr.
  const runBuild = () => {
    const run = runNode([bin, 'build'], {
      cwd: workspace,
      env: { ...process.env, REPOVINE_ROOT: workspace },
      encoding: 'utf-8',
    });
    return `${run.stdout ?? ''}${run.stderr ?? ''}`;
  };

  rmSync(path.join(workspace, '.repovine'), { recursive: true, force: true });
  const withoutPackage = runBuild();
  check(
    /opt-in peer dependency/.test(withoutPackage) && /Build complete/.test(withoutPackage),
    'without the package: the build warns with the install command and completes on the token index',
  );

  const stubDir = path.join(workspace, 'node_modules', '@huggingface', 'transformers');
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(stubDir + '/package.json', '{"name":"@huggingface/transformers","version":"3.8.1","main":"./index.cjs"}\n');
  // Named exports are not statically detectable here, exactly as in the real CJS build, so the
  // loader has to unwrap ESM interop to reach `pipeline`.
  writeFileSync(
    `${stubDir}/index.cjs`,
    'const mod = {\n'
    + '  pipeline: async () => async (texts) => ({ tolist: () => texts.map(() => [0.1, 0.2, 0.3]) }),\n'
    + '};\n'
    + 'module.exports = mod;\n',
  );

  rmSync(path.join(workspace, '.repovine'), { recursive: true, force: true });
  const withPackage = runBuild();
  check(
    /embedded/.test(withPackage) && !/opt-in peer dependency/.test(withPackage),
    'installed in the workspace: embeddings run even though repovine resolves from its own tree (npx path)',
  );
  check(
    existsSync(path.join(workspace, '.repovine', '.cache')),
    'one-shot build writes the graph cache under .repovine/.cache',
  );
} finally {
  if (keep) console.log(`\nKept: ${workRoot}`);
  else rmSync(workRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed — publishing this package would ship a broken install.`);
  process.exit(1);
}
console.log(`\nSmoke passed: repovine@${pkg.version} installs and serves MCP from a clean repo.`);
