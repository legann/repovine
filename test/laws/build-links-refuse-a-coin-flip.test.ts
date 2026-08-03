import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import type { RepositoryGraph } from '../../src/types.js';

/**
 * Law: matching a container image to a Dockerfile answers or declines. It never breaks a tie.
 *
 * The `build-links` projector scores every Dockerfile in the repository against an image reference
 * and links the winner. One of the score's terms did not depend on the candidate: whether the
 * RESOURCE's own name carries the image name. That term is evidence the image was built here rather
 * than pulled from a registry, and it is worth having — but it is the same number for every
 * candidate, so with no path signal anywhere every Dockerfile tied, and "the winner" was whichever
 * sorted first by minted id.
 *
 * Found by measuring the projector against a repository outside this one, which is the only place it
 * had ever seen more than one candidate: every in-repo fixture holds exactly one Dockerfile, so the
 * ranking was never exercised. On that repository, three Dockerfiles and an upstream
 * `amazon/cloudwatch-agent` image produced one false edge out of six.
 *
 * The shape below is that repository's, reduced: two sibling service directories under one
 * infrastructure tree, and a workload running an image built by neither. The two positive controls
 * are what keeps the fix from being "draw fewer edges" — a distinguishing path still wins, and a
 * repository with one Dockerfile still answers.
 */

const BUILDS_FROM_KIND = 'infra';

/** Every Dockerfile module a resource is linked to. */
function dockerfilesLinkedFrom(graph: RepositoryGraph, resourceId: string): string[] {
  return (graph.outEdges.get(resourceId) ?? [])
    .filter(edge => edge.kind === BUILDS_FROM_KIND && edge.to.startsWith('infra:dockerfile:'))
    .map(edge => edge.to)
    .sort();
}

