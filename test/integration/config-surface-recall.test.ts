/**
 * Hand-derived config-surface oracle.
 *
 * The fixture contains 16 runtime env-name accesses. Ten are direct literal forms supported by the
 * TS/Python extractors; six are still statically obvious to a reader but pass through an alias,
 * constant, or wrapper that the extractors intentionally do not resolve. The exact comparison
 * measures recall and pins the user-facing contract: returned items are proven, and the best-effort
 * coverage is stated in `gaps`. Envelope confidence answers whether the request resolved.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { collectConfigSurface } from '../../src/mcp/lib/config-surface.js';
import type { ToolResponse } from '../../src/mcp/response/envelope.js';
import { handleGetConfigSurface } from '../../src/mcp/tools/get-config-surface.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';
import type { ModuleInfo } from '../../src/types.js';

const FIXTURE_ROOT = [
  path.resolve(process.cwd(), 'test', 'fixtures', 'config-surface-oracle'),
  path.resolve(process.cwd(), 'repovine', 'test', 'fixtures', 'config-surface-oracle'),
].find(candidate => fs.existsSync(candidate));

if (!FIXTURE_ROOT) throw new Error('Could not find config-surface-oracle fixture.');

const EXPECTED_BY_FILE = {
  'src/config.ts': [
    'ALIASED_CONTAINER_TOKEN',
    'ALIASED_ENV',
    'CONST_KEY_SECRET',
    'DATABASE_PASSWORD',
    'DESTRUCTURED_ENV',
    'MODE',
    'PLAIN_ENV',
    'QUOTED_ENV',
    'VITE_PUBLIC_URL',
    'WRAPPED_SECRET',
  ],
  'app.py': [
    'PY_ALIAS_SECRET',
    'PY_CONST_SECRET',
    'PY_GET',
    'PY_GETENV',
    'PY_IMPORTED_SECRET',
    'PY_SUBSCRIPT',
  ],
} as const;

const DETECTED_BY_FILE = {
  'src/config.ts': [
    'ALIASED_ENV',
    'DATABASE_PASSWORD',
    'DESTRUCTURED_ENV',
    'MODE',
    'PLAIN_ENV',
    'QUOTED_ENV',
    'VITE_PUBLIC_URL',
  ],
  'app.py': [
    'PY_GET',
    'PY_GETENV',
    'PY_SUBSCRIPT',
  ],
} as const;

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

describe('config-surface recall and confidence', () => {
  let ctx: McpToolRuntime;
  let modules: ModuleInfo[];

  beforeAll(async () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      const snapshot = await collectRepositoryFactsAsync(FIXTURE_ROOT);
      const graph = composeRepositoryGraph(snapshot);
      const modulesById = new Map(snapshot.modules.map(module => [module.id, module]));
      modules = snapshot.modules;
      ctx = {
        getState: () => ({ graph, snapshot, modulesById }),
        repoRoot: FIXTURE_ROOT,
      } as unknown as McpToolRuntime;
    } finally {
      console.log = originalLog;
    }
  });

  it('matches the hand-derived detected subset exactly and records the recall ceiling', () => {
    const surface = collectConfigSurface(ctx, { scope: 'all', kind: 'all', limit: 100 });
    const detectedByFile = new Map<string, string[]>();
    for (const [file, expected] of Object.entries(DETECTED_BY_FILE)) {
      const module = modules.find(item => item.relativeFilePath === file);
      expect(module).toBeDefined();
      detectedByFile.set(
        file,
        sorted(
          surface.items
            .filter(item => item.moduleId === module!.id)
            .map(item => String(item.name)),
        ),
      );
      expect(detectedByFile.get(file)).toEqual(sorted(expected));
    }

    const expectedCount = Object.values(EXPECTED_BY_FILE).flat().length;
    const detectedCount = [...detectedByFile.values()].flat().length;
    expect({ detectedCount, expectedCount, recall: detectedCount / expectedCount }).toEqual({
      detectedCount: 10,
      expectedCount: 16,
      recall: 0.625,
    });
  });

  it('classifies detected secret/public env accesses without exposing values', () => {
    const surface = collectConfigSurface(ctx, { scope: 'all', kind: 'all', limit: 100 });
    expect(surface.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'DATABASE_PASSWORD', kind: 'secret' }),
      expect.objectContaining({ name: 'VITE_PUBLIC_URL', kind: 'public-config' }),
    ]));
    expect(
      collectConfigSurface(ctx, { scope: 'all', kind: 'secret', limit: 100 }).items
        .map(item => item.name),
    ).toContain('DATABASE_PASSWORD');
    expect(
      collectConfigSurface(ctx, { scope: 'all', kind: 'public-config', limit: 100 }).items
        .map(item => item.name),
    ).toContain('VITE_PUBLIC_URL');
  });

  it('states partial coverage in gaps, not by lowering envelope confidence', () => {
    const response = handleGetConfigSurface(ctx, {
      scope: 'all',
      kind: 'all',
      limit: 100,
    }) as ToolResponse;
    // Envelope confidence answers "did the request resolve" here exactly as on every other tool;
    // the 62.5% recall ceiling this suite pins is a completeness fact and belongs in gaps.
    expect(response.confidence).toBe('high');
    expect(response.summary).toContain('extracted');
    expect(response.gaps).toEqual([
      'Config-surface coverage is best-effort; computed, aliased, or wrapped config accesses may be omitted.',
    ]);
  });

  it('reports low confidence only when the request resolves to nothing', () => {
    const response = handleGetConfigSurface(ctx, {
      scope: 'pkg:does-not-exist',
      kind: 'all',
      limit: 100,
    }) as ToolResponse;
    expect(response.confidence).toBe('low');
  });
});
