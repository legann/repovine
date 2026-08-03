import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
/**
 * Tests for inferModuleKind heuristic and recommendedFieldsForKind.
 */
import { inferModuleKind, recommendedFieldsForKind } from '../../../src/annotations/module-kind.js';
import { isFrontendSurfaceModule } from '../../../src/analysis/architecture/heuristics.js';
import type { ModuleInfo, GraphNode } from '../../../src/types.js';

function makeMod(partial: Partial<ModuleInfo>): ModuleInfo {
  return {
    id: partial.id ?? 'mod:test/foo',
    packageName: partial.packageName ?? 'test',
    absPath: asHostPath(partial.absPath ?? '/abs/test/foo.ts'),
    pkgRelPath: asPkgRelPath(partial.pkgRelPath ?? 'test/foo.ts'),
    contentHash: partial.contentHash ?? 'h1',
    imports: partial.imports ?? [],
    exports: partial.exports ?? [],
    semanticHints: partial.semanticHints,
    sourcePluginId: partial.sourcePluginId,
  };
}

describe('inferModuleKind', () => {
  it('returns types for module whose exports are all type/interface', () => {
    const mod = makeMod({
      exports: [
        { name: 'Foo', kind: 'type', lineRange: { start: 1, end: 3 }, isDefault: false },
        { name: 'Bar', kind: 'interface', lineRange: { start: 5, end: 9 }, isDefault: false },
      ],
    });
    expect(inferModuleKind({ mod })).toBe('types');
  });

  it('does NOT mark types when a function is also exported', () => {
    const mod = makeMod({
      exports: [
        { name: 'Foo', kind: 'type', lineRange: { start: 1, end: 3 }, isDefault: false },
        { name: 'doIt', kind: 'function', lineRange: { start: 5, end: 9 }, isDefault: false },
      ],
    });
    expect(inferModuleKind({ mod })).not.toBe('types');
  });

  it('returns ui for SFC file (.vue)', () => {
    const mod = makeMod({
      pkgRelPath: asPkgRelPath('apps/web/MyComponent.vue'),
      exports: [{ name: 'default', kind: 'component', lineRange: { start: 1, end: 50 }, isDefault: true }],
    });
    expect(inferModuleKind({ mod })).toBe('ui');
  });

  it('returns ui for tsx file under components/ path', () => {
    const mod = makeMod({
      pkgRelPath: asPkgRelPath('apps/web/src/components/Button.tsx'),
      exports: [{ name: 'Button', kind: 'component', lineRange: { start: 1, end: 30 }, isDefault: false }],
    });
    expect(inferModuleKind({ mod })).toBe('ui');
  });

  // Gate #1 (source-plugin capabilities): 'ui' is restricted to plugins that declare
  // uiSurfaces. These two share identical input except sourcePluginId, isolating the gate —
  // and exercise the registry-resolved path (the helper's undefined→true default is covered above),
  // which also asserts module-kind's source-plugin bootstrap import populated the registry.
  it('returns ui for a typescript-owned module under components/ (uiSurfaces:true)', () => {
    const mod = makeMod({
      pkgRelPath: asPkgRelPath('apps/web/src/components/Button.tsx'),
      sourcePluginId: 'typescript',
      exports: [{ name: 'Button', kind: 'component', lineRange: { start: 1, end: 30 }, isDefault: false }],
    });
    expect(inferModuleKind({ mod })).toBe('ui');
  });

  it('does NOT mark ui for a python-owned module under the same UI-ish path', () => {
    const mod = makeMod({
      pkgRelPath: asPkgRelPath('apps/web/src/components/Button.tsx'),
      sourcePluginId: 'python',
      exports: [{ name: 'Button', kind: 'component', lineRange: { start: 1, end: 30 }, isDefault: false }],
    });
    expect(inferModuleKind({ mod })).not.toBe('ui');
  });

  it('returns api-handler for path under handlers/', () => {
    const mod = makeMod({
      pkgRelPath: asPkgRelPath('services/api/src/handlers/createOrder.ts'),
      exports: [{ name: 'handler', kind: 'function', lineRange: { start: 1, end: 40 }, isDefault: false }],
    });
    expect(inferModuleKind({ mod })).toBe('api-handler');
  });

  it('returns adapter for path under repositories/', () => {
    const mod = makeMod({
      pkgRelPath: asPkgRelPath('packages/data/src/repositories/userRepository.ts'),
      exports: [{ name: 'UserRepository', kind: 'class', lineRange: { start: 1, end: 80 }, isDefault: false }],
    });
    expect(inferModuleKind({ mod })).toBe('adapter');
  });

  it('returns service-mgr for path under services/', () => {
    const mod = makeMod({
      pkgRelPath: asPkgRelPath('packages/billing/src/services/invoiceService.ts'),
      exports: [{ name: 'InvoiceService', kind: 'class', lineRange: { start: 1, end: 120 }, isDefault: false }],
    });
    expect(inferModuleKind({ mod })).toBe('service-mgr');
  });

  it('returns generic when nothing matches', () => {
    const mod = makeMod({
      pkgRelPath: asPkgRelPath('lib/utils/helpers.ts'),
      exports: [{ name: 'helper', kind: 'function', lineRange: { start: 1, end: 10 }, isDefault: false }],
    });
    expect(inferModuleKind({ mod })).toBe('generic');
  });

  it('returns domain for a domain graph node', () => {
    const node: GraphNode = { id: 'domain:auth', type: 'domain', label: 'auth', description: '' };
    expect(inferModuleKind({ node })).toBe('domain');
  });

  it('returns runtime-resource for a runtime-resource graph node', () => {
    const node: GraphNode = { id: 'resource:aws-lambda:Foo', type: 'runtime-resource', label: 'Foo', description: '' };
    expect(inferModuleKind({ node })).toBe('runtime-resource');
    // Guard the discriminator: a non-runtime-resource node id must not still yield
    // 'runtime-resource' — it is the node.type branch, not the id string, that decides.
    const domainNode: GraphNode = { id: 'domain:foo', type: 'domain', label: 'foo', description: '' };
    expect(inferModuleKind({ node: domainNode })).not.toBe('runtime-resource');
  });

  it('returns template for a template graph node', () => {
    const node: GraphNode = { id: 'template:app/templates/home.html', type: 'template', label: 'home.html', description: '' };
    expect(inferModuleKind({ node })).toBe('template');
  });

  it('returns infra for an infra module id', () => {
    const mod = makeMod({ id: 'infra:template.yaml', pkgRelPath: asPkgRelPath('template.yaml') });
    expect(inferModuleKind({ mod })).toBe('infra');
  });

  it('returns api-handler for @backend BFF with weak AI SDK frontend hints', () => {
    const mod = makeMod({
      packageName: '@backend',
      pkgRelPath: asPkgRelPath('src/routes/chat.ts'),
      exports: [{ name: 'POST', kind: 'function', lineRange: { start: 1, end: 80 }, isDefault: false }],
      semanticHints: {
        ui: { framework: 'react' },
        ssr: { useServer: true },
      },
    });
    expect(inferModuleKind({ mod })).toBe('api-handler');
    expect(isFrontendSurfaceModule(mod)).toBe(false);
  });

  it('does NOT classify weak frontend hints alone as ui', () => {
    const mod = makeMod({
      pkgRelPath: asPkgRelPath('src/lib/stream.ts'),
      semanticHints: { ui: { framework: 'react' } },
    });
    expect(inferModuleKind({ mod })).toBe('generic');
    expect(isFrontendSurfaceModule(mod)).toBe(false);
  });

  it('returns ui for @frontend module with use client on a component path', () => {
    const mod = makeMod({
      packageName: '@frontend',
      pkgRelPath: asPkgRelPath('src/components/Chat.tsx'),
      exports: [{ name: 'Chat', kind: 'component', lineRange: { start: 1, end: 40 }, isDefault: false }],
      semanticHints: {
        ssr: { useClient: true },
        ui: {
          framework: 'react',
          components: [{
            framework: 'react',
            name: 'Chat',
            props: [],
            childComponents: [],
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
            lineRange: { start: 1, end: 40 },
          }],
        },
      },
    });
    expect(inferModuleKind({ mod })).toBe('ui');
    expect(isFrontendSurfaceModule(mod)).toBe(true);
  });

  it('returns api-handler for backend routes path with api file routes', () => {
    const mod = makeMod({
      packageName: '@backend',
      pkgRelPath: asPkgRelPath('src/routes/chat.ts'),
      semanticHints: {
        hasRoutes: true,
        routes: [{ path: '/chat', component: '(file-route)', declaredIn: 'layout', kind: 'api' }],
      },
    });
    expect(inferModuleKind({ mod })).toBe('api-handler');
  });
});

describe('recommendedFieldsForKind', () => {
  it('types kind only requires summary + keyExports', () => {
    expect(recommendedFieldsForKind('types')).toEqual(['summary', 'keyExports']);
  });

  it('api-handler requires flow + sideEffects + risks', () => {
    const fields = recommendedFieldsForKind('api-handler');
    expect(fields).toContain('flowDescription');
    expect(fields).toContain('sideEffects');
    expect(fields).toContain('risks');
  });

  it('domain kind includes invariants and extensionPoints', () => {
    const fields = recommendedFieldsForKind('domain');
    expect(fields).toContain('invariants');
    expect(fields).toContain('extensionPoints');
  });

  it('template kind includes dataFlow and risks', () => {
    const fields = recommendedFieldsForKind('template');
    expect(fields).toContain('dataFlow');
    expect(fields).toContain('risks');
  });

  it('generic kind falls back to summary + keyExports + assumptions', () => {
    expect(recommendedFieldsForKind('generic')).toEqual(['summary', 'keyExports', 'assumptions']);
  });
});