describe('core-laws an image resolves to one Dockerfile or to none', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-build-links-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A minimal TypeScript project, because infra discovery runs inside a real repository. */
  function writeProjectShell(): void {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'tmp', version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
      include: ['src/**/*.ts'],
    }, null, 2));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const ok = true;\n');
  }

  function writeDockerfile(relDir: string, name = 'Dockerfile'): void {
    fs.mkdirSync(path.join(tmpDir, relDir), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, relDir, name), 'FROM node:22-alpine\n');
  }

  /** One Deployment, named, running one image. */
  function writeWorkload(fileName: string, workloadName: string, image: string): void {
    fs.mkdirSync(path.join(tmpDir, 'manifests'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'manifests', fileName), [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      `  name: ${workloadName}`,
      '  namespace: demo-system',
      'spec:',
      '  template:',
      '    spec:',
      '      containers:',
      `        - name: ${workloadName}`,
      `          image: ${image}`,
      '',
    ].join('\n'));
  }

  async function buildGraph(): Promise<RepositoryGraph> {
    const snapshot = await collectRepositoryFactsAsync(tmpDir);
    return composeRepositoryGraph(snapshot);
  }

  it('draws nothing when an upstream image matches no Dockerfile and several are candidates', async () => {
    writeProjectShell();
    writeDockerfile(path.join('infrastructure', 'k8s-services', 'lmtify-operator'));
    writeDockerfile(path.join('infrastructure', 'k8s-services', 'lmtify-worker'));
    // The image is pulled, not built: `amazon/cloudwatch-agent` names neither directory. The
    // workload IS called `cloudwatch-agent`, which is what used to carry the score.
    writeWorkload('agent.yaml', 'cloudwatch-agent', 'amazon/cloudwatch-agent:latest');

    const graph = await buildGraph();
    const resourceId = 'resource:k8s:demo-system/Deployment/cloudwatch-agent';
    // The fixture is asserted to have built what the claim is about: both Dockerfiles present, and
    // the workload a node. Without this the empty result below would also pass on an empty graph.
    expect(graph.nodes.has('infra:dockerfile:infrastructure/k8s-services/lmtify-operator/Dockerfile')).toBe(true);
    expect(graph.nodes.has('infra:dockerfile:infrastructure/k8s-services/lmtify-worker/Dockerfile')).toBe(true);
    expect(graph.nodes.has(resourceId)).toBe(true);

    expect(dockerfilesLinkedFrom(graph, resourceId)).toEqual([]);
  });

  it('still names the one Dockerfile whose path the image matches (positive control)', async () => {
    writeProjectShell();
    writeDockerfile(path.join('infrastructure', 'k8s-services', 'lmtify-operator'));
    writeDockerfile(path.join('infrastructure', 'k8s-services', 'lmtify-worker'));
    writeWorkload('worker.yaml', 'lmtify-worker', 'registry.example.com/acme/lmtify-worker:1.2');

    const graph = await buildGraph();
    const resourceId = 'resource:k8s:demo-system/Deployment/lmtify-worker';
    expect(graph.nodes.has(resourceId)).toBe(true);
    // Exactly one, and the right one: a rule that answered "both" would be no better than the tie
    // it replaced.
    expect(dockerfilesLinkedFrom(graph, resourceId))
      .toEqual(['infra:dockerfile:infrastructure/k8s-services/lmtify-worker/Dockerfile']);
  });

  it('still answers when the repository holds one Dockerfile and no path signal (positive control)', async () => {
    // The shape every in-repo fixture has, and the reason the naive fix — dropping the resource-name
    // term outright — turned three golden graphs red. One candidate leaves nothing to choose between,
    // so the resource naming the image is enough.
    writeProjectShell();
    writeDockerfile('.');
    writeWorkload('operator.yaml', 'demo-operator', 'demo/operator:local');

    const graph = await buildGraph();
    const resourceId = 'resource:k8s:demo-system/Deployment/demo-operator';
    expect(graph.nodes.has(resourceId)).toBe(true);
    expect(dockerfilesLinkedFrom(graph, resourceId)).toEqual(['infra:dockerfile:Dockerfile']);
  });

  it('draws nothing when one Dockerfile has no path signal and the resource does not name the image', async () => {
    // The other half of the sole-candidate rule: one candidate is not a licence to link. Without the
    // resource naming the image there is no evidence the image was built in this repository at all.
    writeProjectShell();
    writeDockerfile('.');
    writeWorkload('cache.yaml', 'cache', 'redis:7-alpine');

    const graph = await buildGraph();
    const resourceId = 'resource:k8s:demo-system/Deployment/cache';
    expect(graph.nodes.has('infra:dockerfile:Dockerfile')).toBe(true);
    expect(graph.nodes.has(resourceId)).toBe(true);
    expect(dockerfilesLinkedFrom(graph, resourceId)).toEqual([]);
  });

  it('separates a directory\'s default recipe from its named variant (positive control)', async () => {
    // Two files in ONE directory offer identical path tokens, so the token score cannot rank them.
    // Refusing here would be over-correction: the image names the directory, and the directory has a
    // default. The basename is the separation, and it is still a fact about the path.
    writeProjectShell();
    writeDockerfile(path.join('infrastructure', 'k8s-services', 'lmtify-worker'));
    writeDockerfile(path.join('infrastructure', 'k8s-services', 'lmtify-worker'), 'Dockerfile.dev');
    writeWorkload('worker.yaml', 'lmtify-worker', 'registry.example.com/acme/lmtify-worker:1.2');

    const graph = await buildGraph();
    const resourceId = 'resource:k8s:demo-system/Deployment/lmtify-worker';
    expect(graph.nodes.has('infra:dockerfile:infrastructure/k8s-services/lmtify-worker/Dockerfile.dev')).toBe(true);
    expect(dockerfilesLinkedFrom(graph, resourceId))
      .toEqual(['infra:dockerfile:infrastructure/k8s-services/lmtify-worker/Dockerfile']);
  });

  it('lets a declared build path through even where a name match would be refused', async () => {
    // A compose file that NAMES its Dockerfile is not a guess, so ambiguity between candidates never
    // arises for it. Guarded because the fix touched only the guessing half, and the two halves share
    // one projector.
    writeProjectShell();
    writeDockerfile(path.join('infrastructure', 'k8s-services', 'lmtify-operator'));
    writeDockerfile(path.join('infrastructure', 'k8s-services', 'lmtify-worker'));
    fs.writeFileSync(path.join(tmpDir, 'docker-compose.yml'), [
      'services:',
      '  agent:',
      '    build:',
      '      context: infrastructure/k8s-services/lmtify-worker',
      '      dockerfile: Dockerfile',
      '',
    ].join('\n'));

    const graph = await buildGraph();
    const composeResource = [...graph.nodes.keys()].find(id => id.startsWith('resource:') && id.includes('agent'));
    expect({ found: composeResource !== undefined }).toEqual({ found: true });
    expect(dockerfilesLinkedFrom(graph, composeResource!))
      .toEqual(['infra:dockerfile:infrastructure/k8s-services/lmtify-worker/Dockerfile']);
  });
});
