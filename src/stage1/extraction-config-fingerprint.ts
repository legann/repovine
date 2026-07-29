import { currentDirLayoutTable, HASH_WIDTH, sha256Hex } from '@repovine/plugin-sdk';
import type { SourcePlugin } from '@repovine/plugin-sdk';
import type { ScanPatternInput } from '../scan-filters.js';
import { compareCodeUnits } from '../platform/ordering.js';
import { toPosixPath } from '../platform/paths.js';

export interface ExtractionConfigFingerprintInput {
  repoRoot: string;
  scanInclude?: readonly ScanPatternInput[];
  scanExclude?: readonly ScanPatternInput[];
  sourcePlugins: readonly SourcePlugin[];
  iacPluginIds: readonly string[];
  extractContextByPlugin: ReadonlyMap<string, unknown>;
  /**
   * Identity of the per-run plugin runtime: plugin versions, the merged declaration catalog, loader
   * ids and projector ids with their declared fact needs. Each changes what a build produces from
   * unchanged source bytes, so a snapshot taken under one is not reusable under another.
   */
  pluginRuntime?: unknown;
}

function portableString(value: string, repoRoot: string): string {
  const rootNative = repoRoot.replace(/[\\/]+$/, '') || repoRoot;
  const rootPosix = toPosixPath(rootNative);
  return toPosixPath(
    value
      .replaceAll(rootNative, '<repo>')
      .replaceAll(rootPosix, '<repo>'),
  );
}

function stableSerialize(value: unknown, repoRoot: string, onStack = new Set<object>()): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(portableString(value, repoRoot));
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'symbol') return `symbol:${String(value.description ?? '')}`;
  if (typeof value === 'function') return `function:${value.name || '<anonymous>'}`;

  if (value instanceof RegExp) return `regexp:${value.source}/${value.flags}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (onStack.has(value)) return '[Circular]';
  onStack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => stableSerialize(item, repoRoot, onStack)).join(',')}]`;
    }
    if (value instanceof Map) {
      const entries = [...value.entries()]
        .map(([key, entry]) => [
          stableSerialize(key, repoRoot, onStack),
          stableSerialize(entry, repoRoot, onStack),
        ] as const)
        .sort(([a], [b]) => compareCodeUnits(a, b));
      return `map:{${entries.map(([key, entry]) => `${key}:${entry}`).join(',')}}`;
    }
    if (value instanceof Set) {
      const entries = [...value].map(entry => stableSerialize(entry, repoRoot, onStack)).sort();
      return `set:[${entries.join(',')}]`;
    }
    const objectValue = value as Record<string, unknown>;
    const entries = Object.keys(objectValue)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableSerialize(objectValue[key], repoRoot, onStack)}`);
    return `{${entries.join(',')}}`;
  } finally {
    onStack.delete(value);
  }
}

function sourcePluginIdentity(plugin: SourcePlugin): Record<string, unknown> {
  return {
    id: plugin.id,
    apiVersion: plugin.apiVersion,
    // `packageMarkers` is absent here on purpose: it is folded in from the installed layout table
    // below, which is the value discovery actually ran with.
    fileMatch: plugin.fileMatch && {
      extensions: plugin.fileMatch.extensions,
      fileNames: plugin.fileMatch.fileNames,
      fileNamePatterns: plugin.fileMatch.fileNamePatterns?.map(pattern => `${pattern.source}/${pattern.flags}`),
    },
    capabilities: plugin.capabilities,
    requires: plugin.requires,
  };
}

/**
 * Identity for every input that can change extracted module facts without changing source bytes.
 * The snapshot reuse gate stores this hash, so tsconfig/compiler-option changes, scan-pattern
 * edits, and active plugin changes force a full extraction instead of reusing stale semantics.
 */
export function computeExtractionConfigFingerprint(input: ExtractionConfigFingerprintInput): string {
  const layout = currentDirLayoutTable();
  const payload = {
    scanInclude: input.scanInclude ?? [],
    scanExclude: input.scanExclude ?? [],
    sourcePlugins: input.sourcePlugins.map(sourcePluginIdentity),
    // The layout this build walked by, read from the same table discovery read: which directories
    // were skipped and which filenames marked a package root both decide which modules exist, so a
    // snapshot taken under one table is not reusable under another.
    dirLayout: {
      pruned: [...layout.pruned],
      testLayout: [...layout.testLayout],
      prunedWhenContains: layout.prunedWhenContains,
      packageMarkers: layout.packageMarkers,
    },
    iacPluginIds: [...input.iacPluginIds],
    extractContextByPlugin: input.extractContextByPlugin,
    pluginRuntime: input.pluginRuntime ?? null,
  };
  return sha256Hex(stableSerialize(payload, input.repoRoot), HASH_WIDTH.config);
}
