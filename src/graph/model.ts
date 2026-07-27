/**
 * Core repository-graph data model: the node/edge taxonomy, per-type node data, the graph container,
 * and the stage1 facts snapshot. Split out of `src/types.ts`, which re-exports it for compatibility.
 */
import type {
  FieldInfo,
  InfraEnvRef,
  InfraModuleInfo,
  InfraResourceKind,
  InfraTrigger,
  InternalInfo,
  MemberInfo,
  ModuleInfo,
  PackageInfo,
  ParamInfo,
  SsrMarkers,
  SymbolKind,
} from '@repovine/plugin-sdk';

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
  /** Repo-relative candidates refused by containment because they resolve outside the repository.
   * They are absent from `modules`, so the graph reports why rather than losing them silently.
   * Recomputed by every discovery pass, never reused from a cached snapshot. */
  outsideRepoPaths?: string[];
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
  filePath?: string;
  relativeFilePath?: string;
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
 *   so annotations survive. Surfaced only by direct name or explicit includeLightweight flag.
 */
export type DomainWeight = 'heavy' | 'lightweight';

export interface DomainNodeData {
  tier?: DomainTier;
  weight?: DomainWeight;
  parent?: string;
  subdomains?: string[];
}

export interface RuntimeResourceNodeData {
  handler?: string;
  envVars?: string[];
  triggers?: InfraTrigger[];
  envRefs?: InfraEnvRef[];
  /** Same as InfraResource.contentHash for this service's backing resource. */
  contentHash?: string;
  /** Resource kind from InfraResource (lambda/queue/table/...) — exposed so agents can filter. */
  kind?: InfraResourceKind;
  /** Original Kubernetes manifest kind before it is collapsed into an InfraResource kind. */
  k8sKind?: string;
  /** Provider that declared the resource (aws/k8s/terraform/vercel/generic). */
  provider?: 'aws' | 'k8s' | 'generic' | 'terraform' | 'vercel';
  /**
   * Repo-relative paths of the IaC documents declaring this resource. Scopes logical-id
   * resolution: a reference prefers a target its own document declares. More than one entry means
   * separate documents declare the same id and collapse onto this node.
   */
  declaredIn?: string[];
  /** Kubernetes namespace from the manifest. Absent when the manifest declares none. */
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
  module: ['filePath', 'relativeFilePath', 'hasRoutes', 'envVars', 'ssr', 'sourcePluginId'],
  'export-symbol': ['symbolKind', 'signature', 'params', 'returnType', 'typeValue', 'fields', 'implementsInterfaces', 'calls', 'callsTotal', 'privateMembers', 'internals', 'lineRange', 'isDefault'],
  'runtime-resource': ['handler', 'envVars', 'triggers', 'envRefs', 'contentHash', 'kind', 'k8sKind', 'provider', 'declaredIn', 'namespace', 'unresolvedRefs'],
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
