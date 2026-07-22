// TEMPORARY debug probe for the windows-latest native crash (0xC0000409 /
// bash 127) around the client-projections suite. Phases print BEFORE running,
// so the last printed marker names the killer even when the death is silent.
// Delete together with projections-debug.yml.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mark = (m) => console.error(`PROBE: ${m}`);

mark('start');
mark('import smol-toml');
await import('smol-toml');
mark('import dist/cli/client-capabilities.js');
await import('../dist/cli/client-capabilities.js');
mark('import dist/cli/dispatcher/index.js');
await import('../dist/cli/dispatcher/index.js');
mark('import dist/cli/templates.js');
await import('../dist/cli/templates.js');
mark('import dist/cli/init.js');
const init = await import('../dist/cli/init.js');
mark('import dist/cli/plugin-render.js');
const render = await import('../dist/cli/plugin-render.js');
mark('import test helper');
const helper = await import('../test/helpers/client-projections.mjs');

mark('fixture repo (fs only)');
const repo = helper.makeFixtureRepo();

mark('engine CLI setup via spawnSync (cursor)');
const engineCli = path.resolve('dist/mcp/index.js');
const res = helper.runEngineCli(engineCli, ['setup', 'cursor', '--no-build', '--force'], repo, {
  ...helper.makeScrubbedEnv(),
  REPOVINE_ROOT: repo,
});
mark(`engine CLI exit=${res.status}`);

mark('in-process initClaude');
init.initClaude(repo, { forceBootstrap: true, replaceMcp: false, autoBuild: false, mcpLauncher: { command: process.execPath, args: [engineCli] } });

mark('in-process renderPluginRepo');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-render-'));
render.renderPluginRepo({ outRoot: out, version: '0.0.0-probe', allowUnpublished: true });

mark('one dispatcher hook via async spawn');
const hooks = helper.readCursorHooks(path.join(repo, '.cursor', 'hooks.json'));
const first = hooks[0];
const result = await helper.runDeclaredHook(first, { tool_input: { file_path: path.join(repo, 'src', 'app.ts') } }, {
  cwd: repo,
  env: { ...helper.makeScrubbedEnv(), CURSOR_PROJECT_DIR: repo },
});
mark(`hook exit=${result.status}`);
mark('ALL PHASES OK');
