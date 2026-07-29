/**
 * Core repository-graph data model: the node/edge taxonomy, per-type node data, the graph container,
 * and the stage1 facts snapshot. Split out of `src/types.ts`, which re-exports it for compatibility.
 */
import type {
  FieldInfo,
  InfraEnvRef,
  InfraModuleInfo,
  InfraResource,
  InfraResourceKind,
  InfraTrigger,
  InternalInfo,
  MemberInfo,
  ModuleInfo,
  PackageInfo,
  ParamInfo,
  PkgRelPath,
  ReadonlyFactRecord,
  RepoRelPath,
  SsrMarkers,
  SymbolKind,
  HostPath,
} from '@repovine/plugin-sdk';
import type { Refusal } from '../response/refusal.js';
import type { DeclarationCatalog } from '../plugin-host/declaration-catalog.js';

/** One directory name the layout table kept out of a build, and how often it decided. */
export interface LayoutSkip {
  /** The table entry that matched — a directory name, not a path. */
  name: string;
  /** Which half of the table it sits in. */
  reason: 'pruned' | 'test-layout';
  /**
   * How many times a walk stopped at a directory because of this name.
   *
   * Counted per walk, not per directory: several producers walk one repository, and a directory all
   * of them declined is one stop each. The number says how much this entry decided, and a reader
   * after "which trees are missing" reads the name.
   */
  stops: number;
  /** Plugins that declared the name, in id order. Absent for a base entry no plugin claimed. */
  declaredBy?: string[];
}

// ── Symbol & Node taxonomy ──

export const NODE_TYPES = [
  'root',
  'package',
  'module',
  'export-symbol',
  'runtime-resource',
  'domain',
  'template',
] as const;
export type NodeType = typeof NODE_TYPES[number];

export const EDGE_KINDS = [
  'contains',
  'imports',
  'reexports',
  'tagged',
  'implements',
  'publishes',
  'consumes',
  'binds_to',
  'uses_env',
  'infra',
  'routes_to',
  'renders',
  'extends',
  'includes',
] as const;
export type EdgeKind = typeof EDGE_KINDS[number];

// ── Stage 1: Repository Facts Snapshot ──

/** A discovered template/rendered-surface artifact, projected to a `template` graph node in stage2. */
export interface TemplateFileInfo {
  /** Graph node id: `template:<relPath>`. */
  id: string;
  /** Repo-relative path (forward slashes). */
  relPath: string;
  /** Fingerprint of the template file content. Used for template annotation freshness. */
  contentHash: string;
  /** Engine/dialect when inferable; omitted when ambiguous. */
  engine?: string;
  /** Parent/base template name when statically known. */
  extendsTemplate?: string;
  /** Included template names/fragments when statically known. */
  includesTemplate?: string[];
  /** Block/slot names declared by the template body. */
  blocks?: string[];
}

