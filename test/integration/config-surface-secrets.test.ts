/**
 * Integration: get_config_surface(kind:'secret') must list every secret a fixture declares as a
 * service link — both module-bound consumers (SAM/Terraform Lambdas via the handler module's
 * binds_to) and handler-less consumers (k8s workloads, docker-compose services, Vercel project,
 * Helm images) that only carry a resource→resource uses_env edge.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { collectConfigSurface } from '../../src/mcp/lib/config-surface.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';

function findFixturesRoot(): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'fixtures'),
    path.resolve(process.cwd(), 'repovine', 'test', 'fixtures'),
  ];
  const root = candidates.find(candidate => fs.existsSync(candidate));
  if (!root) throw new Error(`Could not find test fixtures root. Tried: ${candidates.join(', ')}`);
  return root;
}

const FIXTURES_ROOT = findFixturesRoot();

interface ExpectedFixture {
  serviceLinks?: Array<{ toServiceLabel: string; toServiceKind?: string }>;
}

function secretFixtures(): Array<{ name: string; secrets: string[] }> {
  return fs
    .readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .flatMap(name => {
      const expectedPath = path.join(FIXTURES_ROOT, name, 'expected.json');
      if (!fs.existsSync(expectedPath)) return [];
      const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf-8')) as ExpectedFixture;
      const secrets = [...new Set(
        (expected.serviceLinks ?? [])
          .filter(l => l.toServiceKind === 'secret')
          .map(l => l.toServiceLabel),
      )];
      return secrets.length > 0 ? [{ name, secrets }] : [];
    });
}

describe('config-surface secrets — fixture suite', () => {
  const fixtures = secretFixtures();
  if (fixtures.length === 0) {
    it('has at least one fixture declaring a secret service link', () => {
      throw new Error('No fixtures with secret serviceLinks in expected.json');
    });
    return;
  }

  describe.each(fixtures)('%s', ({ name, secrets }) => {
    it(`get_config_surface(kind:'secret') lists: ${secrets.join(', ')}`, async () => {
      const origLog = console.log;
      console.log = () => {};
      let surfaceNames: string[];
      let secretTaggedFromAll: string[];
      try {
        const snapshot = await collectRepositoryFactsAsync(path.join(FIXTURES_ROOT, name));
        const graph = composeRepositoryGraph(snapshot);
        const ctx = {
          getState: () => ({ graph, snapshot, modulesById: new Map(), domainsConfig: null }),
        } as unknown as McpToolRuntime;
        const surface = collectConfigSurface(ctx, { scope: 'all', kind: 'secret', limit: 500 });
        surfaceNames = surface.items.map(item => String(item.name));
        // Over-report guard: query the FULL surface (env + resource-binding + secret) and keep only
        // the secret-tagged items. The secret classification must not widen onto ordinary env or
        // resource bindings, so every secret-tagged name must be a declared secret.
        const allSurface = collectConfigSurface(ctx, { scope: 'all', kind: 'all', limit: 500 });
        secretTaggedFromAll = allSurface.items
          .filter(item => item.kind === 'secret')
          .map(item => String(item.name));
      } finally {
        console.log = origLog;
      }
      // Under-report (containment): every declared secret is surfaced.
      for (const secret of secrets) {
        expect(surfaceNames).toContain(secret);
      }
      // Over-report: no non-secret binding is tagged kind:'secret'. The secret-tagged set from the
      // full surface equals exactly the declared secrets — no ordinary env/resource binding leaks in.
      expect(new Set(secretTaggedFromAll)).toEqual(new Set(secrets));
    });
  });
});
