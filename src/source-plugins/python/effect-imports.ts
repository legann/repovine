import type { ImportInfo } from '@repovine/plugin-sdk';
import { compareCodeUnits } from '../../platform/ordering.js';

/**
 * Conservative import → side-effect-kind mapping for Python modules.
 *
 * Feeds `SemanticHints.effectImports`, which the annotation consistency axis reads via
 * `detectSideEffectKindsFromHints` (declared-`pure` vs detected effects). The table lists only
 * modules whose import unambiguously implies a real behavioral effect — importing `subprocess`
 * or `requests` in a "pure" module is a contradiction worth flagging. Ambiguous or near-universal
 * modules (`os`, `sys`, `json`, `logging`, `asyncio`, `typing`, …) are deliberately absent:
 * over-mapping would false-flag legitimately pure modules, and a missing detection only means
 * the pure-check is skipped — never a wrong claim. Kinds follow the SideEffect vocabulary.
 */
const EFFECT_IMPORT_TABLE: ReadonlyArray<{ prefix: string; kind: string }> = [
  // Child processes / threads.
  { prefix: 'subprocess', kind: 'concurrency' },
  { prefix: 'threading', kind: 'concurrency' },
  { prefix: 'multiprocessing', kind: 'concurrency' },
  // HTTP clients (read is the minimal honest claim; any network access contradicts `pure`).
  { prefix: 'requests', kind: 'io-read' },
  { prefix: 'httpx', kind: 'io-read' },
  { prefix: 'aiohttp', kind: 'io-read' },
  { prefix: 'urllib.request', kind: 'io-read' },
  { prefix: 'http.client', kind: 'io-read' },
  // Raw sockets need lifetime management.
  { prefix: 'socket', kind: 'resource' },
  // Opaque cloud SDKs.
  { prefix: 'boto3', kind: 'external' },
  { prefix: 'botocore', kind: 'external' },
  // Database drivers/clients.
  { prefix: 'sqlite3', kind: 'io-read' },
  { prefix: 'psycopg2', kind: 'io-read' },
  { prefix: 'psycopg', kind: 'io-read' },
  { prefix: 'pymysql', kind: 'io-read' },
  { prefix: 'pymongo', kind: 'io-read' },
  { prefix: 'redis', kind: 'io-read' },
  { prefix: 'sqlalchemy', kind: 'io-read' },
];

function matches(specifier: string, prefix: string): boolean {
  return specifier === prefix || specifier.startsWith(prefix + '.');
}

/** Derive `{ kind, source }` effect hints from a module's EXTERNAL imports. Deterministic:
 * deduplicated by (kind, source) and sorted. Intra-repo imports never imply effects here —
 * the imported module carries its own hints. */
export function effectImportsFromPythonImports(
  imports: readonly ImportInfo[],
): Array<{ kind: string; source: string }> {
  const seen = new Set<string>();
  const out: Array<{ kind: string; source: string }> = [];
  for (const imp of imports) {
    if (!imp.isExternal) continue;
    for (const entry of EFFECT_IMPORT_TABLE) {
      if (!matches(imp.moduleSpecifier, entry.prefix)) continue;
      const key = `${entry.kind}\u0000${entry.prefix}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: entry.kind, source: entry.prefix });
    }
  }
  out.sort((a, b) => compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.source, b.source));
  return out;
}
