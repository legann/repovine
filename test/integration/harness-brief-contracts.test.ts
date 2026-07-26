import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { AnnotationContentSchema } from '../../src/annotations/store.js';
import { carrierReviewFilePath } from '../../src/annotations/carrier-review.js';
import { getManifest } from '../../src/agents/manifests.js';
import { renderImplementerBrief } from '../../src/cli/agent-projection.js';
import { REPOVINE_GITIGNORE_ENTRY } from '../../src/cli/repovine-gitignore.js';
import { onboardingStateFilePath } from '../../src/mcp/onboarding-state.js';
import { toolDefs } from '../../src/mcp/tool-defs.js';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import type { RepositoryFactsSnapshot, RepositoryGraph } from '../../src/types.js';

function relativeModulePaths(root: string, snapshot: RepositoryFactsSnapshot): string[] {
  return snapshot.modules
    .map(module => path.relative(root, module.filePath).split(path.sep).join('/'))
    .sort();
}

describe('harness brief behavioral contracts', () => {
  let repoRoot: string;
  let snapshot: RepositoryFactsSnapshot;
  let graph: RepositoryGraph;

  const brief = renderImplementerBrief(getManifest('project-subagent-sample')!);

  beforeAll(async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-harness-brief-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['src/**/*.ts', 'tests/**/*.ts'],
    }));
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const app = true;\n');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.test.ts'), 'export const testOnly = true;\n');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.spec.ts'), 'export const specOnly = true;\n');
    fs.writeFileSync(path.join(repoRoot, 'tests', 'helper.ts'), 'export const helper = true;\n');

    snapshot = await collectRepositoryFactsAsync(repoRoot);
    graph = composeRepositoryGraph(
      snapshot,
      new Map(snapshot.modules.map(module => [module.id, module])),
    );
  });

  afterAll(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('states the plugin-specific default test filtering that the real graph exhibits', () => {
    const modulePaths = relativeModulePaths(repoRoot, snapshot);
    expect(modulePaths).toContain('src/app.ts');
    expect(modulePaths).not.toContain('src/app.test.ts');
    expect(modulePaths).not.toContain('src/app.spec.ts');
    expect(modulePaths).not.toContain('tests/helper.ts');
    expect(brief).toContain('filtering is plugin-specific');
    expect(brief).not.toContain('The graph excludes test and spec sources');
  });

  it('does not equate package identity with the presence of package.json', () => {
    expect(fs.existsSync(path.join(repoRoot, 'package.json'))).toBe(false);
    const rootPackage = snapshot.packages.find(pkg => pkg.path === '.');
    expect(rootPackage).toBeDefined();
    expect(graph.nodes.has(`pkg:${rootPackage!.name}`)).toBe(true);
    expect(brief).toContain('a workspace root with tsconfig.json or pyproject.toml may have a pkg: node');
    expect(brief).not.toContain('a workspace root that is not a package has no pkg: node');
  });

  it('matches the live annotation schema for an empty sideEffects array', () => {
    expect(AnnotationContentSchema.safeParse({
      summary: 'No effects declared.',
      sideEffects: [],
    }).success).toBe(false);
    expect(brief).toContain('never an empty array');
  });

  it('anchors both decline stores under the ignored workspace-local cache', () => {
    const declineTool = toolDefs.find(tool => tool.name === 'decline_advisory');
    expect(declineTool?.description).toContain('workspace-local');
    expect(REPOVINE_GITIGNORE_ENTRY).toBe('.repovine/');
    // These are host-shaped absolute paths, so the comparison normalizes separators the same way
    // `relativeModulePaths` above does. Comparing a raw `path.relative` against a POSIX literal
    // passes on Linux and fails on Windows.
    const relativeToRepo = (p: string): string => path.relative(repoRoot, p).split(path.sep).join('/');
    expect(relativeToRepo(onboardingStateFilePath(repoRoot))).toBe('.repovine/onboarding-state.json');
    expect(relativeToRepo(carrierReviewFilePath(repoRoot))).toBe('.repovine/carrier-review.json');
  });
});
