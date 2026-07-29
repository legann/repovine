import type { RepositoryFactsSnapshot, RepositoryGraph, ModuleInfo } from '../types.js';
import { compareCodeUnits } from '../platform/ordering.js';
import { loadDomainsConfig, type DomainsConfig } from './domains-schema.js';
import { domainLabelFromId } from '../graph/node-ids.js';
import { importerCount } from '../graph/index.js';
// Side-effect import: the built-in source plugins must be registered before this module asks the
import { stripSourceExtension } from '../plugin-host/source-set.js';
import { domainLabelSlug, domainSlug } from './domain-slug.js';
import { lastPathSegment, toPosixPath } from '../platform/paths.js';

export { DOMAINS_CONFIG_MERGE_STRATEGY, DomainsConfigSchema, compileGlob, loadDomainsConfig, type DomainsConfig, type GlobMatcher } from './domains-schema.js';

/** First path segments that are structural — skip when inferring domain from path. */
export const STRUCTURAL_DIRS = new Set([
  // Standard project structure
  'src', 'lib', 'libs', 'internal', 'shared', 'common', 'utils', 'core',
  'components', 'hooks', 'pages', 'app', 'features', 'modules', 'services',
  // Routing / API conventions (Next.js, Nuxt, SvelteKit)
  'api', 'routes', 'handlers', 'controllers', 'endpoints',
  // Framework-specific grouping (Vue 3, Nuxt, Angular)
  'composables', 'views', 'server', 'directives', 'pipes', 'guards',
  // SSR / server-side conventions (Nuxt server middleware, Server Actions)
  'loaders', 'actions', 'server-only', 'client-only', 'isr', 'ssr',
  // Monorepo / workspace layout
  'packages', 'apps', 'workspaces',
  // Horizontal layers (types, config, state)
  'types', 'config', 'configs', 'constants', 'store', 'stores',
  'contexts', 'providers', 'middleware', 'models',
  // Testing. Spelled in the label alphabet, which every reader slugs into before asking:
  // `__tests__` would fold onto `tests` and never be looked up under its own name.
  'tests', 'testing', 'mocks', 'fixtures', 'setup',
  // Clean Architecture / DDD layers
  'adapters', 'interfaces', 'entities', 'repositories', 'use-cases',
  'slices', 'queries', 'columns',
]);

/**
 * Basename stems that never represent a business domain in JS/TS.
 * `index.ts`, `main.tsx`, `_app.tsx` etc. are entry/bootstrap, not domain-bearing units.
 * Includes framework convention files (Next.js App Router, Vue Router, SvelteKit):
 *   - Next.js App Router: page, layout, loading, route, error, not-found, template, default
 *   - Next.js Pages Router: _app, _document, _error (covered by leading-underscore rule)
 *   - SvelteKit: +page, +layout, +server, +error — both the `+`-prefixed form
 *     (caught by the leading-`+` rule in evaluateBasenameCandidate) and any slug residue.
 *   - Angular: app (the root component shell — `app.component.ts` is rejected via suffix-aware path).
 */
export const RESERVED_BASENAMES = new Set([
  // Generic entry / bootstrap
  'index', 'main', 'entry', 'bootstrap', 'setup', 'app', 'cli',
  'globals', 'polyfills', 'constants',
  'mod', 'lib', 'core',
  // Next.js App Router special files (filename = framework slot, not a domain)
  'page', 'layout', 'loading', 'route', 'error', 'not-found', 'template', 'default',
  // Common framework lifecycle entries
  'middleware', 'instrumentation',
  // SvelteKit slot residues (after stripping +)
  'server',
  // App shell + entry files (root.tsx app shell, entry.{server,client} runtime hooks)
  'root', 'entry-server', 'entry-client',
  // Generic server/client suffix stems left behind after dot-suffix extraction
  'client',
]);

