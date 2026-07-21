import { createHash } from 'node:crypto';
import type { SourcePlugin } from '@repovine/plugin-sdk';
import type { ScanPatternInput } from '../scan-filters.js';

export interface ExtractionConfigFingerprintInput {
  repoRoot: string;
  scanInclude?: readonly ScanPatternInput[];
  scanExclude?: readonly ScanPatternInput[];
  sourcePlugins: readonly SourcePlugin[];
  iacPluginIds: readonly string[];
  extractContextByPlugin: ReadonlyMap<string, unknown>;
}

function portableString(value: string, repoRoot: string): string {
  const rootNative = repoRoot.replace(/[\\/]+$/, '') || repoRoot;
  const rootPosix = rootNative.replace(/\\/g, '/');
  return value
    .replaceAll(rootNative, '<repo>')
    .replaceAll(rootPosix, '<repo>')
    .replace(/\\/g, '/');
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
        .sort(([a], [b]) => a.localeCompare(b));
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
    packageMarkers: plugin.packageMarkers,
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
  const payload = {
    scanInclude: input.scanInclude ?? [],
    scanExclude: input.scanExclude ?? [],
    sourcePlugins: input.sourcePlugins.map(sourcePluginIdentity),
    iacPluginIds: [...input.iacPluginIds],
    extractContextByPlugin: input.extractContextByPlugin,
  };
  return createHash('sha256')
    .update(stableSerialize(payload, input.repoRoot))
    .digest('hex')
    .slice(0, 24);
}
