/**
 * Shared helpers for the CLI-only surfaces served under `repovine delivery` and
 * `repovine agents`: the repo/artifacts env shape and the JSON-out / flag-parse
 * primitives both dispatchers use. Kept here so neither dispatcher imports the
 * other.
 */
import fs from 'node:fs';

export interface AgentsCliEnv {
  repoRoot: string;
  artifactsDir: string;
}

/**
 * Write a result straight to stdout so it stays pure JSON even when graph-build
 * progress is logged (see buildComplianceState), keeping the CLI pipe/CI-safe.
 */
export function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export function readJsonFile(
  file: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf-8')) };
  } catch (e) {
    return { ok: false, error: `Cannot read/parse ${file}: ${(e as Error).message}` };
  }
}

export function numberFlag(args: string[], flag: string): number | undefined {
  const raw = flagValue(args, flag);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
