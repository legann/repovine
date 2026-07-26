import type ts from 'typescript';
import type {
  SourceDiscoveryOptions,
  SourceDiscoveryResult,
  SourceExtractInput,
  SourceExtractResult,
} from '@repovine/plugin-sdk';
import { defineSourcePlugin, resolveDottedPathHandlerToModule } from '@repovine/plugin-sdk';
import type { PackageInfo, PendingModule, SemanticModuleDelta } from '@repovine/plugin-sdk';
import { discoverTypeScript } from './discover.js';
import { SFC_EXTENSIONS } from './sfc-extractor.js';
import { loadExtractModule } from './lazy-extract.js';

/**
 * Built-in source plugin: TypeScript / JavaScript (ts-morph inside extract chunk).
 *
 * This plugin owns all TS/JS-specific discovery (tsconfig walk, SFC extraction) and AST
 * extraction (ts-morph, lazy-loaded). The orchestrator routes through `discover()`/`extract()`
 * only — it never imports ts-morph or `typescript`.
 */

/** Source extensions this plugin owns. */
export const TYPESCRIPT_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** Opaque extractContext for this plugin: pre-parsed tsconfig compilerOptions per package name. */
export type TypeScriptExtractContext = Map<string, ts.CompilerOptions>;

function runTypeScriptExtract(
  input: SourceExtractInput,
  extractPackage: (typeof import('./extract.js'))['extractPackage'],
): SourceExtractResult {
  const { packages, pendingModules, prevByPath, absPathToId, repoRoot, sourceByModuleId } = input;
  const optionsByPkg =
    (input.extractContext as TypeScriptExtractContext | undefined) ?? new Map<string, ts.CompilerOptions>();

  const modulesByPackage = new Map<string, PendingModule[]>();
  for (const pm of pendingModules) {
    let list = modulesByPackage.get(pm.pkg.name);
    if (!list) {
      list = [];
      modulesByPackage.set(pm.pkg.name, list);
    }
    list.push(pm);
  }

  const pkgByName = new Map<string, PackageInfo>();
  for (const p of packages) if (!pkgByName.has(p.name)) pkgByName.set(p.name, p);

  const deltas: SemanticModuleDelta[] = [];
  let reused = 0;
  let rescanned = 0;
  for (const [pkgName, pkgModules] of modulesByPackage) {
    const compilerOptions = optionsByPkg.get(pkgName);
    if (!compilerOptions) continue;
    const pkg = pkgByName.get(pkgName) ?? pkgModules[0]!.pkg;
    const r = extractPackage({
      pkg,
      pkgModules,
      prevByPath,
      compilerOptions,
      absPathToId,
      packages,
      repoRoot,
      sourceByModuleId,
    });
    for (const d of r.deltas) deltas.push(d);
    reused += r.reused;
    rescanned += r.rescanned;
  }
  return { deltas, reused, rescanned };
}

const typescriptSourcePlugin = defineSourcePlugin({
  id: 'typescript',
  packageMarkers: ['tsconfig.json'],
  fileMatch: { extensions: TYPESCRIPT_SOURCE_EXTENSIONS },
  // Owns TS/JS extensions and produces frontend surfaces (file-based routes, SFC/UI components).
  // Same constant feeds fileMatch so the two lists cannot drift.
  capabilities: {
    // SFC extensions belong here, not in `fileMatch`: discovery reaches `.vue`/`.svelte` through
    // its own SFC walk, while core extension queries must still recognize them as owned.
    extensions: [...TYPESCRIPT_SOURCE_EXTENSIONS, ...SFC_EXTENSIONS],
    uiSurfaces: true,
    resolveHandlerToModule: resolveDottedPathHandlerToModule,
    // `.d.ts` is listed alongside the source extensions because the engine strips longest-first:
    // declaring it keeps `global.d.ts` from minting as `global.d`.
    moduleIdNormalize: {
      stripSuffixes: ['.d.ts', ...TYPESCRIPT_SOURCE_EXTENSIONS],
      indexBasenames: ['index'],
    },
  },

  discover(repoRoot: string, options: SourceDiscoveryOptions): SourceDiscoveryResult {
    return discoverTypeScript(repoRoot, options);
  },

  async extract(input: SourceExtractInput): Promise<SourceExtractResult> {
    const { extractPackage } = await loadExtractModule();
    return runTypeScriptExtract(input, extractPackage);
  },
});

/** TypeScript / JavaScript source plugin (built-in). */
export default typescriptSourcePlugin;
