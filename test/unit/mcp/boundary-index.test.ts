import { asHostPath, asPkgRelPath, asRepoRelPath } from '@repovine/plugin-sdk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  buildBoundaryIndex,
  writeBoundaryIndex,
  readBoundaryIndex,
  boundaryIndexFilePath,
} from '../../../src/mcp/boundary-index.js';
import { createEmptyGraph, addNode, addEdge } from '../../../src/graph/index.js';
import type {
  AnnotationContent,
  ModuleInfo,
  RepositoryFactsSnapshot,
  RiskEntry,
  StoredAnnotation,
} from '../../../src/types.js';
import type { AnnotationStore } from '../../../src/annotations/store.js';
import type { RepovineState } from '../../../src/mcp/types.js';
import { readClientDispatcherSource } from '../../../src/cli/dispatcher/index.js';

/** Minimal StoredAnnotation with the given risks; only fields buildBoundaryIndex reads matter here. */
function ann(nodeId: string, nodeType: StoredAnnotation['nodeType'], risks: RiskEntry[]): StoredAnnotation {
  const annotation: AnnotationContent = { summary: 'synthetic annotation for the boundary index test', risks };
  return { nodeId, nodeType, contentHash: 'h', pass: 1, updatedAt: '2026-06-29T00:00:00.000Z', annotation };
}

function moduleInfo(id: string, relativeFilePath: string): ModuleInfo {
  return {
    id,
    packageName: 'app',
    absPath: asHostPath(`/abs/${relativeFilePath}`),
    pkgRelPath: asPkgRelPath(relativeFilePath),
    contentHash: 'h',
    imports: [],
    exports: [],
  };
}

/**
 * Build a synthetic RepovineState: a module, one of its exports, a template, and an infra module —
 * the four node kinds that resolve to a single owning file. The annotation map is supplied per test.
 */
function makeState(annots: Record<string, StoredAnnotation>): RepovineState {
  const graph = createEmptyGraph();
  addNode(graph, { id: 'mod:app/src/contracts/order-dto', type: 'module', label: 'order-dto', description: '' });
  addNode(graph, { id: 'mod:app/src/services/order-service', type: 'module', label: 'order-service', description: '' });
  addNode(graph, { id: 'export:app/src/contracts/order-dto/OrderDto', type: 'export-symbol', label: 'OrderDto', description: '' });
  addNode(graph, { id: 'template:app/views/receipt.hbs', type: 'template', label: 'receipt.hbs', description: '' });
  addNode(graph, { id: 'infra:lambda:app/handlers/process', type: 'runtime-resource', label: 'process', description: '' });
  // contains edge: the export's parent module (parentModuleId resolves via this in-edge).
  addEdge(graph, 'mod:app/src/contracts/order-dto', 'export:app/src/contracts/order-dto/OrderDto', 'contains');

  const modulesById = new Map<string, ModuleInfo>([
    ['mod:app/src/contracts/order-dto', moduleInfo('mod:app/src/contracts/order-dto', 'app/src/contracts/order-dto.ts')],
    ['mod:app/src/services/order-service', moduleInfo('mod:app/src/services/order-service', 'app/src/services/order-service.ts')],
  ]);

  const snapshot = {
    repoRoot: '/abs',
    timestamp: '2026-06-29T00:00:00.000Z',
    packages: [],
    modules: [...modulesById.values()],
    infraModules: [
      {
        id: 'infra:lambda:app/handlers/process',
        kind: 'cloudformation',
        absPath: asHostPath('/abs/app/handlers/process.ts'),
        repoRelPath: asRepoRelPath('app/handlers/process.ts'),
        contentHash: 'h',
        resources: [],
      },
    ],
    templates: [
      { id: 'template:app/views/receipt.hbs', relPath: 'app/views/receipt.hbs', contentHash: 'h' },
    ],
  } as unknown as RepositoryFactsSnapshot;

  const annotations = { getAll: () => annots } as unknown as AnnotationStore;

  return {
    graph,
    snapshot,
    modulesById,
    annotations,
    builtAt: '2026-06-29T00:00:00.000Z',
  } as unknown as RepovineState;
}

const boundary = (text: string): RiskEntry => ({ text, scope: 'boundary' });

