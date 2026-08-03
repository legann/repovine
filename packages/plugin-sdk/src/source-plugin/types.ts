import type { ModuleInfo, PackageInfo, PendingModule, PendingModuleDraft, SemanticModuleDelta } from '../types.js';
import type { PluginRequirements, PluginAvailability } from '../runtime.js';
import type { ReadonlyFactRecord } from '../plugin/projection.js';
import type { PrunedDir } from './discovery-walk.js';
import type { HostPath, RepoRelPath } from '../path-contract.js';

/**
 * Source plugin contract types.
 *
 * A source plugin owns one language/ecosystem (TypeScript, Python, …). It runs in two passes,
 * mirroring the IaC parser split, but it emits CODE SEMANTICS ONLY. A producer never
 * mints mechanical metadata (id / paths / contentHash / provenance): it returns semantic deltas and
 * the engine assembles the full `ModuleInfo[]` at the Stage-1 boundary (the IaC side does the same
 * for `InfraModuleInfo[]`).
 *
 *   discover(repoRoot)  → packages + candidate (pending) modules   (no AST)
 *   extract(input)      → SemanticModuleDelta[] for a shard         (AST; worker_threads-safe)
 *
 * The orchestrator (stage1/index.ts) only ever sees these contract types — never a language's AST.
 */

/** File matcher for a source plugin, by extension, exact name, or pattern. */
export interface SourceFileMatch {
  extensions?: string[];
  fileNames?: string[];
  fileNamePatterns?: RegExp[];
}

/**
 * Context handed to a source plugin handler resolver. The host pre-filters package/module lookup to
 * the plugin that owns the resolver, so a language cannot accidentally claim another language's
 * runtime handler by path coincidence.
 */
export interface HandlerResolveContext {
  /** Packages discovered by this source plugin. */
  packages: readonly PackageInfo[];
  /** Modules discovered by this source plugin, keyed by module id. */
  modulesById: ReadonlyMap<string, ModuleInfo>;
  /** Repo-relative roots to try for artifact/config-specific handler resolution. */
  repoRelSearchRoots: readonly RepoRelPath[];
  /** Repo-relative artifact root from IaC CodeUri/filename, if the host could derive one. */
  repoRelArtifactRoot?: RepoRelPath;
  /** Raw IaC resource attributes, if available (for example CodeUri, runtime, filename). */
  attributes?: Readonly<Record<string, string>>;
  /** Repo-relative IaC file path that declared the handler, if available. */
  infraRepoRelPath?: RepoRelPath;
  /** Host-provided handler path aliases, e.g. bundle handler path -> source path. */
  repoRelHandlerPathMap?: Readonly<Record<string, RepoRelPath>>;
  /** Resolve a repo-relative source path to a module id owned by this plugin. */
  resolveModuleByRepoRelPath(candidate: RepoRelPath): string | undefined;
  /** Normalize slashes/dot segments the same way the host resolver does. */
  normalizeRepoRelPath(value: string): RepoRelPath;
}

export type HandlerResolver = (handlerRef: string, ctx: HandlerResolveContext) => string | undefined;

/**
 * Declarative capabilities a source plugin advertises about the language/ecosystem it owns.
 * Core code asks these (via the registry helpers) instead of hardcoding `id === 'typescript'`
 * style checks, so a new language stops being misclassified the moment it declares its shape.
 * Every field is additive and optional except `extensions`; absence means "no, by construction".
 */
export interface SourcePluginCapabilities {
  /** Extensions this plugin owns. The union across plugins replaces hardcoded extension regexes
   *  (e.g. stage2 module-id normalization). Plugins that omit capabilities contribute nothing. */
  extensions: string[];
  /** Plugin produces frontend surfaces (file-based routes, UI components). Absent/false means
   *  backend-only by construction — its frontend layer stays empty rather than by coincidence. */
  uiSurfaces?: boolean;
  /** Package/dist names treat `-` `_` `.` as interchangeable (e.g. Python PEP 503). Gates the
   *  noise-relaxed package-id matching in scope resolution to this plugin's packages only, so
   *  ecosystems where those separators are distinct (npm/TS) never cross-match. */
  looseNameSeparators?: boolean;
  /** Resolve runtime handler strings owned by this language/ecosystem to module ids. The built-in
   *  TS/Python resolver handles `app.handler` -> `app`; Java/Go-style plugins can map their own
   *  conventions without forking IaC parsing. */
  resolveHandlerToModule?: HandlerResolver;
  /** Ecosystem rules the engine applies when it mints `mod:<pkg>/<path>` from a discovered file.
   *  The plugin states the facts; the engine owns the id, so the format never depends on plugin
   *  cooperation. Absent ⇒ the repo-relative path is used verbatim. */
  moduleIdNormalize?: ModuleIdNormalize;
}