export interface RepositoryFactsSnapshot {
  repoRoot: string;
  timestamp: string;
  /** Version of stage1 syntactic/content analysis that produced cached module facts. */
  analysisVersion?: number;
  /** Engine-build identity that produced these facts. Set only in development (git checkout or
   * REPOVINE_DEV) so a rebuilt engine is not silently reused; undefined in an installed package,
   * where the reuse gate stays analysisVersion-only. */
  engineBuildId?: string;
  /** Identity of extraction-affecting config (compiler options, scan filters, active plugins).
   * A mismatch invalidates module reuse even when source content hashes are unchanged. */
  extractionConfigFingerprint?: string;
  packages: PackageInfo[];
  modules: ModuleInfo[];
  infraModules?: InfraModuleInfo[];
  /**
   * What the scan refused, and why. A refused candidate is absent from `modules`, so without this
   * the graph reports it as never having existed; the pipeline log carries the same facts and is
   * silent under the MCP server and under `repovine status`, which is where a reader looks for them.
   * `repovine doctor` does not publish it: that command diagnoses the setup and never loads a graph.
   * Recomputed by every discovery pass, never reused from a cached snapshot.
   */
  buildRefusals?: Refusal[];
  /**
   * What the layout table kept out of this build: one entry per table name that actually decided,
   * with how often it stopped a walk and which plugin declared it.
   *
   * Separate from `buildRefusals` because pruning is not a failure — `node_modules` is skipped by
   * design and the refusal vocabulary has no reason for it. Without this the two are the same on
   * every surface: a tree that was walked past and a tree that was never there both leave nothing
   * behind. Absent when nothing was pruned.
   */
  layoutSkipped?: LayoutSkip[];
  /**
   * What this build's plugin set declares, merged into one per-run catalog.
   *
   * Declarations are data, so they travel with the facts: across the Stage 2 worker boundary, where
   * a registry populated on the main thread never arrives, and into the cache, where a build under
   * one catalog must not reuse a snapshot taken under another. Absent when no plugin declared
   * anything.
   */
  declarations?: DeclarationCatalog;
  /**
   * The plugin config this build resolved, as the spec an isolate reconstructs the set from.
   *
   * Declarations are the data half of a plugin and travel above; parsers, extractors, loaders and
   * projectors are code and travel nowhere. What crosses a worker boundary or a cache round-trip is
   * this: the small serialisable statement of which packages were selected, from which both worker
   * pools load the same set through the same path.
   */
  plugins?: {
    defaults: boolean;
    add: string[];
    disable: string[];
    retract?: string[];
  };
  /**
   * What this build's Stage 1 producers published under their own schemas.
   *
   * The one channel from a producer to a Stage 2 projector, and data for the same reason the
   * declarations are: it crosses the worker boundary and the snapshot cache, where a function or a
   * registry populated on the other side would not arrive. A projector selects a schema, never a
   * producer. Absent when no producer published anything.
   */
  facts?: ReadonlyFactRecord[];
  /** Template/rendered-surface artifacts discovered by stage1 producers. */
  templates?: TemplateFileInfo[];
  /**
   * Bundle output path → source entry path, both extension-stripped and repo-relative. Populated
   * from configured and auto-detected bundle scripts when the bundler's output path differs from
   * its entry, so a deployed artifact path resolves back to the source it was built from.
   */
  bundleOutputHandlerMap?: Record<string, string>;
  linkingConfig?: {
    handlers?: { searchRoots?: string[] };
    bundles?: { scripts?: string[]; autoDetect?: boolean };
    containers?: { dockerfileRoots?: string[] };
  };
}

// ── Stage 2: Semantic Graph ──

/** Node data per type (discriminated by GraphNode.type). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- discriminant for NodeDataByType
export interface RootNodeData {}

export interface PackageNodeData {
  path?: string;
  version?: string;
  /** Source plugin that discovered the package ('typescript' | 'python' | …). */
  sourcePluginId?: string;
}

export interface ModuleNodeData {
  /** Absolute host path, spelled the way the filesystem spells it. */
  absPath?: HostPath;
  /** Path relative to this module's PACKAGE root, POSIX-separated — the tail of `mod:<pkg>/<path>`. */
  pkgRelPath?: PkgRelPath;
  /** Path relative to the REPOSITORY root, POSIX-separated — used by repository-owned modules. */
  repoRelPath?: RepoRelPath;
  hasRoutes?: boolean;
  envVars?: string[];
  ssr?: SsrMarkers;
  /** Source plugin that produced this module ('typescript' | 'python' | …). */
  sourcePluginId?: string;
}

export interface ExportSymbolNodeData {
  symbolKind?: SymbolKind;
  signature?: string;
  params?: ParamInfo[];
  returnType?: string;
  typeValue?: string;
  fields?: FieldInfo[];
  implementsInterfaces?: string[];
  calls?: string[];
  /** Distinct callee names before the producer cap; set only when it exceeds `calls.length`. */
  callsTotal?: number;
  privateMembers?: MemberInfo[];
  internals?: InternalInfo[];
  lineRange?: { start: number; end: number };
  isDefault?: boolean;
}

export type DomainTier = 'business' | 'feature' | 'layer' | 'technical';

/**
 * Weight classifies how "real" the domain is for surfacing in lists/search.
 * - 'heavy': normal domain (multiple modules, real business surface).
 * - 'lightweight': 1-2 modules, hidden from search/anomalies by default but kept in the graph
 *   so annotations survive. `includeLightweight` is a `searchGraph` argument; the `search_context`
 *   and `map_context` schemas strip it, so through those tools an exact name is what surfaces a
 *   lightweight tag.
 */
export type DomainWeight = 'heavy' | 'lightweight';

