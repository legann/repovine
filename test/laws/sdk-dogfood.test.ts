import { asHostPath } from '@repovine/plugin-sdk';
import { asPkgRelPath } from '@repovine/plugin-sdk';
import { asRepoRelPath } from '@repovine/plugin-sdk';
import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runSourceExtraction } from '../../src/stage1/extract-runner.js';
import {
  defineSourcePlugin,
  validateSemanticHints,
  PLUGIN_API_VERSION,
} from '@repovine/plugin-sdk';
import type {
  PackageInfo,
  PendingModule,
  SourceExtractInput,
  SourceExtractResult,
} from '@repovine/plugin-sdk';

// A plugin authored ONLY against the public
// `@repovine/plugin-sdk` package — exactly how a third-party would write one — emits facts through the engine
// boundary, and a schema change that later PROJECTS a new slot needs zero plugin edit. This is the
// schema-evolution-resilience guarantee that lets the SDK boundary sit at the fact layer.
describe('core-laws plugin-sdk dogfood (author against the facade only)', () => {
  // A minimal source plugin written through the facade. It emits a forward-compatible semanticHints
  // slot (`futureSlot`) the engine/interpreters do not know yet — standing in for a future schema
  // growth (e.g. the Python-SSR `rendersTemplate` that moved EdgeKind 10→13 additively).
  const FUTURE_SLOT = { futureSlot: { kind: 'speculative', value: 42 } };

  const thirdPartyStylePlugin = defineSourcePlugin({
    id: 'dogfood-lang',
    fileMatch: { extensions: ['.dog'] },
    capabilities: { extensions: ['.dog'] },
    discover() {
      return { packages: [], pendingByAbsPath: new Map() };
    },
    extract(input: SourceExtractInput): SourceExtractResult {
      // Producer emits ONLY semantics, keyed back to the engine-minted pending id. It never
      // sets id/filePath/contentHash — those are not even on the return type.
      const deltas = input.pendingModules.map(pm => ({
        moduleId: pm.moduleId,
        imports: [],
        exports: [],
        semanticHints: { webFramework: 'dogframework', ...FUTURE_SLOT },
      }));
      return { deltas, reused: 0, rescanned: deltas.length };
    },
  });

  it('the facade stamps the contract apiVersion on a define*-authored plugin', () => {
    expect(thirdPartyStylePlugin.apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it('a facade-authored producer emits facts through the engine boundary; the engine stamps mechanics', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-dogfood-'));
    try {
      const filePath = path.join(tmpRoot, 'svc.dog');
      fs.writeFileSync(filePath, 'unit dogfood\n');
      const pkg: PackageInfo = { name: 'dog-pkg', repoRelDir: asRepoRelPath(tmpRoot), sourcePluginId: 'dogfood-lang' };
      const pending: PendingModule = {
        absPath: asHostPath(filePath),
        pkgRelPath: asPkgRelPath('svc.dog'),
        pkg,
        moduleId: 'mod:dog-pkg/svc',
        sourcePluginId: 'dogfood-lang',
      };

      const result = await runSourceExtraction({
        plugin: thirdPartyStylePlugin,
        repoRoot: asHostPath(tmpRoot),
        packages: [pkg],
        pendingModules: [pending],
        prevByAbsPath: new Map(),
        absPathToId: new Map([[asHostPath(filePath), pending.moduleId]]),
        extractContext: undefined,
        analysisVersion: 0,
      });

      expect(result.modules).toHaveLength(1);
      const mod = result.modules[0]!;
      // Engine stamped mechanics the producer never touched.
      expect(mod.id).toBe('mod:dog-pkg/svc');
      expect(mod.contentHash).toMatch(/^[0-9a-f]{16}$/);
      expect(mod.sourcePluginId).toBe('dogfood-lang');
      // The producer's semantic fact survives intact, including the forward slot core does not know.
      expect(mod.semanticHints?.webFramework).toBe('dogframework');
      expect((mod.semanticHints as Record<string, unknown>).futureSlot).toEqual(FUTURE_SLOT.futureSlot);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('the forward-compatible fact validates against the SDK schema (passthrough), so a future schema change needs no plugin edit', () => {
    const result = validateSemanticHints({ webFramework: 'dogframework', ...FUTURE_SLOT });
    expect(result.ok).toBe(true);
    // The unknown slot is preserved, not dropped — an interpreter could read it before core types it.
    expect(result.ok && (result.value as Record<string, unknown>).futureSlot).toEqual(FUTURE_SLOT.futureSlot);
  });
});
