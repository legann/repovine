/**
 * Integration test — full pipeline on a basic TypeScript fixture project.
 * Runs Stage 1 (repository facts snapshot) → Stage 2 (repository graph) → graph queries + annotations.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { collectRepositoryFactsAsync, STAGE1_ANALYSIS_VERSION } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import { graphStats, buildNodeView, getImpact, getChildren } from '../../src/graph/index.js';
import { AnnotationStore } from '../../src/annotations/store.js';
import type { ModuleInfo } from '../../src/types.js';

function findFixtureSrc(): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'fixtures', 'basic-typescript'),
    path.resolve(process.cwd(), 'repovine', 'test', 'fixtures', 'basic-typescript'),
  ];
  const root = candidates.find(candidate => fs.existsSync(candidate));
  if (!root) throw new Error(`Could not find basic-typescript fixture. Tried: ${candidates.join(', ')}`);
  return root;
}

const FIXTURE_SRC = findFixtureSrc();

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

describe('integration: basic-typescript fixture', () => {
  let tmpRoot: string;
  let FIXTURE_ROOT: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-integration-'));
    FIXTURE_ROOT = path.join(tmpRoot, 'basic-typescript');
    copyDirSync(FIXTURE_SRC, FIXTURE_ROOT);
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('collectRepositoryFactsAsync finds package and modules', async () => {
    const snapshot = await collectRepositoryFactsAsync(FIXTURE_ROOT);
    expect(snapshot.analysisVersion).toBe(STAGE1_ANALYSIS_VERSION);
    expect(snapshot.packages.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.modules.length).toBeGreaterThanOrEqual(3);

    const moduleFiles = snapshot.modules.map(m => m.relativeFilePath);
    expect(moduleFiles.some(f => f.includes('utils'))).toBe(true);
    expect(moduleFiles.some(f => f.includes('service'))).toBe(true);
    expect(moduleFiles.some(f => f.includes('models'))).toBe(true);
  });

  it('builds an infra-only graph (infra modules, no source modules) when no tsconfig.json is present', async () => {
    const infraOnlyRoot = path.join(tmpRoot, 'infra-only');
    fs.mkdirSync(infraOnlyRoot, { recursive: true });
    fs.writeFileSync(path.join(infraOnlyRoot, 'main.tf'), 'resource "aws_s3_bucket" "bucket" {}\n');

    const snapshot = await collectRepositoryFactsAsync(infraOnlyRoot);

    // No source packages (no tsconfig/pyproject), but the IaC scan still runs and finds the
    // Terraform bucket — collectInfraModules is no longer gated on source packages.
    expect(snapshot.packages).toHaveLength(0);
    expect(snapshot.modules).toHaveLength(0);
    expect((snapshot.infraModules ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('does not reuse cached module facts from an older analysis version', async () => {
    const snapshot = await collectRepositoryFactsAsync(FIXTURE_ROOT);
    const staleSnapshot = {
      ...snapshot,
      analysisVersion: STAGE1_ANALYSIS_VERSION - 1,
      modules: snapshot.modules.map(m => ({
        ...m,
        imports: [],
        exports: [],
        semanticHints: { envVars: ['STALE_CACHE_SENTINEL'] },
      })),
    };

    const refreshed = await collectRepositoryFactsAsync(FIXTURE_ROOT, { previousSnapshot: staleSnapshot });
    expect(refreshed.modules.some(m => m.semanticHints?.envVars?.includes('STALE_CACHE_SENTINEL'))).toBe(false);
    expect(refreshed.modules.some(m => m.exports.length > 0)).toBe(true);
  });

  it('does not reuse cached module facts after extraction config changes', async () => {
    const configRoot = path.join(tmpRoot, 'config-reuse');
    copyDirSync(FIXTURE_SRC, configRoot);
    const snapshot = await collectRepositoryFactsAsync(configRoot);
    const poisoned = {
      ...snapshot,
      modules: snapshot.modules.map(module => ({
        ...module,
        semanticHints: { envVars: ['STALE_CONFIG_SENTINEL'] },
      })),
    };

    const unchanged = await collectRepositoryFactsAsync(configRoot, { previousSnapshot: poisoned });
    expect(unchanged.modules.some(module =>
      module.semanticHints?.envVars?.includes('STALE_CONFIG_SENTINEL'))).toBe(true);

    const tsconfigPath = path.join(configRoot, 'tsconfig.json');
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8')) as {
      compilerOptions: Record<string, unknown>;
    };
    tsconfig.compilerOptions.baseUrl = '.';
    tsconfig.compilerOptions.paths = { '@/*': ['src/*'] };
    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

    const refreshed = await collectRepositoryFactsAsync(configRoot, { previousSnapshot: poisoned });
    expect(refreshed.extractionConfigFingerprint).not.toBe(snapshot.extractionConfigFingerprint);
    expect(refreshed.modules.some(module =>
      module.semanticHints?.envVars?.includes('STALE_CONFIG_SENTINEL'))).toBe(false);
  });

  it('composeRepositoryGraph creates nodes and edges', async () => {
    const snapshot = await collectRepositoryFactsAsync(FIXTURE_ROOT);
    const modulesById = new Map<string, ModuleInfo>();
    for (const m of snapshot.modules) modulesById.set(m.id, m);

    const graph = composeRepositoryGraph(snapshot, modulesById);
    const stats = graphStats(graph);

    expect(stats.totalNodes).toBeGreaterThan(0);
    expect(stats.totalEdges).toBeGreaterThan(0);
    expect(stats.nodesByType['module']).toBeGreaterThanOrEqual(3);
    expect(stats.nodesByType['package']).toBeGreaterThanOrEqual(1);
  });

  it('buildNodeView works on module nodes', async () => {
    const snapshot = await collectRepositoryFactsAsync(FIXTURE_ROOT);
    const modulesById = new Map<string, ModuleInfo>();
    for (const m of snapshot.modules) modulesById.set(m.id, m);
    const graph = composeRepositoryGraph(snapshot, modulesById);

    const moduleNodes = Array.from(graph.nodes.values()).filter(n => n.type === 'module');
    expect(moduleNodes.length).toBeGreaterThan(0);

    const view = buildNodeView(graph, moduleNodes[0].id);
    expect(view).not.toBeNull();
    expect(view!.id).toBe(moduleNodes[0].id);
    expect(view!.label).toBeDefined();
  });

  it('getImpact returns dependency info for service module', async () => {
    const snapshot = await collectRepositoryFactsAsync(FIXTURE_ROOT);
    const modulesById = new Map<string, ModuleInfo>();
    for (const m of snapshot.modules) modulesById.set(m.id, m);
    const graph = composeRepositoryGraph(snapshot, modulesById);

    const utilsModule = snapshot.modules.find(m => m.relativeFilePath === 'src/utils.ts');
    const serviceModule = snapshot.modules.find(m => m.relativeFilePath === 'src/service.ts');
    expect(utilsModule).toBeDefined();
    expect(serviceModule).toBeDefined();

    // service.ts imports utils.ts, so utils should have service as a direct downstream consumer.
    const impact = getImpact(graph, utilsModule!.id, 'downstream', 1);
    expect(impact.downstream).toContain(serviceModule!.id);
  });

  it('root node has package children', async () => {
    const snapshot = await collectRepositoryFactsAsync(FIXTURE_ROOT);
    const modulesById = new Map<string, ModuleInfo>();
    for (const m of snapshot.modules) modulesById.set(m.id, m);
    const graph = composeRepositoryGraph(snapshot, modulesById);

    const rootNode = Array.from(graph.nodes.values()).find(n => n.type === 'root');
    expect(rootNode).toBeDefined();
    const children = getChildren(graph, rootNode!.id);
    expect(children.length).toBeGreaterThan(0);
    expect(children.some(c => c.type === 'package')).toBe(true);
  });

  it('AnnotationStore write/read/flush works at repo root', async () => {
    const store = await AnnotationStore.create(tmpRoot);
    store.set('mod:test/integration', {
      nodeId: 'mod:test/integration',
      nodeType: 'module',
      contentHash: 'int-hash',
      pass: 1,
      updatedAt: new Date().toISOString(),
      annotation: { summary: 'Integration test annotation' },
      schemaVersion: 2,
    });
    store.flush();

    const filePath = path.join(tmpRoot, 'repovine.annots.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const store2 = await AnnotationStore.create(tmpRoot);
    const loaded = store2.get('mod:test/integration');
    expect(loaded).toBeDefined();
    expect(loaded!.annotation.summary).toBe('Integration test annotation');
  });
});
