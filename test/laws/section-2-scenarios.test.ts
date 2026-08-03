import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { collectInfraModules } from '../../src/stage1/infra.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { collectEntrypoints } from '../../src/mcp/lib/entrypoints.js';
import { detectPython } from '../../packages/plugins/source-python/src/discover.js';
import { lawRuntime, repoRoot } from './graph-law-helpers.js';

/**
 * Law: the four acceptance scenarios are each answered by a fixture, and none of them is
 * answered by the engine.
 *
 * There are seven scenarios; the first four are acceptance criteria rather than
 * illustrations. Each row names where its code changes, and the claim under test is that column:
 * a plugin package, or a new plugin package, and never `src/**`.
 *
 * | Scenario | Fixture | Proved by |
 * |---|---|---|
 * | 1. existing IaC vertical supports a new case | `scenario-repos/sam-s3-event` | in-process here: the SAM `S3` event |
 * | 2. new IaC plugin with a new provider and kinds | `canary-plugins/orbit-iac` | `smoke:canary-plugins`, `smoke:isolated-install`; shape asserted here |
 * | 3. Python plugin learns a framework | `scenario-repos/python-aiohttp` | in-process here: aiohttp, both route forms |
 * | 4. Go source plugin emits normalized routes | `canary-plugins/go-source` | `smoke:canary-plugins`, `smoke:isolated-install`; shape asserted here |
 *
 * Rows 2 and 4 are bound rather than re-run. Their fixtures are whole external packages that
 * compile against the packed SDK and are driven end to end through MCP by two gates; a third
 * in-process copy would add a second implementation of the same claim, not a second piece of
 * evidence. What is asserted here is that the fixture still exists, still declares the thing the
 * row is about, and is still named by a gate that runs it.
 */

const SCENARIO_REPOS = path.join(repoRoot(), 'test', 'fixtures', 'scenario-repos');
const CANARY_PLUGINS = path.join(repoRoot(), 'test', 'fixtures', 'canary-plugins');

describe('core-laws row 1 — an existing IaC vertical supports a new case', () => {
  const fixture = path.join(SCENARIO_REPOS, 'sam-s3-event');

  it('carries a SAM template whose event type the vertical had no case for before', () => {
    const template = fs.readFileSync(path.join(fixture, 'template.yaml'), 'utf8');
    expect(template).toContain('Type: S3');
    expect(template).toContain('AWS::S3::Bucket');
  });

  it('parses the event with no refusal', () => {
    const { refusals } = collectInfraModules({ repoRoot: fixture });
    expect(refusals).toEqual([]);
  });

  it('turns the new event into a canonical entrypoint and a consumes edge, with no engine change', async () => {
    // The whole pipeline, not a hand-built snapshot: the declaration catalog travels on the
    // snapshot, so a snapshot assembled by hand carries no declarations and every declared effect
    // reads as absent — the trigger would surface as `unknown` and prove nothing.
    const snapshot = await collectRepositoryFactsAsync(fixture);
    const graph = composeRepositoryGraph(snapshot);

    // Both resources exist, and the bucket feeds the function. `consumes` is the generic relation
    // the engine draws for any stream-like trigger naming a resource — the S3 case reached it by
    // declaring `isStreamLike`, not by being recognised.
    const bucket = 'resource:aws-s3:Uploads';
    const fn = 'resource:aws-lambda:ThumbnailMaker';
    expect(graph.nodes.has(bucket)).toBe(true);
    expect(graph.nodes.has(fn)).toBe(true);
    expect((graph.outEdges.get(bucket) ?? []).filter(e => e.kind === 'consumes').map(e => e.to))
      .toEqual([fn]);

    // And the trigger is published as the entrypoint kind the plugin declared for it, not as the
    // `unknown` an undeclared trigger type would produce.
    const { items } = collectEntrypoints(lawRuntime(graph, snapshot), {});
    const consumer = items.find(item => item.kind === 'queue-consumer');
    expect(consumer).toBeDefined();
    expect(JSON.stringify(consumer)).toContain('ThumbnailMaker');
    expect(items.map(item => item.kind)).not.toContain('unknown');
  });

  it('keeps the new case inside the plugin package', () => {
    // The parse case and the declaration both live with the vertical that owns them.
    const parser = fs.readFileSync(
      path.join(repoRoot(), 'packages', 'plugins', 'iac-sam', 'src', 'parser.ts'),
      'utf8',
    );
    expect(parser).toContain("typeLower === 's3'");
    const manifest = JSON.parse(fs.readFileSync(
      path.join(repoRoot(), 'packages', 'plugins', 'iac-sam', 'package.json'),
      'utf8',
    )) as { repovine: { declarations: { triggerTypes: Array<{ type: string; entrypointKind?: string }> } } };
    const declared = manifest.repovine.declarations.triggerTypes.find(t => t.type === 's3');
    expect(declared).toEqual(expect.objectContaining({ entrypointKind: 'queue-consumer' }));
  });
});

