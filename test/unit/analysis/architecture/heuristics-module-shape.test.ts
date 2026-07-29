import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
/**
 * Tests for shared module-shape heuristics used by inferModuleKind and detectors.
 */
import {
  hasHttpHandlerSignals,
  isBackendContext,
  isBackendPackageName,
  isFrontendPackageName,
  isFrontendSurfaceModule,
} from '../../../../src/analysis/architecture/heuristics.js';
import type { ModuleInfo } from '../../../../src/types.js';

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
  };
}

describe('package role helpers', () => {
  it('recognizes backend package names', () => {
    expect(isBackendPackageName('@backend')).toBe(true);
    expect(isBackendPackageName('backend')).toBe(true);
    expect(isBackendPackageName('@org/api-server')).toBe(true);
    expect(isFrontendPackageName('@frontend')).toBe(true);
    expect(isFrontendPackageName('client-ui')).toBe(true);
  });
});

describe('isBackendContext', () => {
  it('is true for @backend package or server paths', () => {
    expect(isBackendContext(makeMod({ packageName: '@backend', pkgRelPath: asPkgRelPath('src/routes/chat.ts') }))).toBe(true);
    expect(isBackendContext(makeMod({ pkgRelPath: asPkgRelPath('src/server/chat.ts') }))).toBe(true);
    expect(isBackendContext(makeMod({
      pkgRelPath: asPkgRelPath('src/chat.ts'),
      semanticHints: { ssr: { useServer: true } },
    }))).toBe(true);
  });
});

describe('hasHttpHandlerSignals', () => {
  it('detects handler paths, api file routes, and runtime actions', () => {
    expect(hasHttpHandlerSignals(makeMod({ pkgRelPath: asPkgRelPath('src/handlers/chat.ts') }))).toBe(true);
    expect(hasHttpHandlerSignals(makeMod({
      pkgRelPath: asPkgRelPath('src/chat.ts'),
      semanticHints: {
        routes: [{ path: '/chat', component: '(file-route)', declaredIn: 'layout', kind: 'api' }],
      },
    }))).toBe(true);
    expect(hasHttpHandlerSignals(makeMod({
      pkgRelPath: asPkgRelPath('src/worker.ts'),
      semanticHints: {
        runtimeActions: [{ action: 'sqs.sendMessage', envVar: 'QUEUE_URL' }],
      },
    }))).toBe(true);
  });
});

describe('isFrontendSurfaceModule', () => {
  it('returns false for @backend modules without use client', () => {
    const mod = makeMod({
      packageName: '@backend',
      pkgRelPath: asPkgRelPath('src/routes/chat.tsx'),
      semanticHints: { ui: { framework: 'react' } },
    });
    expect(isFrontendSurfaceModule(mod)).toBe(false);
  });

  it('returns true for @backend modules with use client', () => {
    const mod = makeMod({
      packageName: '@backend',
      pkgRelPath: asPkgRelPath('src/routes/chat.tsx'),
      semanticHints: { ssr: { useClient: true } },
    });
    expect(isFrontendSurfaceModule(mod)).toBe(true);
  });

  it('returns true for @frontend component paths', () => {
    const mod = makeMod({
      packageName: '@frontend',
      pkgRelPath: asPkgRelPath('src/components/Chat.tsx'),
      exports: [{ name: 'Chat', kind: 'component', lineRange: { start: 1, end: 20 }, isDefault: false }],
    });
    expect(isFrontendSurfaceModule(mod)).toBe(true);
  });
});