export interface DomainNodeData {
  tier?: DomainTier;
  weight?: DomainWeight;
  parent?: string;
  subdomains?: string[];
}

/**
 * Ecosystem label on a runtime-resource node.
 *
 * The pre-boundary `InfraResource.provider` is closed over the five ecosystems the built-in parsers
 * cover. A projected resource carries the label its own plugin owns, so the graph field is open in
 * the shape `InfraKind` and `InfraResourceKind` already use: the members are autocomplete, and the
 * graph stores, compares and reports the value without reading it.
 */
export type KnownInfraResourceProvider = InfraResource['provider'];
export type InfraResourceProvider = KnownInfraResourceProvider | (string & {});

export interface RuntimeResourceNodeData {
  handler?: string;
  envVars?: string[];
  triggers?: InfraTrigger[];
  envRefs?: InfraEnvRef[];
  /** Same as InfraResource.contentHash for this service's backing resource. */
  contentHash?: string;
  /** Resource kind from InfraResource (lambda/queue/table/...) — exposed so agents can filter. */
  kind?: InfraResourceKind;
  /**
   * The scope this resource's own logical-id references are confined to, as its plugin spelled it.
   * Opaque: resolution compares the strings and reads nothing else in them.
   */
  refScope?: string;
  /**
   * Ecosystem that declared the resource, as an opaque label. The pre-boundary IaC parsers spell one
   * of five, a projected resource spells whatever its plugin owns, and the graph stores and reports
   * the string without branching on its value.
   */
  provider?: InfraResourceProvider;
  /**
   * Ecosystem attributes a projecting plugin attached to the resource, opaque to the graph. Present
   * only on projected resources; the pre-boundary parsers lift the attributes they act on into the
   * typed fields above instead.
   */
  attributes?: Record<string, string>;
  /**
   * Service label this resource's kind was declared with, e.g. `sqs`. Opaque to the graph, carried
   * so a query layer reports what a plugin declared instead of reading an id's spelling.
   */
  service?: string;
  /** The resource's kind was declared to carry code the host resolves to a module. */
  hasCodeHandler?: boolean;
  /**
   * Repo-relative paths of the IaC documents declaring this resource. Scopes logical-id
   * resolution: a reference prefers a target its own document declares. More than one entry means
   * separate documents declare the same id and collapse onto this node.
   */
  declaredIn?: string[];
  /** Namespace attribute the declaring document carried. Absent when it declares none. */
  namespace?: string;
  /**
   * References the declaring document names that resolution refused to bind. Present when the
   * label matched candidates the reference's own scope does not reach.
   */
  unresolvedRefs?: UnresolvedInfraRef[];
}

/** A logical-id reference left unbound because scope did not single out one target. */
export interface UnresolvedInfraRef {
  /** Logical id named by the declaring document. */
  logicalId: string;
  /** Env var carrying the reference, when it came from one. */
  envVar?: string;
  /** `ambiguous`: several in-scope targets. `out-of-scope`: targets exist, none this scope reaches. */
  reason: 'ambiguous' | 'out-of-scope';
  /** Node ids that matched the label. */
  candidates: string[];
}

/** Template/rendered-surface node data. */
export interface TemplateNodeData {
  /** Repo-relative path of the template file. */
  relPath?: string;
  /** Same as TemplateFileInfo.contentHash for annotation freshness. */
  contentHash?: string;
  /** Template engine / dialect when known. Open string for cross-stack reuse. */
  engine?: string;
  /** Block names declared by the template body. */
  blocks?: string[];
}

export type NodeDataByType = {
  root: RootNodeData;
  package: PackageNodeData;
  module: ModuleNodeData;
  'export-symbol': ExportSymbolNodeData;
  'runtime-resource': RuntimeResourceNodeData;
  domain: DomainNodeData;
  template: TemplateNodeData;
};

/**
 * Discriminated union: data is typed by node type. Derived from `NodeDataByType` so the
 * node-type → data binding has a single source of truth — adding a member to `NODE_TYPES`
 * plus `NodeDataByType` extends this union automatically, with no parallel hand-written arm
 * to keep in sync. Each arm still carries a literal `type`, so `node.type === 'export-symbol'`
 * narrowing of `data` is preserved.
 */