/**
 * Filename suffixes that mark non-domain files (tests, types, configs, fixtures, stories).
 * Match against the part after the last dot before the file extension.
 * e.g. `auth.test.ts` → suffix `test` → drop. `Button.stories.tsx` → suffix `stories` → drop.
 */
export const NON_DOMAIN_SUFFIXES = new Set([
  'test', 'spec', 'd', 'types', 'config', 'stories', 'mock', 'fixture', 'stub',
  // DTOs / data models — describe shape, not handlers
  'model', 'dto',
]);

/**
 * Conventional JS/TS suffixes for handler/entity files. When basename matches `<prefix>.<suffix>.ts`,
 * `<prefix>` is the domain (e.g. `users.controller.ts` → domain `users`).
 *
 * Coverage:
 *   - NestJS: controller, service, repository, resolver, guard, interceptor
 *   - Angular: component, directive, pipe, module, guard, interceptor, resolver
 *   - tRPC / Express / Hono: router
 *   - DDD / clean arch: saga, handler, gateway, validator
 *   - Pinia / Zustand stores: store
 */
export const DOMAIN_SUFFIXES = new Set([
  // Web framework primitives
  'controller', 'service', 'repository', 'resolver', 'saga', 'handler',
  'route', 'router', 'gateway', 'schema', 'validator',
  // Angular / DI
  'component', 'directive', 'pipe', 'module', 'guard', 'interceptor',
  // State management
  'store',
]);

/** Min incoming `imports` edges for a basename to be promoted to a domain by graph connectivity. */
export const BASENAME_PROMOTION_MIN_INCOMING = 3;

/**
 * Test whether a resource label matches any user-configured exclude pattern.
 * Suffix matches are checked first (cheap); regex patterns second.
 * Returns false when both lists are empty/undefined — caller should not call this in that case.
 */
export function matchesInfraResourceExclude(
  label: string,
  excludeSuffixes?: string[],
  excludePatterns?: string[],
): boolean {
  if (excludeSuffixes) {
    for (const suf of excludeSuffixes) {
      if (label.endsWith(suf)) return true;
    }
  }
  if (excludePatterns) {
    for (const pat of excludePatterns) {
      try {
        if (new RegExp(pat).test(label)) return true;
      } catch {
        // invalid regex, skip silently
      }
    }
  }
  return false;
}

/**
 * Split a basename like `users.controller` into `{ stem: 'users', suffix: 'controller' }`.
 * Returns `{ stem: basename, suffix: undefined }` when there is no dot.
 */
export function splitBasename(basename: string): { stem: string; suffix?: string } {
  const dot = basename.lastIndexOf('.');
  if (dot <= 0 || dot === basename.length - 1) return { stem: basename };
  return { stem: basename.slice(0, dot), suffix: basename.slice(dot + 1).toLowerCase() };
}

/**
 * Domains inferred from directory path: non-structural, non-PascalCase directory segments.
 * Skips the basename (file itself) — `LandingAccentStyles.tsx` is a component, not a domain.
 * Skips segments containing uppercase letters in source form — those are usually component/class
 * names used as directory grouping (e.g. `BillingWidget/`), not real domain folders (`auth/`, `billing/`).
 * e.g. "src/auth/session-manager.ts" → ["auth"], "shared/oauth/client.ts" → ["oauth"]
 */
export function getPathBasedDomains(relativeFilePath: string, extraStructural?: Set<string>): string[] {
  const withoutExt = stripSourceExtension(relativeFilePath);
  const allSegments = withoutExt.split(/[/\\]/).filter(Boolean);
  // Drop the basename — only directory segments become domains.
  const dirSegments = allSegments.slice(0, -1);
  const domains: string[] = [];
  for (const seg of dirSegments) {
    // Skip PascalCase / camelCase segments — component/class names, not domain folders.
    if (/[A-Z]/.test(seg)) continue;
    // The structural test reads the slug, not the raw segment: `src ` and `src` name one directory
    // convention, and testing the raw form lets the padded spelling through as a domain.
    const slug = domainSlug(seg);
    if (!slug) continue;
    if (STRUCTURAL_DIRS.has(slug)) continue;
    if (extraStructural?.has(slug)) continue;
    if (!domains.includes(slug)) domains.push(slug);
  }
  return domains;
}

