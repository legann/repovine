import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import { describe, it, expect } from '@jest/globals';
import { addNode, addEdge, createEmptyGraph } from '../../../../src/graph/index.js';
import { getCallersByName, callersOfName } from '../../../../src/mcp/lib/dependencies/reverse-calls.js';
import { analyzeImpact } from '../../../../src/mcp/lib/dependencies/impact.js';
import type { ModuleInfo, RepositoryGraph } from '../../../../src/types.js';
import type { McpToolRuntime } from '../../../../src/mcp/types.js';
import { deliveredValue } from '../../../../src/response/refusal.js';

function mod(id: string, opts: { exportCalls?: Record<string, string[]>; moduleCalls?: string[] } = {}): ModuleInfo {
  const exports = Object.entries(opts.exportCalls ?? {}).map(([name, calls]) => ({
    name, kind: 'function' as const, lineRange: { start: 1, end: 2 }, isDefault: false, calls,
  }));
  return {
    id, packageName: id.split('/')[0].slice(4), absPath: asHostPath(`/repo/${id}.ts`), pkgRelPath: asPkgRelPath(`${id}.ts`),
    contentHash: id, imports: [], exports,
    ...(opts.moduleCalls ? { calls: opts.moduleCalls } : {}),
  };
}

function runtime(graph: RepositoryGraph, modulesById: Map<string, ModuleInfo>): McpToolRuntime {
  return { getState: () => ({ graph, modulesById }) } as unknown as McpToolRuntime;
}

describe('reverse-calls index', () => {
  it('inverts per-export calls and module-level calls to name → callers', () => {
    const modulesById = new Map<string, ModuleInfo>([
      ['mod:app/a', mod('mod:app/a', { exportCalls: { Comp: ['validateMonitor', 'useThing'] } })],
      ['mod:app/b', mod('mod:app/b', { moduleCalls: ['validateMonitor'] })],
    ]);
    const index = getCallersByName(modulesById);
    expect(index.get('validateMonitor')).toEqual(new Set(['mod:app/a', 'mod:app/b']));
    expect(index.get('useThing')).toEqual(new Set(['mod:app/a']));
    expect(callersOfName(modulesById, 'absent')).toEqual([]);
  });

  it('memoizes per modulesById identity', () => {
    const modulesById = new Map<string, ModuleInfo>([['mod:app/a', mod('mod:app/a', { moduleCalls: ['x'] })]]);
    expect(getCallersByName(modulesById)).toBe(getCallersByName(modulesById));
  });
});

