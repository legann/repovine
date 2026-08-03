import { describe, expect, it } from '@jest/globals';
import { createEmptyGraph, addNode, addEdge } from '../../../../src/graph/index.js';
import { findInterfaceImplementations } from '../../../../src/mcp/lib/dependencies/interfaces.js';
import type { McpToolRuntime } from '../../../../src/mcp/types.js';

function ctxOf(graph: ReturnType<typeof createEmptyGraph>): McpToolRuntime {
  return { getState: () => ({ graph }) } as unknown as McpToolRuntime;
}

describe('findInterfaceImplementations — edge traversal', () => {
  it('returns only classes linked by an implements edge, not string look-alikes', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:app/ports', type: 'module', label: 'ports', description: '' });
    addNode(graph, { id: 'mod:app/other', type: 'module', label: 'other', description: '' });
    addNode(graph, { id: 'mod:app/repo', type: 'module', label: 'repo', description: '' });

    // Two interfaces share the name `IRepo` in different modules — edge traversal must not confuse them.
    addNode(graph, { id: 'export:app/ports/IRepo', type: 'export-symbol', label: 'IRepo', description: '', data: { symbolKind: 'interface' } });
    addNode(graph, { id: 'export:app/other/IRepo', type: 'export-symbol', label: 'IRepo', description: '', data: { symbolKind: 'interface' } });

    // SqlRepo is linked to ports/IRepo by a proven implements edge.
    addNode(graph, { id: 'export:app/repo/SqlRepo', type: 'export-symbol', label: 'SqlRepo', description: '',
      data: { symbolKind: 'class', signature: 'class SqlRepo', lineRange: { start: 5, end: 20 } } });
    // StringOnly carries the bare name in data but has no edge — the old string match would have
    // (wrongly) returned it; edge traversal does not.
    addNode(graph, { id: 'export:app/repo/StringOnly', type: 'export-symbol', label: 'StringOnly', description: '',
      data: { symbolKind: 'class', implementsInterfaces: ['IRepo'] } });

    addEdge(graph, 'mod:app/repo', 'export:app/repo/SqlRepo', 'contains');
    addEdge(graph, 'mod:app/repo', 'export:app/repo/StringOnly', 'contains');
    addEdge(graph, 'export:app/repo/SqlRepo', 'export:app/ports/IRepo', 'implements');

    const result = findInterfaceImplementations(ctxOf(graph), { interfaceName: 'IRepo' }) as {
      interface: string;
      count: number;
      implementations: Array<{ classId: string; className: string; moduleId?: string; moduleLabel?: string }>;
    };

    expect(result.interface).toBe('IRepo');
    expect(result.count).toBe(1);
    expect(result.implementations[0]).toMatchObject({
      classId: 'export:app/repo/SqlRepo',
      className: 'SqlRepo',
      moduleId: 'mod:app/repo',
      moduleLabel: 'repo',
    });
  });

  it('returns empty for an interface with no implementers', () => {
    const graph = createEmptyGraph();
    addNode(graph, { id: 'export:app/ports/IUnused', type: 'export-symbol', label: 'IUnused', description: '', data: { symbolKind: 'interface' } });
    const result = findInterfaceImplementations(ctxOf(graph), { interfaceName: 'IUnused' }) as { count: number };
    expect(result.count).toBe(0);
  });
});