describe('core-laws row 2 — a new IaC plugin brings a new provider and kinds', () => {
  const fixture = path.join(CANARY_PLUGINS, 'orbit-iac');

  it('is a whole external package declaring a provider and kind the engine never names', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      repovine?: {
        id?: string;
        declarations?: {
          resourceKinds?: Array<{ namespace?: string; provider?: string; kind?: string }>;
          triggerTypes?: Array<{ type?: string }>;
        };
      };
    };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@repovine/plugin-sdk']);
    expect(manifest.repovine?.declarations?.resourceKinds)
      .toEqual([expect.objectContaining({ provider: 'orbit', kind: 'service' })]);
    expect(manifest.repovine?.declarations?.triggerTypes)
      .toEqual([expect.objectContaining({ type: 'orbit-http' })]);
  });

  it('is run end to end by gates that name it', () => {
    for (const script of ['smoke-canary-plugins.mjs', 'smoke-isolated-install.mjs']) {
      const text = fs.readFileSync(path.join(repoRoot(), 'scripts', script), 'utf8');
      expect({ script, names: text.includes('orbit-iac') }).toEqual({ script, names: true });
    }
  });
});

const PYTHON_AVAILABLE = detectPython() !== null;
const describePython = PYTHON_AVAILABLE ? describe : describe.skip;

describePython('core-laws row 3 — the Python plugin learns a framework', () => {
  const fixture = path.join(SCENARIO_REPOS, 'python-aiohttp');

  it('reads both aiohttp route forms and labels the framework', async () => {
    const snapshot = await collectRepositoryFactsAsync(fixture);
    const server = snapshot.modules.find(mod => mod.id.endsWith('/app/server'));
    expect(server).toBeDefined();

    const hints = server!.semanticHints;
    expect(hints?.webFramework).toBe('aiohttp');
    expect(hints?.hasRoutes).toBe(true);

    // The decorator table and the imperative registrations inside `create_app()` both arrive, and
    // each row says how it was written rather than inheriting one answer from the framework.
    const byPath = new Map((hints?.routes ?? []).map(route => [`${route.method} ${route.path}`, route]));
    expect([...byPath.keys()].sort()).toEqual([
      'DELETE /orders/{order_id}',
      'GET /healthz',
      'GET /metrics',
      'POST /orders',
    ]);
    expect(byPath.get('GET /healthz')?.syntax).toBe('decorator');
    expect(byPath.get('POST /orders')?.syntax).toBe('decorator');
    expect(byPath.get('GET /metrics')?.syntax).toBe('call');
    expect(byPath.get('DELETE /orders/{order_id}')?.syntax).toBe('call');
    for (const route of hints?.routes ?? []) expect(route.declaredIn).toBe('code');
  });

  it('publishes those routes as canonical api entrypoints', async () => {
    const snapshot = await collectRepositoryFactsAsync(fixture);
    const graph = composeRepositoryGraph(snapshot);
    const { items } = collectEntrypoints(lawRuntime(graph, snapshot), {});

    const api = items.filter(item => item.kind === 'api');
    const paths = api.map(item => (item as { path?: string }).path).filter(Boolean).sort();
    expect(paths).toEqual(['/healthz', '/metrics', '/orders', '/orders/{order_id}']);
  });

  it('keeps the framework inside the Python package', () => {
    const script = fs.readFileSync(
      path.join(repoRoot(), 'packages', 'plugins', 'source-python', 'src', 'route-ast-script.py'),
      'utf8',
    );
    expect(script).toContain('aiohttp');
    const hints = fs.readFileSync(
      path.join(repoRoot(), 'packages', 'plugins', 'source-python', 'src', 'framework-hints.ts'),
      'utf8',
    );
    expect(hints).toContain('aiohttp');
  });
});

describe('core-laws row 4 — a Go source plugin emits normalized routes', () => {
  const fixture = path.join(CANARY_PLUGINS, 'go-source');

  it('is a whole external package that owns Go and publishes route facts', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      repovine?: { id?: string };
    };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@repovine/plugin-sdk']);
    expect(manifest.repovine?.id).toBe('go');

    const source = fs.readFileSync(path.join(fixture, 'src', 'index.ts'), 'utf8');
    expect(source).toContain('go/route@1');
  });

  it('is run end to end by gates that assert its routes reach get_entrypoints', () => {
    for (const script of ['smoke-canary-plugins.mjs', 'smoke-isolated-install.mjs']) {
      const text = fs.readFileSync(path.join(repoRoot(), 'scripts', script), 'utf8');
      expect({ script, names: text.includes('go-source') }).toEqual({ script, names: true });
      expect({ script, asserts: text.includes('get_entrypoints') }).toEqual({ script, asserts: true });
    }
  });
});

describe('core-laws the four scenarios are each bound to a fixture', () => {
  it('has a fixture on disk for every row, and none of them lives in the engine tree', () => {
    const fixtures = [
      path.join(SCENARIO_REPOS, 'sam-s3-event'),
      path.join(CANARY_PLUGINS, 'orbit-iac'),
      path.join(SCENARIO_REPOS, 'python-aiohttp'),
      path.join(CANARY_PLUGINS, 'go-source'),
    ];
    for (const fixture of fixtures) {
      expect({ fixture: path.relative(repoRoot(), fixture), exists: fs.existsSync(fixture) })
        .toEqual({ fixture: path.relative(repoRoot(), fixture), exists: true });
      const rel = path.relative(repoRoot(), fixture).split(path.sep).join('/');
      expect(rel.startsWith('test/fixtures/')).toBe(true);
    }
  });
});
