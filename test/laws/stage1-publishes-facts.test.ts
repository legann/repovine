import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  ReadonlyFactRecord,
  SourceExtractInput,
  SourceExtractResult,
  SourcePlugin,
} from '@repovine/plugin-sdk';
import { runSourceExtraction } from '../../src/stage1/extract-runner.js';
import { createFactView } from '../../src/stage2/projection/fact-view.js';
import type { PackageInfo, PendingModule, RepositoryFactsSnapshot } from '../../src/types.js';

/**
 * Law: a Stage 1 producer's facts reach a Stage 2 projector, and only its own.
 *
 * A projector reads the fact view; the view is filled by producers. Without this channel the
 * `requires` half of the projection contract selects nothing and a plugin that owns an ecosystem
 * cannot tell the next pass what it found — the two passes run in different isolates, so nothing but
 * data crosses between them.
 *
 * What the boundary enforces is ownership and shape. A fact is published under a schema whose owner
 * segment is the publishing plugin, exactly as an extension is, and one that is not is refused with
 * the plugin named rather than dropped into silence.
 */

const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-facts-'));

function writeFile(relPath: string, content: string): string {
  const abs = path.join(REPO, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const pkg: PackageInfo = { name: 'shop', path: '.', sourcePluginId: 'canary' };

function pending(relPath: string): PendingModule {
  return {
    moduleId: `mod:shop/${relPath.replace(/\.[^.]+$/, '')}`,
    filePath: writeFile(relPath, 'source text'),
    pkg,
    relPath,
    sourcePluginId: 'canary',
  };
}

/** A producer that publishes exactly the facts the test hands it. */
function producer(id: string, facts: readonly unknown[]): SourcePlugin {
  return {
    id,
    discover: () => ({ packages: [pkg], pendingByPath: new Map() }),
    extract: (input: SourceExtractInput): SourceExtractResult => ({
      deltas: input.pendingModules.map(module => ({ moduleId: module.moduleId, imports: [], exports: [] })),
      reused: 0,
      rescanned: input.pendingModules.length,
      facts: facts as readonly ReadonlyFactRecord[],
    }),
  };
}

async function extract(plugin: SourcePlugin, modules: PendingModule[]): ReturnType<typeof runSourceExtraction> {
  return runSourceExtraction({
    plugin,
    repoRoot: REPO,
    packages: [pkg],
    pendingModules: modules,
    prevByPath: new Map(),
    absPathToId: new Map(modules.map(module => [module.filePath, module.moduleId])),
    analysisVersion: 1,
  });
}

const route = (moduleId: string): ReadonlyFactRecord => ({
  schema: 'canary/route@1',
  subjectRef: { type: 'module', moduleId },
  value: { path: '/orders', method: 'GET' },
});

describe('a Stage 1 producer publishes facts a projector can read', () => {
  it('carries a published fact from extraction to the fact view', async () => {
    const modules = [pending('cmd/main.go')];
    const result = await extract(producer('canary', [route(modules[0]!.moduleId)]), modules);

    expect(result.factRefusals).toEqual([]);
    expect(result.facts).toHaveLength(1);

    const snapshot = { repoRoot: REPO, timestamp: '', packages: [pkg], modules: [] } as unknown as RepositoryFactsSnapshot;
    const view = createFactView({ snapshot, facts: result.facts });
    const selected = view.select({ schema: 'canary/route@1' });
    expect(selected).toHaveLength(1);
    expect(selected[0]!.value).toEqual({ path: '/orders', method: 'GET' });
    // Selection is by schema alone: the record carries no producer to select on.
    expect(Object.keys(selected[0]!)).toEqual(['schema', 'subjectRef', 'value']);
  });

  it('refuses a fact published under another owner\'s schema, and names who tried', async () => {
    const modules = [pending('cmd/main.go')];
    const foreign: ReadonlyFactRecord = {
      schema: 'orbit/service@1',
      subjectRef: { type: 'module', moduleId: modules[0]!.moduleId },
      value: { name: 'checkout' },
    };
    const result = await extract(producer('canary', [foreign]), modules);

    expect(result.facts).toEqual([]);
    expect(result.factRefusals).toHaveLength(1);
    expect(result.factRefusals[0]).toContain('canary');
    expect(result.factRefusals[0]).toContain('orbit/service@1');
  });

  it('refuses a malformed fact alone and keeps the producer\'s honest ones', async () => {
    const modules = [pending('cmd/main.go')];
    const malformed = { schema: 'canary/route@1', subjectRef: { type: 'nowhere' }, value: 1 };
    const result = await extract(producer('canary', [malformed, route(modules[0]!.moduleId)]), modules);

    expect(result.facts).toHaveLength(1);
    expect(result.factRefusals).toHaveLength(1);
  });

  it('selects nothing for a schema nobody published', async () => {
    const modules = [pending('cmd/main.go')];
    const result = await extract(producer('canary', [route(modules[0]!.moduleId)]), modules);
    const snapshot = { repoRoot: REPO, timestamp: '', packages: [pkg], modules: [] } as unknown as RepositoryFactsSnapshot;
    const view = createFactView({ snapshot, facts: result.facts });
    expect(view.select({ schema: 'canary/absent@1' })).toEqual([]);
  });

  it('orders the view by content, not by the order the producer emitted', async () => {
    const modules = [pending('a.go'), pending('b.go')];
    const forward = await extract(producer('canary', [route(modules[0]!.moduleId), route(modules[1]!.moduleId)]), modules);
    const backward = await extract(producer('canary', [route(modules[1]!.moduleId), route(modules[0]!.moduleId)]), modules);
    const snapshot = { repoRoot: REPO, timestamp: '', packages: [pkg], modules: [] } as unknown as RepositoryFactsSnapshot;

    const read = (facts: readonly ReadonlyFactRecord[]): unknown[] =>
      [...createFactView({ snapshot, facts }).select({ schema: 'canary/route@1' })].map(r => r.subjectRef);

    expect(read(forward.facts)).toEqual(read(backward.facts));
  });
});