/**
 * Decide whether the basename of a file should be a domain candidate, and what its label is.
 *
 * Basename heuristic over naming conventions, including framework slot names. The extension comes
 * off through the registered source plugins, so `main.py` and `main.ts` reach the same verdict:
 * - PascalCase / contains uppercase → low-confidence candidate (React component, class file);
 *   `pascalCaseBasename: 'reject'` drops it instead.
 * - Reserved basename (`index`, `main`, `app`, ...) → reject.
 * - Starts with `_` → reject (Next.js `_app`, `_document`, private).
 * - Suffix in NON_DOMAIN_SUFFIXES (`test`, `spec`, `types`, `config`, ...) → reject entire file.
 * - Suffix in DOMAIN_SUFFIXES (`controller`, `service`, `repository`, ...) → high-confidence;
 *   the stem before the suffix is the domain label.
 * - kebab-case basename at one level below the package root (e.g. `<pkg>/src/<name>.ts`) → candidate.
 *   Promoted to a domain only when the module is a handler (has a `resource:` node pointing to it)
 *   or has ≥3 incoming imports (acts as a public API).
 *
 * Returns the candidate domain label, or undefined when the basename should not become a domain.
 * The caller is still responsible for honoring basename.files include/exclude overrides.
 */
export interface BasenameDecision {
  /** When set, the basename produces this domain label. */
  domain?: string;
  /** When set, the whole file is non-domain (drop directory domains too if you want stricter). */
  rejected: boolean;
  /** True when the decision came from a strong signal (suffix or runtime-resource handler). */
  highConfidence: boolean;
}

export interface EvaluateBasenameOptions {
  /** Mirrors DomainsConfig.basename.pascalCase. Default 'lightweight'. */
  pascalCaseBasename?: 'lightweight' | 'reject';
}