/** Declarative path→id normalization for one ecosystem. */
export interface ModuleIdNormalize {
  /** Suffixes stripped from the path end. Tried longest-first, so `.d.ts` wins over `.ts`. */
  stripSuffixes?: string[];
  /** Basenames standing for their own directory, collapsed away: `index` (TS), `__init__` (Python). */
  indexBasenames?: string[];
}

/** Repo-root-relative glob scope used by repovine build.scan include/exclude config. */
export type ScanScope = 'all' | 'source' | 'infra';

export type ScanPatternInput =
  | string
  | {
      path: string;
      scope?: ScanScope;
    };

export interface CompiledScanPattern {
  /** Matches a repo-relative, `/`-separated path against one compiled `scan` glob. Matching is
   * linear in the path length: `*` stays within a segment, `**` spans separators, `?` is one char. */
  matcher: { test(path: string): boolean };
  scope: ScanScope;
}

export interface CompiledScanPatterns {
  include: CompiledScanPattern[];
  exclude: CompiledScanPattern[];
}

export type SourceDiscoveryLogLevel = 'debug' | 'warn' | 'error';

/** Options handed to discover(). Path filters the orchestrator already resolved. */
export interface SourceDiscoveryOptions {
  /**
   * The filenames that mark a package root for this plugin, resolved by the host from this build's
   * layout table.
   *
   * Required, and required for a reason: the plugin DECLARES its markers, and a producer that read
   * its own copy instead would discover by something the build never agreed to. Every input that
   * decides which packages exist then lands in one place — the fingerprint hashes it, `repovine init`
   * counts by it, and a config that retracts a marker changes discovery instead of only the report.
   * An absent option would have to mean "no markers", which is a producer that silently finds
   * nothing.
   */
  packageMarkers: readonly string[];
  /** Compiled `scan.include` / `scan.exclude` from repovine.config.json. */
  scanPatterns?: CompiledScanPatterns;
  /**
   * Where this producer's walk stopped, reported back to the host.
   *
   * Pruning decides which modules exist, and a skipped tree is otherwise indistinguishable from an
   * empty one: nothing downstream can tell a repository with no `node_modules` from one whose
   * `node_modules` was walked past. A producer forwards `walkRepository`'s `onPruned` here, and the
   * host publishes the total as `layoutSkipped`. Absent means the host wants no report.
   */
  onPruned?(pruned: PrunedDir): void;
  /**
   * Diagnostic sink for discovery. The host decides where a line goes and whether it goes anywhere:
   * a build driven by the MCP server writes to a different stream than a CLI run, and both silence
   * the channel in machine-readable modes. A producer reports what it could not read; it does not
   * pick the stream. Absent means the host wants no diagnostics from this pass.
   */
  log?(level: SourceDiscoveryLogLevel, message: string): void;
}

export interface SourceDiscoveryResult {
  packages: PackageInfo[];
  /** Candidate modules keyed by absolute file path, without ids: the engine mints `moduleId` from
   * `pkg` + `pkgRelPath` before anything downstream sees them. The orchestrator dedups across plugins. */
  pendingByAbsPath: Map<HostPath, PendingModuleDraft>;
  /** Opaque per-plugin payload threaded into extract() (e.g. parsed compilerOptions). Must be
   * structured-clone-safe so it can cross a worker_threads boundary. */
  extractContext?: unknown;
}

/** Raw source text + engine-computed fingerprint for one pending module. The engine owns file IO
 * and content hashing and hands these to the producer keyed by `PendingModule.moduleId`;
 * the producer reads them instead of touching the filesystem or computing its own hash. Absent for
 * a module the engine could not read. */
export interface SourceFileText {
  /** Raw file content (UTF-8). For single-file-component pseudo-modules the plugin extracts its
   * language slice from this raw text — the hash still fingerprints the raw file. */
  content: string;
  /** sha256(content), first 16 hex chars. Used for incremental-reuse decisions and stamped onto
   * the assembled ModuleInfo by the engine. */
  contentHash: string;
}

