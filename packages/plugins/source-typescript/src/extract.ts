import { Project, type ResolutionHostFactory, type SourceFile } from 'ts-morph';
import ts from 'typescript';
import type { HostPath, ModuleInfo, PackageInfo, PendingModule, SemanticModuleDelta } from '@repovine/plugin-sdk';
import type { SourceFileText } from '@repovine/plugin-sdk';
import { collectImports, collectReExports } from './imports.js';
import { isNodeModulesPath, resolveSpecifierFromMap, type PathsContext } from './resolve-specifier.js';
import { collectExports } from './exports.js';
import { collectSemanticHints } from './semantic-hints.js';
import { extractTypeScriptFromSfc } from './sfc-extractor.js';

export interface ExtractPackageInput {
  pkg: PackageInfo;
  pkgModules: PendingModule[];
  /** Previous-snapshot modules for this package, keyed by absolute host path. May be empty. */
  prevByAbsPath: Map<HostPath, ModuleInfo>;
  /** Pre-parsed tsconfig compiler options for this package. */
  compilerOptions: ts.CompilerOptions;
  /** Frozen abs-path → moduleId map covering all packages (read-only). */
  absPathToId: Map<HostPath, string>;
  /** All packages in the workspace (for cross-package import resolution). */
  packages: PackageInfo[];
  /** Repo root, used to resolve workspace package paths in string-based resolution. */
  repoRoot: HostPath;
  /** Engine-provided raw content + content hash per pending module, keyed by moduleId. The engine
   * owns file IO and hashing; this plugin never reads source files or fingerprints them. */
  sourceByModuleId: Map<string, SourceFileText>;
}

export interface ExtractPackageResult {
  pkgName: string;
  /** Language semantics per module, keyed by moduleId. The engine assembles the full ModuleInfo. */
  deltas: SemanticModuleDelta[];
  reused: number;
  rescanned: number;
}

interface ModuleContent {
  /** Text fed to ts-morph: for plain modules = raw file content; for SFCs = extracted TS slice. */
  text: string;
  /** Engine-computed fingerprint of the RAW file (raw .vue/.svelte for SFCs), used for reuse. */
  hash: string;
}

function excludeNodeModulesResolution<T extends { resolvedFileName?: string }>(resolved: T | undefined): T | undefined {
  return resolved?.resolvedFileName && isNodeModulesPath(resolved.resolvedFileName) ? undefined : resolved;
}

/**
 * `getExportedDeclarations()` asks the TypeChecker to resolve every import in the source file.
 * Returning third-party resolutions lets the compiler reopen installed dependency trees even
 * though they can never become graph modules. Keep local/workspace resolution intact while
 * treating every `node_modules` result as external and unresolved.
 */
const nodeModulesBlockingResolutionHost: ResolutionHostFactory =
  (moduleResolutionHost, getCompilerOptions) => ({
    resolveModuleNames(moduleNames, containingFile, _reusedNames, redirectedReference, options) {
      const compilerOptions = options ?? getCompilerOptions();
      return moduleNames.map(moduleName => excludeNodeModulesResolution(
        ts.resolveModuleName(
          moduleName,
          containingFile,
          compilerOptions,
          moduleResolutionHost,
          undefined,
          redirectedReference,
        ).resolvedModule,
      ));
    },
    resolveTypeReferenceDirectives(typeReferenceDirectiveNames, containingFile, redirectedReference, options) {
      return typeReferenceDirectiveNames.map(directive => excludeNodeModulesResolution(
        ts.resolveTypeReferenceDirective(
          typeof directive === 'string' ? directive : directive.fileName,
          containingFile,
          options,
          moduleResolutionHost,
          redirectedReference,
        ).resolvedTypeReferenceDirective,
      ));
    },
  });

/** Create the bounded Project used by extraction. Exported for contract tests so the guard
 * cannot remain tested but accidentally become detached from the production Project. */
export function createTypeScriptExtractionProject(compilerOptions: ts.CompilerOptions): Project {
  return new Project({
    compilerOptions,
    skipAddingFilesFromTsConfig: true,
    skipLoadingLibFiles: true,
    resolutionHost: nodeModulesBlockingResolutionHost,
  });
}

/** Map the engine-provided raw source text to the text ts-morph should parse. SFC pseudo-modules
 * carry a `virtualAbsPath`; their parseable TS is extracted from the raw component file, but the hash
 * still fingerprints the raw file (engine-owned). */
function moduleTextFor(pending: PendingModule, src: SourceFileText): ModuleContent {
  if (pending.virtualAbsPath) {
    const extracted = extractTypeScriptFromSfc(pending.absPath, src.content);
    return { text: extracted?.ts ?? '', hash: src.contentHash };
  }
  return { text: src.content, hash: src.contentHash };
}

function loadIntoProject(project: Project, pending: PendingModule, content: ModuleContent): SourceFile | undefined {
  const targetPath = pending.virtualAbsPath ?? pending.absPath;
  try {
    return project.createSourceFile(targetPath, content.text, { overwrite: true });
  } catch {
    return undefined;
  }
}

