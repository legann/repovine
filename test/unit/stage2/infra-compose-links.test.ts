import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../../src/stage2/index.js';
import type { GraphEdge, ModuleInfo, RepositoryGraph } from '../../../src/types.js';

function hasEdge(graph: RepositoryGraph, from: string, to: string, kind: GraphEdge['kind']): boolean {
  const out = graph.outEdges.get(from) ?? [];
  return out.some(e => e.to === to && e.kind === kind);
}

describe('stage2 infra linking: docker-compose -> dockerfile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-compose-link-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates infra edges from compose services to dockerfile modules', async () => {
    // Minimal TS project so infra discovery is enabled.
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'tmp', version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['src/**/*.ts'],
    }, null, 2));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const ok = true;\n');

    // Dockerfiles that compose will reference.
    fs.mkdirSync(path.join(tmpDir, 'infrastructure', 'k8s-services', 'lmtify-worker'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'infrastructure', 'k8s-services', 'lmtify-operator'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'infrastructure', 'k8s-services', 'lmtify-worker', 'Dockerfile.dev'), 'FROM node:22-alpine\n');
    fs.writeFileSync(path.join(tmpDir, 'infrastructure', 'k8s-services', 'lmtify-operator', 'Dockerfile'), 'FROM node:22-alpine\n');

    fs.writeFileSync(path.join(tmpDir, 'docker-compose.repovine-test.yml'), `
services:
  lmtify-worker:
    build:
      context: ./infrastructure/k8s-services/lmtify-worker
      dockerfile: Dockerfile.dev
  lmtify-operator:
    build:
      context: ./infrastructure/k8s-services/lmtify-operator
      dockerfile: Dockerfile
`);

    const snapshot = await collectRepositoryFactsAsync(tmpDir);
    expect(snapshot.infraModules?.some(m => m.kind === 'docker-compose')).toBe(true);
    expect(snapshot.infraModules?.some(m => m.kind === 'dockerfile')).toBe(true);

    const modulesById = new Map<string, ModuleInfo>();
    for (const m of snapshot.modules) modulesById.set(m.id, m);
    const graph = composeRepositoryGraph(snapshot, modulesById);

    expect(graph.nodes.has('resource:generic:lmtify-worker')).toBe(true);
    expect(graph.nodes.has('resource:generic:lmtify-operator')).toBe(true);
    expect(graph.nodes.has('infra:dockerfile:infrastructure/k8s-services/lmtify-worker/Dockerfile.dev')).toBe(true);
    expect(graph.nodes.has('infra:dockerfile:infrastructure/k8s-services/lmtify-operator/Dockerfile')).toBe(true);

    expect(
      hasEdge(
        graph,
        'resource:generic:lmtify-worker',
        'infra:dockerfile:infrastructure/k8s-services/lmtify-worker/Dockerfile.dev',
        'infra',
      ),
    ).toBe(true);

    expect(
      hasEdge(
        graph,
        'resource:generic:lmtify-operator',
        'infra:dockerfile:infrastructure/k8s-services/lmtify-operator/Dockerfile',
        'infra',
      ),
    ).toBe(true);

    expect(graph.nodes.has('domain:infra-docker-compose')).toBe(true);
  });

  it('does not register infra domains for kinds absent from the repo', async () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'tmp', version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['src/**/*.ts'],
    }, null, 2));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const ok = true;\n');

    fs.mkdirSync(path.join(tmpDir, 'infrastructure', 'k8s-services', 'app'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'infrastructure', 'k8s-services', 'app', 'Dockerfile'), 'FROM node:22-alpine\n');

    const snapshot = await collectRepositoryFactsAsync(tmpDir);
    const modulesById = new Map<string, ModuleInfo>();
    for (const m of snapshot.modules) modulesById.set(m.id, m);
    const graph = composeRepositoryGraph(snapshot, modulesById);

    expect(snapshot.infraModules?.some(m => m.kind === 'dockerfile')).toBe(true);
    expect(snapshot.infraModules?.some(m => m.kind === 'docker-compose')).toBe(false);

    expect(graph.nodes.has('domain:infra-dockerfile')).toBe(true);
    expect(graph.nodes.has('domain:infra-docker-compose')).toBe(false);
    expect(graph.nodes.has('domain:infra-terraform')).toBe(false);
    expect(graph.nodes.has('domain:infra-vercel')).toBe(false);
  });
});

