// TEMPORARY debug probe for the windows-latest native crash (0xC0000409).
// Mirrors the suite's global before() call-for-call; markers go through
// fs.writeSync(2, …) — synchronous, so they survive a fast-fail that discards
// buffered stdio. Delete together with projections-debug.yml.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mark = (m) => fs.writeSync(2, `PROBE: ${m}\n`);

mark('imports');
const { copyDirSync, makeFixtureRepo, makeScrubbedEnv, runEngineCli, writeSyntheticEngineState, FIXTURE_PREFIX } =
  await import('../test/helpers/client-projections.mjs');
const { renderPluginRepo } = await import('../dist/cli/plugin-render.js');

const engineRoot = process.cwd();
const engineCli = path.join(engineRoot, 'dist', 'mcp', 'index.js');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(engineRoot, 'package.json'), 'utf-8')).version;
const scrub = makeScrubbedEnv();

mark('projectRepo = makeFixtureRepo()');
const projectRepo = makeFixtureRepo();

for (const client of ['cursor', 'claude', 'codex']) {
  mark(`setupClient(${client}) via CLI`);
  const res = runEngineCli(engineCli, ['setup', client, '--no-build', '--force'], projectRepo, {
    ...scrub,
    REPOVINE_ROOT: projectRepo,
  });
  mark(`setup ${client} exit=${res.status}`);
}

mark('writeSyntheticEngineState(projectRepo)');
writeSyntheticEngineState(projectRepo);

mark('mkdtemp bundlesOut');
const bundlesOut = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX)));

mark(`renderPluginRepo(engineRoot, version=${pkgVersion})`);
renderPluginRepo({ engineRoot, outRoot: bundlesOut, version: pkgVersion });

mark('bundleWorkspace = makeFixtureRepo()');
const bundleWorkspace = makeFixtureRepo();
mark('writeSyntheticEngineState(bundleWorkspace)');
writeSyntheticEngineState(bundleWorkspace);

mark('copyDirSync bundle .cursor -> workspace');
copyDirSync(path.join(bundlesOut, 'repovine-plugins', 'cursor', '.cursor'), path.join(bundleWorkspace, '.cursor'));

mark('BEFORE() MIRROR COMPLETE');
