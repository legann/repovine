import * as fs from 'node:fs';
import * as path from 'node:path';

// Enable profiling before loading repovine modules (static imports are hoisted in ESM).
process.env.REPOVINE_PROFILE ??= '1';

const [{ MemoryProfiler }, { RepovineRuntime }, { repoRoot, artifactsDir, ARTIFACTS_DIR_NAME }, { loadConfig }] =
  await Promise.all([
    import('./perf/memory-profiler.js'),
    import('./mcp/context.js'),
    import('./paths.js'),
    import('./config.js'),
  ]);

MemoryProfiler.ensure();

function assertWritableRepoRoot(root: string): void {
  if (root.includes('/path/to/')) {
    console.error('REPOVINE_ROOT looks like a documentation placeholder, not a real path.');
    console.error('Example: REPOVINE_ROOT=/home/you/workspace/my-monorepo npm run profile');
    process.exit(1);
  }
  if (!fs.existsSync(root)) {
    console.error(`REPOVINE_ROOT does not exist: ${root}`);
    process.exit(1);
  }
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) {
    console.error(`REPOVINE_ROOT is not a directory: ${root}`);
    process.exit(1);
  }
  const probeDir = path.join(root, ARTIFACTS_DIR_NAME, '.cache');
  try {
    fs.mkdirSync(probeDir, { recursive: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.error(`Cannot write under ${root}/${ARTIFACTS_DIR_NAME}/ — ${err.code ?? err.message}`);
    console.error('Use a repo path where you have write permission (your clone, not /path/to/...).');
    process.exit(1);
  }
}

assertWritableRepoRoot(repoRoot);

const config = loadConfig(repoRoot);
console.log(`Profiling repovine pipeline for ${repoRoot}`);
console.log('Mode: cold (repository facts snapshot cache disabled)\n');

const ctx = await RepovineRuntime.create(repoRoot, artifactsDir, config, { coldSnapshot: true });
const stats = ctx.getState().graph.nodes.size;
console.log(`\nDone. Graph nodes in memory: ${stats}`);