describe('analyzeImpact — reverse-by-name union (Part 2)', () => {
  it('surfaces a name-matched caller of an export-symbol, its provenance inferred', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:app/validator', type: 'module', label: 'validator.ts', description: '' });
    addNode(graph, { id: 'export:app/validator/validateMonitor', type: 'export-symbol', label: 'validateMonitor', description: '', data: { symbolKind: 'function' } });
    addEdge(graph, 'mod:app/validator', 'export:app/validator/validateMonitor', 'contains');
    addNode(graph, { id: 'mod:app/formatter', type: 'module', label: 'formatter.ts', description: '' });

    const modulesById = new Map<string, ModuleInfo>([
      ['mod:app/validator', mod('mod:app/validator', { exportCalls: { validateMonitor: [] } })],
      ['mod:app/formatter', mod('mod:app/formatter', { exportCalls: { ProjectMonitorFormatter: ['validateMonitor'] } })],
    ]);

    const result = deliveredValue(analyzeImpact(runtime(graph, modulesById), { nodeId: 'export:app/validator/validateMonitor' })) as {
      downstream: Array<{ id: string; provenance?: { basis: string; method: string } }>;
      nameMatchedCallers?: number;
    };
    const formatter = result.downstream.find(e => e.id === 'mod:app/formatter');
    expect(formatter).toBeDefined();
    expect(formatter?.provenance).toEqual({ basis: 'inferred', method: 'call-name-index' });
    expect(result.nameMatchedCallers).toBe(1);
  });

  it('surfaces a cross-package barrel caller whose import resolves only to the package node', () => {
    // `mod:web/tool` imports `slugify` through `export *` in @shared, so its import edge resolves to
    // `pkg:@shared` (not the leaf) and no resolved import edge to the leaf exists. Name-match still
    // finds it because the call name `slugify` is in the module's calls.
    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:shared/utils', type: 'module', label: 'utils.ts', description: '' });
    addNode(graph, { id: 'export:shared/utils/slugify', type: 'export-symbol', label: 'slugify', description: '', data: { symbolKind: 'function' } });
    addEdge(graph, 'mod:shared/utils', 'export:shared/utils/slugify', 'contains');
    addNode(graph, { id: 'mod:web/tool', type: 'module', label: 'tool.ts', description: '' });

    const modulesById = new Map<string, ModuleInfo>([
      ['mod:shared/utils', mod('mod:shared/utils', { exportCalls: { slugify: [] } })],
      ['mod:web/tool', mod('mod:web/tool', { exportCalls: { run: ['slugify'] } })],
    ]);

    const result = deliveredValue(analyzeImpact(runtime(graph, modulesById), { nodeId: 'export:shared/utils/slugify' })) as {
      downstream: Array<{ id: string; provenance?: { basis: string; method: string } }>;
    };
    expect(result.downstream.find(e => e.id === 'mod:web/tool')?.provenance)
      .toEqual({ basis: 'inferred', method: 'call-name-index' });
  });

  it('resolves export-symbol scope to the parent module and filters importers by export name (Part 3)', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:app/validator', type: 'module', label: 'validator.ts', description: '' });
    addNode(graph, { id: 'export:app/validator/validateMonitor', type: 'export-symbol', label: 'validateMonitor', description: '', data: { symbolKind: 'function' } });
    addEdge(graph, 'mod:app/validator', 'export:app/validator/validateMonitor', 'contains');
    // caller imports validateMonitor from the validator module → resolved import edge.
    addNode(graph, { id: 'mod:app/caller', type: 'module', label: 'caller.ts', description: '' });
    addEdge(graph, 'mod:app/caller', 'mod:app/validator', 'imports');
    // other imports a same-named symbol from a DIFFERENT module → must not be a false positive.
    addNode(graph, { id: 'mod:app/other', type: 'module', label: 'other.ts', description: '' });
    addNode(graph, { id: 'mod:other/thing', type: 'module', label: 'thing.ts', description: '' });
    addEdge(graph, 'mod:app/other', 'mod:other/thing', 'imports');

    const caller = mod('mod:app/caller');
    caller.imports = [{ moduleSpecifier: './validator', resolvedModuleId: 'mod:app/validator', importedNames: ['validateMonitor'], isTypeOnly: false, isExternal: false }];
    const other = mod('mod:app/other');
    other.imports = [{ moduleSpecifier: 'other', resolvedModuleId: 'mod:other/thing', importedNames: ['validateMonitor'], isTypeOnly: false, isExternal: false }];
    const modulesById = new Map<string, ModuleInfo>([
      ['mod:app/validator', mod('mod:app/validator', { exportCalls: { validateMonitor: [] } })],
      ['mod:app/caller', caller],
      ['mod:app/other', other],
      ['mod:other/thing', mod('mod:other/thing')],
    ]);

    const result = deliveredValue(analyzeImpact(runtime(graph, modulesById), { nodeId: 'export:app/validator/validateMonitor' })) as {
      downstream: Array<{ id: string; uses?: string[]; provenance?: { basis: string; method: string } }>;
    };
    const resolved = result.downstream.find(e => e.id === 'mod:app/caller');
    expect(resolved).toBeDefined();
    expect(resolved?.uses).toContain('validateMonitor');
    // Absence means the walk reached it over a graph edge, not that a name happened to match.
    expect(resolved?.provenance).toBeUndefined();
    // same-name import from a different module is not a caller of THIS export.
    expect(result.downstream.find(e => e.id === 'mod:app/other')).toBeUndefined();
  });

  it('does not add name-match for a module scope without exportName', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:app/a', type: 'module', label: 'a.ts', description: '' });
    addNode(graph, { id: 'mod:app/b', type: 'module', label: 'b.ts', description: '' });
    const modulesById = new Map<string, ModuleInfo>([
      ['mod:app/a', mod('mod:app/a')],
      ['mod:app/b', mod('mod:app/b', { moduleCalls: ['a'] })],
    ]);
    const result = deliveredValue(analyzeImpact(runtime(graph, modulesById), { nodeId: 'mod:app/a' })) as {
      downstream: Array<{ id: string }>; nameMatchedCallers?: number;
    };
    expect(result.nameMatchedCallers).toBeUndefined();
  });
});