export function evaluateBasenameCandidate(
  relativeFilePath: string,
  modId: string,
  graph: RepositoryGraph,
  packageName?: string,
  options?: EvaluateBasenameOptions,
): BasenameDecision {
  const withoutExt = stripSourceExtension(relativeFilePath);
  const segments = withoutExt.split('/').filter(Boolean);
  const basename = lastPathSegment(withoutExt);
  if (!basename) return { rejected: true, highConfidence: false };

  // Reserved or framework-slot basenames are never domains.
  // - `_app.tsx`, `_document.tsx` (Next.js Pages Router private files)
  // - `+page.svelte`, `+server.ts`, `+layout.ts` (SvelteKit route slots)
  if (basename.startsWith('_') || basename.startsWith('+')) return { rejected: true, highConfidence: true };
  const lowerBase = basename.toLowerCase();
  if (RESERVED_BASENAMES.has(lowerBase)) return { rejected: true, highConfidence: true };

  // Suffix-based classification: `users.controller`, `auth.test`, etc.
  const { stem, suffix } = splitBasename(basename);
  if (suffix && NON_DOMAIN_SUFFIXES.has(suffix)) {
    // Non-domain by suffix (`.test`, `.types`, ...).
    return { rejected: true, highConfidence: true };
  }
  if (suffix && DOMAIN_SUFFIXES.has(suffix)) {
    // High-confidence domain: `<stem>.<suffix>` — use stem unless stem is PascalCase or reserved.
    if (/[A-Z]/.test(stem) || RESERVED_BASENAMES.has(stem.toLowerCase())) {
      return { rejected: true, highConfidence: true };
    }
    const stemSlug = domainSlug(stem);
    return stemSlug
      ? { domain: stemSlug, rejected: false, highConfidence: true }
      : { rejected: true, highConfidence: true };
  }
  // Runtime markers (`.server.ts`, `.client.ts`) are not handler suffixes — they describe where
  // the file runs, not what it does. Strip them and let the stem go through normal evaluation
  // (so `users.server.ts` becomes the same domain as `users.ts`, while `entry.server.ts` is
  // still rejected because `entry` is reserved).
  if (suffix === 'server' || suffix === 'client') {
    if (RESERVED_BASENAMES.has(stem.toLowerCase())) {
      return { rejected: true, highConfidence: true };
    }
    if (/[A-Z]/.test(stem)) {
      const slug = domainSlug(stem);
      return slug ? { domain: slug, rejected: false, highConfidence: false } : { rejected: true, highConfidence: false };
    }
    const slug = domainSlug(stem);
    if (slug && !/^\d+$/.test(slug)) {
      return { domain: slug, rejected: false, highConfidence: false };
    }
    return { rejected: true, highConfidence: false };
  }

  // Plain basename (no recognized suffix). PascalCase → emit as a low-confidence candidate
  // unless the caller opted into `reject`. Default 'lightweight' downgrades it to a 1-2-member
  // domain (kept in the graph so existing annotations stay alive); 'reject' drops the candidate
  // entirely so UI-component-per-file repos don't accumulate hundreds of pseudo-domains.
  if (/[A-Z]/.test(basename)) {
    if (options?.pascalCaseBasename === 'reject') {
      return { rejected: true, highConfidence: false };
    }
    const slug = domainSlug(basename);
    if (!slug) return { rejected: true, highConfidence: false };
    return { domain: slug, rejected: false, highConfidence: false };
  }

  // Pure numeric or empty after slugging — not a domain.
  const slug = domainSlug(basename);
  if (!slug || /^\d+$/.test(slug)) return { rejected: true, highConfidence: false };

  // Graph-based promotion signals — handler files and well-connected modules.
  const inEdges = graph.inEdges.get(modId) ?? [];
  // A runtime-resource node (Lambda function, etc.) links to its handler module via an 'infra' edge
  // (see infra-runtime-links where runtime-resource nodes are created from SAM/CloudFormation).
  // 'binds_to' is the related env-binding synonym handler modules can carry.
  const isRuntimeResourceHandler = inEdges.some(e => {
    if (e.kind !== 'infra' && e.kind !== 'binds_to') return false;
    const fromNode = graph.nodes.get(e.from);
    return fromNode?.type === 'runtime-resource';
  });
  if (isRuntimeResourceHandler) return { domain: slug, rejected: false, highConfidence: true };

  const incomingImports = importerCount(graph, modId);
  if (incomingImports >= BASENAME_PROMOTION_MIN_INCOMING) {
    return { domain: slug, rejected: false, highConfidence: false };
  }

  // Flat handler convention: file directly under <pkg>/src or <pkg>/ — likely an entry-point.
  // After dropping STRUCTURAL_DIRS (src, packages, apps, lib, ...) any remaining non-structural
  // segment must be the package name itself (so the file lives at the root of the package).
  // If a non-package non-structural directory remains, the file is nested in a feature folder
  // and basename is not a domain (e.g. `src/utils/helpers/format-date.ts` — `helpers` is not a package).
  const dirSegments = segments.slice(0, -1);
  const pkgVariants = collectPackageNameVariants(packageName);
  const nonStructural = dirSegments.filter(seg => {
    if (STRUCTURAL_DIRS.has(domainSlug(seg))) return false;
    if (pkgVariants.has(seg.toLowerCase())) return false;
    return true;
  });
  if (nonStructural.length === 0) {
    return { domain: slug, rejected: false, highConfidence: false };
  }

  return { rejected: true, highConfidence: false };
}

