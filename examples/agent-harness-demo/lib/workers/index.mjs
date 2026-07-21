// Worker selection for the LangGraph path. ONE graph; the provider is the
// variable, chosen at run_sub_agent dispatch from LLM_PROVIDER.
//
//   const worker = await getWorker(provider);   // dynamic import
//   const result = await worker.runAgent(task, assignment, repoRoot, opts);
//
// Every adapter implements the SAME async seam:
//   runAgent(task, assignment, repoRoot, opts?: { resume?, capture? }) => Promise<AgentRunResult>
// Auth is resolved once in lib/workers/auth.mjs — adapters never duplicate it.
import { knownProvider } from './auth.mjs';

export const DEFAULT_PROVIDER = 'claude';
export const PROVIDERS = ['claude', 'local'];

export function resolveProvider(provider = process.env.LLM_PROVIDER || DEFAULT_PROVIDER) {
  return provider;
}

/** True for a provider we have an adapter for. Used by graph intake to fail fast. */
export function isSupportedProvider(provider) {
  return knownProvider(provider) && PROVIDERS.includes(provider);
}

/** Dynamic-import the adapter module for `provider`. Lazy so unused SDKs/CLIs never load. */
export function getWorker(provider = resolveProvider()) {
  switch (provider) {
    case 'local':
      return import('./local.mjs');
    case 'claude':
    default:
      return import('./claude.mjs');
  }
}