describe('buildBoundaryIndex', () => {
  it('keys a module boundary risk by its repo-relative file path', () => {
    const state = makeState({
      'mod:app/src/contracts/order-dto': ann('mod:app/src/contracts/order-dto', 'module', [
        boundary('published DTO consumed by the billing service; do not rename fields'),
      ]),
    });
    const index = buildBoundaryIndex(state);
    expect(Object.keys(index.entries)).toEqual(['app/src/contracts/order-dto.ts']);
    expect(index.entries['app/src/contracts/order-dto.ts']).toEqual([
      {
        nodeId: 'mod:app/src/contracts/order-dto',
        label: 'order-dto',
        risks: ['published DTO consumed by the billing service; do not rename fields'],
      },
    ]);
  });

  it('keys a monorepo module by its repo-root-relative path, not its package-relative pkgRelPath', () => {
    // absPath is absolute under repoRoot; pkgRelPath is package-relative and drops the
    // package-dir prefix (`platform/backend`). The hook resolves the edited file repo-root-relative,
    // so the key must include that prefix or the pre-edit advisory never fires.
    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:@backend/src/models/tool', type: 'module', label: 'tool', description: '' });
    const modulesById = new Map<string, ModuleInfo>([
      ['mod:@backend/src/models/tool', {
        id: 'mod:@backend/src/models/tool',
        packageName: '@backend',
        absPath: asHostPath('/repo/platform/backend/src/models/tool.ts'),
        pkgRelPath: asPkgRelPath('src/models/tool.ts'),
        contentHash: 'h',
        imports: [],
        exports: [],
      }],
    ]);
    const snapshot = {
      repoRoot: '/repo',
      timestamp: '2026-06-29T00:00:00.000Z',
      packages: [],
      modules: [...modulesById.values()],
      infraModules: [],
      templates: [],
    } as unknown as RepositoryFactsSnapshot;
    const state = {
      graph,
      snapshot,
      modulesById,
      annotations: {
        getAll: () => ({
          'mod:@backend/src/models/tool': ann('mod:@backend/src/models/tool', 'module', [boundary('frozen slug codec')]),
        }),
      },
      builtAt: '2026-06-29T00:00:00.000Z',
    } as unknown as RepovineState;
    expect(Object.keys(buildBoundaryIndex(state).entries)).toEqual(['platform/backend/src/models/tool.ts']);
  });

  it('resolves an export-symbol boundary risk to its parent module file', () => {
    const state = makeState({
      'export:app/src/contracts/order-dto/OrderDto': ann('export:app/src/contracts/order-dto/OrderDto', 'export-symbol', [
        boundary('frozen wire shape'),
      ]),
    });
    const index = buildBoundaryIndex(state);
    expect(Object.keys(index.entries)).toEqual(['app/src/contracts/order-dto.ts']);
    expect(index.entries['app/src/contracts/order-dto.ts'][0].nodeId)
      .toBe('export:app/src/contracts/order-dto/OrderDto');
  });

  it('keys template and infra boundary risks by their files', () => {
    const state = makeState({
      'template:app/views/receipt.hbs': ann('template:app/views/receipt.hbs', 'template', [boundary('rendered email contract')]),
      'infra:lambda:app/handlers/process': ann('infra:lambda:app/handlers/process', 'module', [boundary('frozen handler contract')]),
    });
    const index = buildBoundaryIndex(state);
    expect(index.entries['app/views/receipt.hbs']).toHaveLength(1);
    expect(index.entries['app/handlers/process.ts']).toHaveLength(1);
  });

  it('ignores local- and consumer-scoped risks (boundary only)', () => {
    const state = makeState({
      'mod:app/src/contracts/order-dto': ann('mod:app/src/contracts/order-dto', 'module', [
        'a bare local risk',
        { text: 'importer must verify the gate', scope: 'consumer' },
      ]),
    });
    expect(buildBoundaryIndex(state).entries).toEqual({});
  });

  it('groups a module and its export under the same file, sorted and deterministic', () => {
    const state = makeState({
      'mod:app/src/contracts/order-dto': ann('mod:app/src/contracts/order-dto', 'module', [boundary('module-level contract')]),
      'export:app/src/contracts/order-dto/OrderDto': ann('export:app/src/contracts/order-dto/OrderDto', 'export-symbol', [boundary('symbol-level contract')]),
    });
    const entries = buildBoundaryIndex(state).entries['app/src/contracts/order-dto.ts'];
    // Sorted by nodeId → export: sorts before mod:.
    expect(entries.map(e => e.nodeId)).toEqual([
      'export:app/src/contracts/order-dto/OrderDto',
      'mod:app/src/contracts/order-dto',
    ]);
  });

  it('returns empty entries when no annotation carries a boundary risk', () => {
    expect(buildBoundaryIndex(makeState({})).entries).toEqual({});
  });

  it('drops boundary risks on domain and runtime-resource nodes (push cannot key them; pull carries them)', () => {
    const state = makeState({
      'domain:billing': ann('domain:billing', 'domain', [boundary('domain-wide published contract')]),
      'resource:aws-sqs:orders-queue': ann('resource:aws-sqs:orders-queue', 'runtime-resource', [boundary('frozen queue contract')]),
    });
    expect(buildBoundaryIndex(state).entries).toEqual({});
  });

  it('locks the hook version guard to the writer version literal (drift lock)', () => {
    const writerVersion = buildBoundaryIndex(makeState({})).version;
    const source = readClientDispatcherSource();
    const m = source.match(/index\.version !== (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(writerVersion);
  });
});

describe('writeBoundaryIndex / readBoundaryIndex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-index-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips through .repovine/boundary-index.json', () => {
    const state = makeState({
      'mod:app/src/contracts/order-dto': ann('mod:app/src/contracts/order-dto', 'module', [boundary('published contract')]),
    });
    writeBoundaryIndex(tmpDir, state);
    expect(fs.existsSync(boundaryIndexFilePath(tmpDir))).toBe(true);
    const read = readBoundaryIndex(tmpDir);
    expect(read?.version).toBe(1);
    expect(read?.entries['app/src/contracts/order-dto.ts'][0].risks).toEqual(['published contract']);
  });

  it('readBoundaryIndex returns undefined when the file is absent', () => {
    expect(readBoundaryIndex(tmpDir)).toBeUndefined();
  });
});