export type GraphNode = {
  [T in NodeType]: { id: string; type: T; label: string; description: string; data?: NodeDataByType[T] };
}[NodeType];

/**
 * Runtime mirror of `NodeDataByType` field names. Used by graph-delta validation to reject `data`
 * keys foreign to a node type at the untrusted-input boundary (the per-type discriminant that the
 * `GraphNode` TS union only enforces at compile time). Kept exactly in sync with `NodeDataByType`
 * by `_assertNodeDataKeysExact` below — adding/removing a NodeData field is a compile error until
 * this map is updated, so there is no second source of truth to drift.
 */
export const NODE_DATA_KEYS = {
  root: [],
  package: ['path', 'version', 'sourcePluginId'],
  module: ['absPath', 'pkgRelPath', 'repoRelPath', 'hasRoutes', 'envVars', 'ssr', 'sourcePluginId'],
  'export-symbol': ['symbolKind', 'signature', 'params', 'returnType', 'typeValue', 'fields', 'implementsInterfaces', 'calls', 'callsTotal', 'privateMembers', 'internals', 'lineRange', 'isDefault'],
  'runtime-resource': ['handler', 'envVars', 'triggers', 'envRefs', 'contentHash', 'kind', 'refScope', 'provider', 'attributes', 'service', 'hasCodeHandler', 'declaredIn', 'namespace', 'unresolvedRefs'],
  domain: ['tier', 'weight', 'parent', 'subdomains'],
  template: ['relPath', 'contentHash', 'engine', 'blocks'],
} as const satisfies Record<NodeType, readonly string[]>;

// Compile-time guard: NODE_DATA_KEYS must list exactly the keys of each NodeDataByType entry (both
// directions). A missing or extra key makes the literal type below resolve to the error message
// string, which `= true` then fails to satisfy — pointing the build at the drift.
type _MissingNodeDataKey = { [T in NodeType]: Exclude<keyof NodeDataByType[T] & string, typeof NODE_DATA_KEYS[T][number]> }[NodeType];
type _ExtraNodeDataKey = { [T in NodeType]: Exclude<typeof NODE_DATA_KEYS[T][number], keyof NodeDataByType[T]> }[NodeType];
const _assertNodeDataKeysExact: [_MissingNodeDataKey, _ExtraNodeDataKey] extends [never, never] ? true
  : 'NODE_DATA_KEYS must exactly mirror NodeDataByType keys' = true;
void _assertNodeDataKeysExact;

/**
 * Source of a 'tagged' edge: 'path' = directory-derived, 'cluster' = import-graph,
 * 'pattern' = regex config, 'package' = package name.
 *
 * Only the path/cluster/pattern/package collector stamps this. Content domains, subdomain rollups,
 * infra tagging and infra→service propagation write tagged edges without it, so a partition over
 * this vocabulary must say what it does with an edge that carries no source.
 */
export const TAG_EDGE_SOURCES = ['path', 'package', 'cluster', 'pattern'] as const;
export type TagEdgeSource = (typeof TAG_EDGE_SOURCES)[number];

export interface GraphEdgeMetadata {
  /** For 'tagged' edges: where the tag came from. Used to distinguish primary (path/cluster) from secondary (pattern). */
  tagSource?: TagEdgeSource;
  /** For a barrel-redirected 'imports' edge (importer → defining leaf, resolved through a re-export
   * barrel): the imported names that routed here. The importer's own import record points at the
   * barrel, not the leaf, so this carries the names the reverse-by-export query filters on. */
  usedNames?: string[];
  /** For an 'imports' edge: true iff every contributing import between these two modules is
   * `import type` (erased at build). Architecture detectors treat coupling as runtime-only and
   * filter these out (see `isRuntimeImportEdge`); dependency-impact queries keep them. Absent
   * (undefined) means at least one value import routed here → a real runtime edge. */
  isTypeOnly?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  metadata?: GraphEdgeMetadata;
}

export interface GraphDelta {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface RepositoryGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  outEdges: Map<string, GraphEdge[]>;
  inEdges: Map<string, GraphEdge[]>;
  byType: Map<NodeType, Set<string>>;
  /** Adaptive `hub`-tag importer threshold (p95 of import in-degree); memoized on first inspect. */
  hubInDegreeThreshold?: number;
}