export interface SourceExtractInput {
  repoRoot: HostPath;
  packages: PackageInfo[];
  pendingModules: PendingModule[];
  /** Previous-snapshot modules keyed by absolute host path, for incremental reuse. May be empty. */
  prevByAbsPath: Map<HostPath, ModuleInfo>;
  /** Frozen abs-path → moduleId map covering all packages (read-only). */
  absPathToId: Map<HostPath, string>;
  /** Engine-provided raw content + content hash per pending module, keyed by `moduleId`. The
   * producer uses the hash for reuse decisions and the content for parsing; it never reads files
   * for source text or computes the fingerprint itself (engine-owned IO/hash). */
  sourceByModuleId: Map<string, SourceFileText>;
  /** The opaque payload returned by this plugin's discover(). */
  extractContext?: unknown;
  /** STAGE1_ANALYSIS_VERSION of the current run, for plugin-side cache keying. */
  analysisVersion: number;
}

export interface SourceExtractResult {
  /** Per-module language semantics, keyed back to `PendingModule.moduleId`. The engine assembles
   * the full `ModuleInfo` (id/paths/packageName/contentHash/provenance) from these deltas. */
  deltas: SemanticModuleDelta[];
  reused: number;
  rescanned: number;
  /**
   * Facts this producer publishes under schemas it owns, for Stage 2 projectors to select.
   *
   * This is the one channel from a Stage 1 producer to a projector. It carries data, so it survives
   * the worker boundary and the snapshot cache, and it is addressed by schema: a reader selects
   * `schema` without naming a producer, so the same fact from another ecosystem reads the same.
   * A fact whose schema owner is not this plugin, or whose shape does not validate, is refused with
   * the plugin named and is absent from the view.
   */
  facts?: readonly ReadonlyFactRecord[];
}

export interface SourcePlugin {
  /** Logical id, also written onto PackageInfo/PendingModule.sourcePluginId ('typescript'). */
  id: string;
  /** Contract major this plugin was authored against. Stamped by `defineSourcePlugin`; the loader
   *  refuses a mismatched major. Optional so an object literal still type-checks before the factory
   *  wraps it. */
  apiVersion?: number;
  /** Declarative prerequisites (e.g. an external runtime the plugin shells out to). Diagnostic
   *  companion to `available()`; absent ⇒ no external prerequisite. */
  requires?: PluginRequirements;
  /** Self-probe: is this plugin's toolchain present in the current environment? When it resolves
   *  `ok:false` the engine skips the plugin with one warning (graceful degradation) instead of
   *  letting every file fail downstream. Absent ⇒ assumed available. May be async. */
  available?(): PluginAvailability | Promise<PluginAvailability>;
  /**
   * Marker files that activate package discovery for this plugin (e.g. ['tsconfig.json']).
   *
   * Declared here and handed back on {@link SourceDiscoveryOptions.packageMarkers}: this is the one
   * statement of what a package root looks like for this ecosystem, and discovery reads it from the
   * host rather than from a second copy of its own.
   */
  packageMarkers?: string[];
  fileMatch?: SourceFileMatch;
  /** Declarative capabilities core asks instead of hardcoding language ids. Optional and additive:
   *  external plugins authored before this field keep working (they advertise nothing). */
  capabilities?: SourcePluginCapabilities;
  /** Pass 1: find packages + candidate files (no AST). Called once per plugin per repo scan. */
  discover(repoRoot: HostPath, options: SourceDiscoveryOptions): SourceDiscoveryResult;
  /** Pass 2: extract ModuleInfo for a shard of pending modules. Must be worker_threads-safe.
   * May return a Promise when the plugin lazy-loads heavy parser deps (TypeScript). */
  extract(input: SourceExtractInput): SourceExtractResult | Promise<SourceExtractResult>;
  /** Terminate any OS subprocesses this plugin spawned during an in-flight `extract`, before the
   *  worker thread is torn down. The engine calls it on shutdown / build cancel so a
   *  `Worker.terminate()` cannot orphan a child of the node process. Best-effort and idempotent;
   *  absent ⇒ the plugin spawns no subprocess (Optional and additive: prior plugins keep working). */
  terminateInFlight?(): void | Promise<void>;
}
