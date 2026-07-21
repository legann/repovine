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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(engineRoot, 'package.json'), 'utf-8'));
const keep = process.argv.includes('--keep');

/** Tools the MCP server publishes; a short install that starts but exposes nothing is a failure. */
const MIN_TOOLS = 18;

const failures = [];
const check = (ok, message) => {
  console.log(`  ${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures.push(message);
};

function npm(args, cwd) {
  return execFileSync('npm', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Send initialize + tools/list to the packed server over stdio, as an MCP client does. */
function mcpHandshake(binPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [binPath], {
      cwd,
      env: { ...process.env, REPOVINE_ROOT: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP server did not answer in 90s. stderr: ${stderr.slice(0, 500)}`));
    }, 90_000);

    child.stdout.on('data', (d) => {
      stdout += d;
      for (const line of stdout.split('\n')) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 2) {
          clearTimeout(timer);
          child.kill('SIGTERM');
          resolve({ tools: message.result?.tools ?? [], stderr });
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) reject(new Error(`MCP server exited with ${code}. stderr: ${stderr.slice(0, 500)}`));
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

const workRoot = mkdtempSync(path.join(os.tmpdir(), 'repovine-smoke-'));
const consumer = path.join(workRoot, 'consumer');

try {
  console.log(`Packing repovine@${pkg.version} and @repovine/plugin-sdk…`);
  const sdkTgz = npm(['pack', '-w', '@repovine/plugin-sdk', '--pack-destination', workRoot], engineRoot).trim().split('\n').pop();
  const engineTgz = npm(['pack', '--pack-destination', workRoot], engineRoot).trim().split('\n').pop();

  // A consumer repo with one TS file: enough for a graph build and a real tools/list.
  mkdirSync(path.join(consumer, 'src'), { recursive: true });
  writeFileSync(path.join(consumer, 'package.json'), '{"name":"repovine-smoke-consumer","version":"1.0.0"}\n');
  writeFileSync(path.join(consumer, 'src', 'index.ts'), 'export const hello = (name: string): string => `hi ${name}`;\n');

  console.log('Installing the tarballs into a clean repo…');
  npm(['install', path.join(workRoot, sdkTgz), path.join(workRoot, engineTgz), '--no-audit', '--no-fund'], consumer);

  const installed = path.join(consumer, 'node_modules', 'repovine');
  check(existsSync(installed), 'repovine installs from the tarball');
  check(
    existsSync(path.join(consumer, 'node_modules', 'typescript')),
    'typescript resolves at runtime (declared as a dependency, not a devDependency)',
  );
  check(
    !existsSync(path.join(consumer, 'node_modules', '@huggingface')),
    '@huggingface/transformers stays opt-in (an install does not pull ~700MB of ONNX runtime)',
  );
  for (const doc of ['docs/agent-protocol.md', 'docs/context-quality.md']) {
    check(existsSync(path.join(installed, doc)), `${doc} ships in the package (AGENTS.md points agents at it)`);
  }

  const bin = path.join(installed, 'dist', 'mcp', 'index.js');
  let version = '';
  try {
    version = execFileSync('node', [bin, '--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    version = `crashed: ${(e.stderr ?? e.message ?? '').toString().split('\n').slice(0, 3).join(' ')}`;
  }
  check(version === pkg.version, `bin starts from a clean install and reports ${pkg.version} (got: ${version})`);

  const { tools, stderr } = await mcpHandshake(bin, consumer);
  check(tools.length >= MIN_TOOLS, `MCP handshake lists ${MIN_TOOLS}+ tools (got ${tools.length})`);
  const crashed = /ERR_MODULE_NOT_FOUND|Cannot find package/.test(stderr);
  check(!crashed, 'no unresolved runtime import on the MCP path');

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
    const run = spawnSync('node', [bin, 'build'], {
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
} finally {
  if (keep) console.log(`\nKept: ${workRoot}`);
  else rmSync(workRoot, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed — publishing this package would ship a broken install.`);
  process.exit(1);
}
console.log(`\nSmoke passed: repovine@${pkg.version} installs and serves MCP from a clean repo.`);