/**
 * Extract the short, human-friendly name from a package.json name field.
 * Strips npm scope and lowercases; result is the package's display name in the graph.
 *
 *   "@acme/api-functions" -> "api-functions"
 *   "@scope/platform-core" -> "platform-core"
 *   "lmtify-public"           -> "lmtify-public"
 *   "@scope/foo"              -> "foo"
 */
export function packageShortName(packageName: string): string {
  const slashIdx = packageName.lastIndexOf('/');
  return domainSlug(slashIdx >= 0 ? packageName.slice(slashIdx + 1) : packageName);
}

/**
 * Produce path-friendly variants of a package name so they can match directory segments.
 * `@scope/foo-bar` directory might be `foo-bar/`, or `foo/bar/`, or `@scope/foo-bar/`.
 */
function collectPackageNameVariants(packageName?: string): Set<string> {
  const out = new Set<string>();
  if (!packageName) return out;
  const lower = packageName.toLowerCase();
  out.add(lower);
  // Strip scope: `@scope/foo-bar` → `foo-bar`.
  const noScope = lower.replace(/^@[^/]+\//, '');
  out.add(noScope);
  // Hyphenated last segment: also accept un-prefixed form.
  if (noScope.includes('-')) {
    for (const part of noScope.split('-')) {
      if (part) out.add(part);
    }
  }
  return out;
}

/**
 * Build undirected adjacency for modules: modId -> Set of neighbor modIds (imports in either direction).
 */
function getImportNeighbors(graph: RepositoryGraph): Map<string, Set<string>> {
  const neighbors = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'imports') continue;
    const a = edge.from;
    const b = edge.to;
    let setA = neighbors.get(a);
    if (!setA) { setA = new Set(); neighbors.set(a, setA); }
    setA.add(b);
    let setB = neighbors.get(b);
    if (!setB) { setB = new Set(); neighbors.set(b, setB); }
    setB.add(a);
  }
  return neighbors;
}

/**
 * Label propagation: each node gets the most frequent label among neighbors.
 * Returns stable label per node (cluster id).
 * When counts tie, the lexicographically smallest label is chosen so the result is deterministic.
 */
