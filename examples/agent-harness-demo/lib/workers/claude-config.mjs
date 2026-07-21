import { finitePositive } from '../num.mjs';

export const DEFAULT_WORKER_TIMEOUT_MS = 600000;

export function claudeTimeoutMs({
  primaryEnv = 'CLAUDE_AGENT_TIMEOUT_MS',
  fallbackMs = DEFAULT_WORKER_TIMEOUT_MS,
} = {}) {
  return finitePositive(process.env[primaryEnv] || process.env.WORKER_TIMEOUT_MS, fallbackMs);
}

export function claudeSandbox({ autoAllowBashIfSandboxed = false } = {}) {
  const raw = process.env.CLAUDE_SANDBOX;
  if (raw && /^(0|false|off|none)$/i.test(raw.trim())) return undefined;
  // Fail closed: if the OS sandbox is unavailable the SDK errors rather than
  // silently degrading to unsandboxed while bypassPermissions stays on. Set
  // CLAUDE_SANDBOX=0 to opt out of sandboxing explicitly.
  return { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed };
}