function extractModuleDelta(
  sf: SourceFile,
  pending: PendingModule,
  absPathToId: Map<HostPath, string>,
  packages: PackageInfo[],
  repoRoot: HostPath,
  pathsContext: PathsContext,
): SemanticModuleDelta {
  const { exports, moduleCalls } = collectExports(sf);
  const reExports = collectReExports(sf.compilerNode, absPathToId, packages, repoRoot, pathsContext);
  return {
    moduleId: pending.moduleId,
    imports: collectImports(sf.compilerNode, absPathToId, packages, repoRoot, pathsContext),
    exports,
    ...(reExports.length > 0 ? { reExports } : {}),
    ...(moduleCalls.names.length > 0 ? { calls: moduleCalls.names } : {}),
    ...(moduleCalls.total > moduleCalls.names.length ? { callsTotal: moduleCalls.total } : {}),
    semanticHints: collectSemanticHints(sf, pending.pkgRelPath),
  };
}

/** Project the semantic subset of a previously-extracted module onto a reuse delta. The file content
 * is unchanged (content-hash hit), so its specifiers, exports, and calls match a fresh parse. Import
 * resolution is not content-only: a relative or path-aliased specifier resolves against the whole
 * module set, which can change between builds (a file added or removed, a barrel introduced). Each
 * edge is re-resolved against this build's path map so an incremental refresh matches a cold build of
 * the same tree; a freshly extracted module resolves the same specifiers to the same ids, so the pass
 * is a no-op for it. The engine re-stamps the unchanged mechanical fields when it reassembles the
 * ModuleInfo. */
function reuseDelta(
  pending: PendingModule,
  prev: ModuleInfo,
  absPathToId: Map<HostPath, string>,
  packages: PackageInfo[],
  repoRoot: HostPath,
  pathsContext: PathsContext,
): SemanticModuleDelta {
  const resolveEdge = (moduleSpecifier: string): { resolvedModuleId: string | undefined; isExternal: boolean } => {
    const res = resolveSpecifierFromMap(moduleSpecifier, prev.absPath, absPathToId, packages, repoRoot, pathsContext);
    return { resolvedModuleId: res?.resolvedModuleId, isExternal: res?.isExternal ?? false };
  };
  const reExports = prev.reExports?.map(rex => ({ ...rex, ...resolveEdge(rex.moduleSpecifier) }));
  return {
    moduleId: pending.moduleId,
    imports: prev.imports.map(imp => ({ ...imp, ...resolveEdge(imp.moduleSpecifier) })),
    exports: prev.exports,
    ...(reExports?.length ? { reExports } : {}),
    ...(prev.calls?.length ? { calls: prev.calls } : {}),
    ...(prev.semanticHints ? { semanticHints: prev.semanticHints } : {}),
  };
}

/**
 * Self-contained per-package extraction. The engine has already read each file once and supplied
 * the raw text + fingerprint via `sourceByModuleId`; this plugin only parses (ts-morph from
 * pre-parsed compilerOptions) and emits language semantics. Safe to call from a worker thread.
 *
 * Lifecycle: Project is created lazily only when at least one module is not a cache hit, and
 * is released as soon as this function returns (caller drops the result).
 */
export function extractPackage(input: ExtractPackageInput): ExtractPackageResult {
  const { pkg, pkgModules, prevByAbsPath, compilerOptions, absPathToId, packages, repoRoot, sourceByModuleId } = input;

  // First pass: classify each module as cache hit vs miss using the engine-provided fingerprint.
  interface Resolved {
    pending: PendingModule;
    content: ModuleContent | undefined;
    cached?: SemanticModuleDelta;
  }

  const pathsContext: PathsContext = { compilerOptions };
  const resolved: Resolved[] = pkgModules.map(pending => {
    const src = sourceByModuleId.get(pending.moduleId);
    if (!src) return { pending, content: undefined };
    const content = moduleTextFor(pending, src);
    const prev = prevByAbsPath.get(pending.absPath);
    if (prev && prev.id === pending.moduleId && prev.contentHash === content.hash) {
      return { pending, content, cached: reuseDelta(pending, prev, absPathToId, packages, repoRoot, pathsContext) };
    }
    return { pending, content };
  });

  const needsProject = resolved.some(r => r.content !== undefined && !r.cached);

  let project: Project | undefined;
  if (needsProject) {
    try {
      project = createTypeScriptExtractionProject(compilerOptions);
    } catch (e) {
      console.warn(`  ⚠ Skipping package ${pkg.name}: ${(e as Error).message}`);
      project = undefined;
    }
  }

  const deltas: SemanticModuleDelta[] = [];
  let reused = 0;
  let rescanned = 0;

  for (const r of resolved) {
    if (r.cached) {
      deltas.push(r.cached);
      reused++;
      continue;
    }
    if (!r.content || !project) continue;
    const sf = loadIntoProject(project, r.pending, r.content);
    if (!sf) continue;
    try {
      deltas.push(extractModuleDelta(sf, r.pending, absPathToId, packages, repoRoot, pathsContext));
      rescanned++;
    } catch (e) {
      // One bad AST edge case must not drop the whole extraction shard.
      console.warn(`  ⚠ Skipping AST details for ${pkg.name}/${r.pending.pkgRelPath}: ${(e as Error).message}`);
      deltas.push({
        moduleId: r.pending.moduleId,
        imports: collectImports(sf.compilerNode, absPathToId, packages, repoRoot, pathsContext),
        exports: [],
      });
      rescanned++;
    }
  }

  return { pkgName: pkg.name, deltas, reused, rescanned };
}