function labelPropagation(
  modIds: string[],
  neighbors: Map<string, Set<string>>,
  maxIterations: number = 10,
): Map<string, string> {
  const sortedIds = [...modIds].sort((a, b) => compareCodeUnits(a, b));
  const label = new Map<string, string>();
  for (const id of sortedIds) label.set(id, id);
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (const id of sortedIds) {
      const nb = neighbors.get(id);
      if (!nb || nb.size === 0) continue;
      const counts = new Map<string, number>();
      const currentLabel = label.get(id) ?? id;
      counts.set(currentLabel, (counts.get(currentLabel) ?? 0) + 1);
      for (const n of nb) {
        const l = label.get(n) ?? n;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let best = label.get(id) ?? id;
      let bestCount = 0;
      for (const [l, c] of counts) {
        if (c > bestCount || (c === bestCount && l < best)) {
          bestCount = c;
          best = l;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return label;
}

/**
 * Name a cluster by the most common non-structural path segment among its modules. Returns
 * undefined when every member sits under structural directories only: a cluster whose members
 * share no path segment has no name in the tree, and inventing one puts a label in the graph that
 * matches nothing in the repository.
 */
function nameCluster(
  modIds: string[],
  modulesById: Map<string, ModuleInfo>,
): string | undefined {
  const segmentCounts = new Map<string, number>();
  for (const modId of modIds) {
    const mod = modulesById.get(modId);
    if (!mod) continue;
    const pathDomains = getPathBasedDomains(mod.relativeFilePath);
    for (const d of pathDomains) {
      segmentCounts.set(d, (segmentCounts.get(d) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [seg, c] of segmentCounts) {
    if (c > bestCount) { bestCount = c; best = seg; }
  }
  return best;
}

/**
 * Cluster modules by import graph (label propagation), then assign each cluster a domain name from path segments.
 */
export function getClusterDomains(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
  modulesById: Map<string, ModuleInfo>,
): Map<string, string> {
  const modIds = snapshot.modules.map(m => m.id);
  const neighbors = getImportNeighbors(graph);
  const label = labelPropagation(modIds, neighbors);

  const clusterToMods = new Map<string, string[]>();
  for (const [modId, clusterLabel] of label) {
    const list = clusterToMods.get(clusterLabel) ?? [];
    list.push(modId);
    clusterToMods.set(clusterLabel, list);
  }

  const modToDomain = new Map<string, string>();
  for (const [, modIdsInCluster] of clusterToMods) {
    const domainName = nameCluster(modIdsInCluster, modulesById);
    if (!domainName) continue;
    for (const id of modIdsInCluster) {
      modToDomain.set(id, domainName);
    }
  }
  return modToDomain;
}

/** Test relative file path against config's file-as-domain include/exclude lists. */
export function matchFileAsDomain(relativeFilePath: string, config: DomainsConfig | null): 'include' | 'exclude' | undefined {
  if (!config) return undefined;
  const path = toPosixPath(relativeFilePath);
  if (config._fileAsDomainExclude?.some(re => re.test(path))) return 'exclude';
  if (config._fileAsDomainInclude?.some(re => re.test(path))) return 'include';
  return undefined;
}

/**
 * Resolve a domain name or alias to the canonical domain label used in the graph.
 * E.g. "kubernetes" or "k8s" -> "infra-k8s" when domains["infra-k8s"].aliases includes them.
 *
 * Returns a bare label for every input, including one that arrived with the `domain:` prefix. The
 * caller turns it back into an id with `domainNodeId`; a return that is bare on an alias hit and
 * prefixed on a miss made every caller re-test the prefix.
 */
export function resolveDomainToCanonical(input: string, config: DomainsConfig | null): string {
  // The alphabet applies whether or not a config file exists: the same scope argument must name
  // the same domain in a repository that has `repovine.domains.json` and one that does not.
  const normalized = domainLabelSlug(domainLabelFromId(input));
  if (!input || !config) return normalized;
  return config._aliasToCanonical?.[normalized] ?? normalized;
}

/**
 * Apply config patterns to relative path; returns matching domain labels.
 */
export function getConfigPatternDomains(
  relativeFilePath: string,
  config: DomainsConfig,
): string[] {
  const domains: string[] = [];
  const text = relativeFilePath.toLowerCase();
  for (const [domain, entry] of Object.entries(config.domains ?? {})) {
    const label = domainLabelSlug(domain);
    if (!label) continue;
    for (const pattern of entry.paths ?? []) {
      try {
        const re = new RegExp(pattern, 'i');
        if (re.test(text) && !domains.includes(label)) {
          domains.push(label);
        }
      } catch {
        // invalid regex, skip
      }
    }
  }
  return domains;
}

/**
 * Module-count threshold for a domain to be classified as 'heavy' vs 'lightweight'.
 * - >= MIN_DOMAIN_SIZE_HEAVY → heavy (normal domain, visible in search/anomalies).
 * - 1 to MIN_DOMAIN_SIZE_HEAVY-1 → lightweight (kept in graph for annotation, hidden by default).
 * - 0 → dropped entirely (never reached because domains are derived from modules).
 *
 * Heavy threshold of 3; smaller domains now survive as
 * lightweight rather than getting deleted.
 */
export const MIN_DOMAIN_SIZE_HEAVY = 3;
/** Maximum domains per module — keep the most specific to avoid grep-tag inflation. */
export const MAX_DOMAINS_PER_MODULE = 3;

export type TagSource = 'path' | 'package' | 'cluster' | 'pattern';

/**
 * Tag carries its source so primary (path/cluster) vs secondary (pattern) can be distinguished
 * downstream when building edges.
 */
export interface DomainTag {
  domain: string;
  source: TagSource;
}

/**
 * Per-domain classification produced by collectAllDomainTags.
 * Used by pass4Domains to mark domain nodes with the right weight metadata.
 */
export interface DomainClassification {
  /** Modules tagged. */
  count: number;
  /** Whether the domain is heavy (visible) or lightweight (kept but hidden by default). */
  weight: 'heavy' | 'lightweight';
}

/**
 * Collect all (modId, domainTags) from path-based, cluster-based, and optional config,
 * along with per-domain weight classification.
 *
 * Source priority for dedup: path > cluster > pattern. When the same domain comes from multiple
 * sources, the highest-priority one is kept (so `auth` tagged by both path and pattern is primary).
 *
 * Auto-detected domains with fewer than MIN_DOMAIN_SIZE_HEAVY modules are marked 'lightweight'
 * (kept in graph but hidden from search/anomalies by default). Domains declared in config
 * patterns or produced by high-confidence heuristic (suffix-based, runtime-resource handler) are forced
 * 'heavy' regardless of size.
 */
export function collectAllDomainTags(
  snapshot: RepositoryFactsSnapshot,
  graph: RepositoryGraph,
  repoRoot: string,
  modulesById?: Map<string, ModuleInfo>,
): { tagsByModule: Map<string, DomainTag[]>; classification: Map<string, DomainClassification> } {
  const modToTags = new Map<string, Map<string, TagSource>>();
  const modsMap = modulesById ?? new Map(snapshot.modules.map(m => [m.id, m]));

  // Priority order: path > package > cluster > pattern. Path is the most informative (direct
  // directory placement); package shows ownership/build boundary; cluster is import-graph guess;
  // pattern is the loosest (regex secondary match).
  const priority: Record<TagSource, number> = { path: 4, package: 3, cluster: 2, pattern: 1 };

  function add(modId: string, domain: string, source: TagSource): void {
    let tags = modToTags.get(modId);
    if (!tags) { tags = new Map(); modToTags.set(modId, tags); }
    const existing = tags.get(domain);
    if (existing === undefined || priority[source] > priority[existing]) {
      tags.set(domain, source);
    }
  }

  const config = loadDomainsConfig(repoRoot);
  const extraStructural = config?._structuralDirs;
  // Domains protected from MIN_DOMAIN_SIZE_HEAVY drop:
  //   - declared in config patterns
  //   - produced by high-confidence heuristic (suffix-based or runtime-resource handler)
  //   - produced by basename.files.include override
  const protectedDomains = new Set<string>();

  for (const mod of snapshot.modules) {
    for (const d of getPathBasedDomains(mod.relativeFilePath, extraStructural)) {
      add(mod.id, d, 'path');
    }

    // Basename-based domain: heuristic + config overrides.
    const override = matchFileAsDomain(mod.relativeFilePath, config);
    if (override === 'exclude') continue;
    const decision = evaluateBasenameCandidate(mod.relativeFilePath, mod.id, graph, mod.packageName, {
      pascalCaseBasename: config?.basename?.pascalCase,
    });
    if (override === 'include') {
      // Force basename to be a domain regardless of heuristic verdict.
      const withoutExt = stripSourceExtension(mod.relativeFilePath);
      const basename = lastPathSegment(withoutExt);
      const { stem, suffix } = splitBasename(basename);
      const label = suffix && DOMAIN_SUFFIXES.has(suffix) ? stem : basename;
      const slug = domainSlug(label);
      if (slug) {
        add(mod.id, slug, 'path');
        protectedDomains.add(slug);
      }
      continue;
    }
    if (decision.domain) {
      add(mod.id, decision.domain, 'path');
      if (decision.highConfidence) protectedDomains.add(decision.domain);
    }
  }

  const clusterDomains = getClusterDomains(graph, snapshot, modsMap);
  for (const [modId, domain] of clusterDomains) {
    add(modId, domain, 'cluster');
  }

  const configDomains = new Set<string>();
  if (config?.domains && Object.keys(config.domains).length > 0) {
    for (const domain of Object.keys(config.domains)) {
      const label = domainLabelSlug(domain);
      if (!label) continue;
      configDomains.add(label);
      protectedDomains.add(label);
    }
    for (const mod of snapshot.modules) {
      for (const d of getConfigPatternDomains(mod.relativeFilePath, config)) {
        add(mod.id, d, 'pattern');
      }
    }
  }

  // Package-as-domain: each package becomes a top-level domain by default. Heavy/lightweight
  // classification is decided by the normal MIN_DOMAIN_SIZE_HEAVY rule downstream — packages
  // with 1-2 modules end up lightweight, packages with 3+ end up heavy.
  const pkgCfg = config?.packages;
  const packagesEnabled = pkgCfg?.enabled !== false;
  if (packagesEnabled) {
    // Config names are matched and minted in the label alphabet, so `exclude: ["Skip Me"]`
    // reaches the same spelling `packageShortName` produces for the package it names.
    const excludeSet = new Set((pkgCfg?.exclude ?? []).map(domainSlug));
    const renameMap = new Map<string, string>();
    for (const [from, to] of Object.entries(pkgCfg?.rename ?? {})) {
      renameMap.set(domainSlug(from), domainSlug(String(to)));
    }
    // merge: each member package gets mapped to the merged label.
    const mergeMap = new Map<string, string>();
    for (const [mergedLabel, members] of Object.entries(pkgCfg?.merge ?? {})) {
      if (!Array.isArray(members)) continue;
      for (const m of members) mergeMap.set(domainSlug(String(m)), domainSlug(mergedLabel));
    }
    // Pre-resolve each package name -> final domain label (or undefined if excluded).
    const pkgToLabel = new Map<string, string>();
    for (const pkg of snapshot.packages) {
      const short = packageShortName(pkg.name);
      if (!short || excludeSet.has(short)) continue;
      const afterMerge = mergeMap.get(short) ?? short;
      const final = renameMap.get(afterMerge) ?? afterMerge;
      pkgToLabel.set(pkg.name, final);
    }
    for (const mod of snapshot.modules) {
      const label = pkgToLabel.get(mod.packageName);
      if (label) add(mod.id, label, 'package');
    }
  }

  // Count modules per domain so we can classify each as heavy or lightweight.
  const counts = new Map<string, number>();
  for (const tags of modToTags.values()) {
    for (const domain of tags.keys()) {
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
  }
  const classification = new Map<string, DomainClassification>();
  for (const [domain, n] of counts) {
    const weight: 'heavy' | 'lightweight' =
      protectedDomains.has(domain) || n >= MIN_DOMAIN_SIZE_HEAVY ? 'heavy' : 'lightweight';
    classification.set(domain, { count: n, weight });
  }

  const tagsByModule = new Map<string, DomainTag[]>();
  for (const [modId, tags] of modToTags) {
    const kept: DomainTag[] = [];
    for (const [domain, source] of tags) {
      kept.push({ domain, source });
    }
    if (kept.length === 0) continue;
    // Sort by priority (path > cluster > pattern); cap at MAX_DOMAINS_PER_MODULE to prevent
    // wide regex patterns from tagging the same module into 5+ domains. Heavy domains win
    // over lightweight on ties so the cap doesn't accidentally drop the meaningful tag.
    kept.sort((a, b) => {
      const ah = classification.get(a.domain)?.weight === 'heavy' ? 1 : 0;
      const bh = classification.get(b.domain)?.weight === 'heavy' ? 1 : 0;
      if (bh !== ah) return bh - ah;
      const ps = priority[b.source] - priority[a.source];
      return ps !== 0 ? ps : compareCodeUnits(a.domain, b.domain);
    });
    tagsByModule.set(modId, kept.slice(0, MAX_DOMAINS_PER_MODULE));
  }
  return { tagsByModule, classification };
}
