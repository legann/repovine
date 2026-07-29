import { setPipelineLogSink } from '../src/cli/ui.js';
import { defaultPluginsConfig, loadPluginSet } from '../src/plugin-host/load.js';

setPipelineLogSink('silent');

// CLI commands (init/clear file-result lines) print human-facing progress with console.log. That is
// stdout chatter, never a test signal, so it only floods the Jest report. Silence console.log by
// default; tests that assert on it install their own jest.spyOn(console, 'log'), which still records
// calls through this noop. console.error/console.warn stay live so real failures surface — tests that
// intentionally exercise those paths spy on them locally. Set REPOVINE_TEST_LOG=1 to keep stdout for
// debugging a single test run. (logCli/process.stdout.write output — e.g. doctor — is a separate
// channel and is unaffected.)
if (process.env.REPOVINE_TEST_LOG !== '1') {
  console.log = () => {};
}

// ts-jest runs Stage 1 from src/, but worker_threads need the compiled dist/stage1/worker.js.
// Cap the pool to inline extraction unless a test overrides maxPackageWorkers explicitly.
if (process.env.REPOVINE_MAX_PACKAGE_WORKERS === undefined) {
  process.env.REPOVINE_MAX_PACKAGE_WORKERS = '1';
}

// Same for Stage 2: default to inline compose so the general suite does not spawn a stage2 worker on
// every runtime build (worker offload needs dist/stage2/worker.js). The parity test opts back in.
if (process.env.REPOVINE_STAGE2_INLINE === undefined) {
  process.env.REPOVINE_STAGE2_INLINE = '1';
}

// The plugin set is loaded, not registered by import. A test process is an isolate like any other,
// so it installs the bundled preset the same way every entrypoint does — otherwise a module id, a
// domain label or an MCP scope reduces by an empty set of known extensions.
//
// Top-level await: `setupFiles` are ESM here, and a test body that ran before the set was installed
// would read the empty answer.
await loadPluginSet({ repoRoot: process.cwd(), config: defaultPluginsConfig() });
