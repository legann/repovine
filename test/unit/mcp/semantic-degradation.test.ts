/**
 * The build path every plugin user takes on first run: `semantic_search_embeddings` defaults to
 * true, and installing repovine does not pull `@huggingface/transformers` (an opt-in peer — ~700MB
 * of ONNX runtime). The engine degrades instead of failing: the graph builds, the failure is
 * reported, and search keeps answering from the token index.
 *
 * The engine checkout carries the package as a devDependency, so a bare import always resolves
 * here; absence is simulated at the pipeline seam. Real absence — and the actionable install
 * message — is exercised in a clean Node process by scripts/smoke-pack-install.mjs.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepovineRuntime } from '../../../src/mcp/context.js';
import { __setTransformersModuleForTest } from '../../../src/semantic/embedder.js';
import { CONFIG_DEFAULTS } from '../../../src/config.js';
import type { McpToolRuntime } from '../../../src/mcp/types.js';
import { copyFixtureDirSync } from '../../helpers/fixture-copy.js';

/** The default a fresh `repovine setup` writes — not the suite-wide `semanticSearchEmbeddings: false`. */
const EMBEDDINGS_ON_CONFIG = { ...CONFIG_DEFAULTS, semanticSearchEmbeddings: true };

const UNAVAILABLE = 'semantic_search_embeddings requires the opt-in peer dependency @huggingface/transformers';

function findFixtureSrc(): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'fixtures', 'basic-typescript'),
    path.resolve(process.cwd(), 'repovine', 'test', 'fixtures', 'basic-typescript'),
  ];
  const root = candidates.find(candidate => fs.existsSync(candidate));
  if (!root) throw new Error(`Could not find basic-typescript fixture. Tried: ${candidates.join(', ')}`);
  return root;
}

type SearchEnvelope = {
  gaps?: string[];
  result: {
    matches: {
      totalResults: number;
      strategy: { semantic: { used: boolean } };
    };
  };
};

describe('graph build with the opt-in embedder unavailable', () => {
  let tmpRoot: string;
  let fixtureRoot: string;
  let toolHandlers: Record<string, (ctx: McpToolRuntime, args: Record<string, unknown>) => unknown | Promise<unknown>>;

  beforeAll(async () => {
    ({ toolHandlers } = await import('../../../src/mcp/tools/registry.js'));
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-no-embedder-'));
    fixtureRoot = path.join(tmpRoot, 'basic-typescript');
    copyFixtureDirSync(findFixtureSrc(), fixtureRoot);
  });

  afterEach(() => {
    // The override and the pipeline memo are module-scoped; leaving them set leaks into siblings.
    __setTransformersModuleForTest(undefined);
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('completes the build, reports the failure, and keeps search on the token index', async () => {
    // Stands in for the absent package: the pipeline never loads, so every embed rejects.
    __setTransformersModuleForTest({
      pipeline: () => Promise.reject(new Error(UNAVAILABLE)),
    } as unknown as Parameters<typeof __setTransformersModuleForTest>[0]);
    const warn = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      // Cold artifacts dir: no persisted semantic-index.json, so every card is pending and the
      // embed actually runs. A warm index would short-circuit before reaching the embedder.
      const artifactsDir = path.join(tmpRoot, '.repovine-embed-failure');
      const ctx = await RepovineRuntime.create(fixtureRoot, artifactsDir, EMBEDDINGS_ON_CONFIG);
      const state = ctx.getState();

      expect(state.graph.nodes.size).toBeGreaterThan(0);
      expect(state.snapshot.modules.length).toBeGreaterThan(0);

      // Reported, not swallowed: this is what an agent reads back from refresh_context.
      expect(state.semanticSearchRefresh).toEqual({
        status: 'failed',
        total: 0,
        error: expect.stringContaining(UNAVAILABLE),
      });
      expect(warn.mock.calls.flat().join(' ')).toContain('Semantic search index sync failed');

      const toolCtx: McpToolRuntime = {
        getState: () => ctx.getState(),
        getConfig: () => EMBEDDINGS_ON_CONFIG,
        refreshRepoState: () => {},
        repoRoot: fixtureRoot,
      };
      const envelope = await toolHandlers['search_context'](toolCtx, { query: 'UserService' }) as SearchEnvelope;

      // Search answers from the token index; the semantic leg is simply absent from the strategy.
      expect(envelope.result.matches.totalResults).toBeGreaterThan(0);
      expect(envelope.result.matches.strategy.semantic.used).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
