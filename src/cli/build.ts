import { RepovineRuntime } from '../mcp/context.js';
import { loadConfig } from '../config.js';
import { TRANSFORMERS_PACKAGE } from '../semantic/transformers-install.js';

import { cli, formatBuildSummary, logCli, setPipelineLogSink, setProgressInPlace } from './ui.js';

/**
 * Eagerly build the repovine context (Stage 1+2+3) and persist the snapshot cache.
 *
 * This is the user-facing pre-build path triggered by `repovine build` and by `repovine setup
 * [target]`, which builds by default (`--no-build` defers to the first MCP start). Progress
 * prints to stdout via the existing per-stage instrumentation,
 * so users on large repos can watch what's happening instead of staring at a silent
 * subprocess that the MCP host would kill on its init timeout.
 */
export async function runBuild(
  repoRoot: string,
  artifactsDir: string,
  options: { cleanupOrphans?: boolean } = {},
): Promise<RepovineRuntime> {
  setPipelineLogSink('stderr');
  setProgressInPlace(true);
  const cfg = loadConfig(repoRoot);
  // Derived-off is the plain-install case: the peer is absent, so the default resolved to false and
  // nothing downstream would say why. An explicit `false` is the user's own choice and stays silent —
  // the embedder error advertises that key as the way to silence this.
  if (!cfg.semanticSearchEmbeddings && cfg.semanticSearchEmbeddingsDerived) {
    logCli(
      `  Semantic search is off: the opt-in peer dependency ${TRANSFORMERS_PACKAGE} is not installed `
      + `(~700MB ONNX runtime). Search runs on the token index. Enable it with: `
      + `npm install ${TRANSFORMERS_PACKAGE}`,
    );
  }
  logCli(cli.bold(`Building repovine context for: ${repoRoot}`));
  const t0 = Date.now();
  const ctx = await RepovineRuntime.create(repoRoot, artifactsDir, cfg);
  const state = ctx.getState();

  // Orchestrator-level orphan cleanup (e.g. harness join barrier): drop
  // annotations whose nodes no longer exist after the rebuild. Mirrors the MCP
  // refresh_context({ cleanupOrphans: true }) path; agents normally clean their
  // own scope, so this is a belt-and-suspenders sweep.
  if (options.cleanupOrphans) {
    const orphaned = state.annotations.detectOrphaned(state.graph).orphaned.map(o => o.nodeId);
    if (orphaned.length > 0) {
      await state.annotations.flushAsync();
      const removed = state.annotations.delete(orphaned);
      await state.annotations.flushAsync();
      logCli(`  Cleaned ${removed} orphaned annotation(s).`);
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  for (const line of formatBuildSummary({
    seconds: dt,
    modules: state.snapshot.modules.length,
    graphNodes: state.graph.nodes.size,
    annotations: Object.keys(state.annotations.getAll()).length,
  })) {
    logCli(line);
  }
  return ctx;
}
