import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AnnotationStore } from '../../../../src/annotations/store.js';
import { detectPropDrillingOrchestration } from '../../../../src/analysis/architecture/detectors.js';
import { createEmptyGraph } from '../../../../src/graph/index.js';
import type { ModuleInfo, UiComponentHint } from '../../../../src/types.js';

describe('prop-drilling tunnel depth', () => {
  it('memoizes shared diamond branches instead of enumerating every simple path', () => {
    const modulesById = new Map<string, ModuleInfo>();
    let componentReads = 0;
    const depth = 10;

    const nodeId = (layer: number, branch: number): string =>
      `mod:web/src/features/diamond/Layer${layer}${branch}`;
    const componentName = (layer: number, branch: number): string => `Layer${layer}${branch}`;

    for (let layer = 0; layer <= depth; layer++) {
      const branchCount = layer === 0 ? 1 : 2;
      for (let branch = 0; branch < branchCount; branch++) {
        const children = layer === depth
          ? []
          : [0, 1].map(childBranch => ({
            componentName: componentName(layer + 1, childBranch),
            passedProps: ['onSubmit'],
            passedCallbacks: ['onSubmit'],
            forwardedProps: ['onSubmit'],
            spreadProps: [],
          }));
        const component: UiComponentHint = {
          framework: 'react',
          name: componentName(layer, branch),
          props: [{ name: 'onSubmit', kind: 'callback', source: 'destructured-param' }],
          childComponents: children,
          localSignals: {
            localState: 0,
            effects: 0,
            dataAccess: 0,
            navigation: 0,
            timers: 0,
            subscriptions: 0,
            serviceImports: 0,
            validationOrMapping: 0,
          },
        };
        const ui = {
          framework: 'react' as const,
          get components(): UiComponentHint[] {
            componentReads++;
            if (componentReads > 300) {
              throw new Error('prop tunnel traversal revisited the shared diamond too many times');
            }
            return [component];
          },
        };
        const imports = layer === depth
          ? []
          : [0, 1].map(childBranch => ({
            moduleSpecifier: `./Layer${layer + 1}${childBranch}`,
            resolvedModuleId: nodeId(layer + 1, childBranch),
            importedNames: [componentName(layer + 1, childBranch)],
            isTypeOnly: false,
            isExternal: false,
          }));
        const id = nodeId(layer, branch);
        modulesById.set(id, {
          id,
          packageName: 'web',
          filePath: `/repo/src/features/diamond/Layer${layer}${branch}.tsx`,
          relativeFilePath: `src/features/diamond/Layer${layer}${branch}.tsx`,
          contentHash: `h-${layer}-${branch}`,
          imports,
          exports: [],
          semanticHints: { ui },
        });
      }
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-prop-depth-'));
    try {
      expect(() => detectPropDrillingOrchestration(
        createEmptyGraph(),
        modulesById,
        AnnotationStore.createSync(tmpDir),
        {
          moduleIds: new Set(modulesById.keys()),
          serviceIds: new Set(),
          domainIds: new Set(),
          scope: 'all',
          kind: 'all',
        },
      )).not.toThrow();
      expect(componentReads).toBeLessThan(300);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
