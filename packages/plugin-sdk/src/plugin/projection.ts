import type { JsonValue } from './json.js';
import type { PluginOwnerIdentity } from './declarations.js';
import type { ResourceIdentity } from './resource-identity.js';
import type { HostPath, RepoRelPath } from '../path-contract.js';

/**
 * The public projection contract: how a plugin turns its own facts into canonical repository
 * semantics without touching the graph.
 *
 * A contributor receives an immutable fact view and returns batches. It never sees a mutable graph,
 * a host map or a host function, and it never spells a graph node id: every reference is one of
 * three structured forms the host resolves against a global index built from all accepted batches.
 * The internal ontology — the graph model, its node types and its edge kinds — stays unexported.
 */

/* --------------------------------- references --------------------------------- */

export const PROJECTION_REF_TYPES = ['module', 'resource', 'extension'] as const;
export type ProjectionRefType = typeof PROJECTION_REF_TYPES[number];

/**
 * A reference to something the graph will contain.
 *
 * A module is addressed by the id the host already minted. A resource is addressed by the identity
 * components its owner computed, never by the final minted id — the host does that minting. An
 * extension is addressed by its owner triple, which is the one place a `pluginId` written by a
 * plugin is meaningful: it names the target of a cross-plugin reference, and the host checks it
 * against the global index.
 */
export type ProjectionRef =
  | { type: 'module'; moduleId: string }
  | { type: 'resource'; namespace: string; localKey: string }
  | { type: 'extension'; pluginId: string; schema: string; localKey: string };

/**
 * Addresses a versioned canonical or namespaced fact schema. It names a schema, never a producer,
 * so a contributor reads the same facts regardless of which plugin published them.
 */
export interface ProjectionFactSelector {
  schema: string;
  field?: string;
}

/* ------------------------------- contributions ------------------------------- */

/**
 * Canonical link relations a projector may state. The set is deliberately small: these are the
 * relations every consumer already understands. A relation that has no general meaning yet belongs
 * in a namespaced extension, and promoting one is a joint SDK/host decision.
 */
export const SEMANTIC_LINK_RELATIONS = [
  /** The source writes to, or emits into, the target. */
  'publishes',
  /** The source reads from, or is invoked by, the target. */
  'consumes',
  /** The source is deployed as, or backed by, the target. */
  'binds-to',
  /** The source reads the target through configuration rather than a direct call. */
  'uses-env',
  /** The source forwards a request to the target. */
  'routes-to',
  /**
   * The target is the build document the source is produced from.
   *
   * Distinct from `binds-to`, which says the source *runs as* the target. A service and the build
   * recipe it was built from are not the same artifact, and the relation has to survive the source
   * being redeployed without the recipe changing.
   */
  'builds-from',
] as const;
export type SemanticLinkRelation = typeof SEMANTIC_LINK_RELATIONS[number];

/**
 * One runtime resource. `namespace` and `localKey` are the identity components; the host encodes
 * them and mints the final id, so the id format never depends on plugin cooperation.
 * `provider` and `kind` are opaque labels the host stores, compares and reports without branching.
 */
export interface RuntimeResourceContribution {
  namespace: string;
  localKey: string;
  provider: string;
  kind: string;
  label?: string;
  /** Fingerprint of this resource's own declaration fragment, not of the file that carried it. */
  contentHash: string;
  attributes?: Record<string, string>;
  envVars?: string[];
}

export interface SemanticLinkContribution {
  from: ProjectionRef;
  to: ProjectionRef;
  relation: SemanticLinkRelation;
  /** One line of evidence carried into diagnostics. */
  because?: string;
}

/* --------------------------------- entrypoints --------------------------------- */

/**
 * Canonical entrypoint kinds. A kind describes the shape of the execution start, never the language
 * or framework that produced it, so the same normalised route fact from any source plugin becomes
 * the same entrypoint.
 */
export const ENTRYPOINT_CONTRIBUTION_KINDS = [
  'api-route',
  'file-route',
  'ui-route',
  'conditional-render',
  'resource-trigger',
] as const;
export type EntrypointContributionKind = typeof ENTRYPOINT_CONTRIBUTION_KINDS[number];

export interface ApiRouteEntrypointContribution {
  kind: 'api-route';
  moduleRef: { type: 'module'; moduleId: string };
  path: string;
  method: string;
  label?: string;
}

/** A route the filesystem layout declares (a route file rather than a route expression). */
export interface FileRouteEntrypointContribution {
  kind: 'file-route';
  moduleRef: { type: 'module'; moduleId: string };
  path: string;
  /** Layout role of the file, e.g. `page`, `route`. Opaque to the host. */
  fileType: string;
  method?: string;
  label?: string;
}

export interface UiRouteEntrypointContribution {
  kind: 'ui-route';
  moduleRef: { type: 'module'; moduleId: string };
  path: string;
  label?: string;
}

export interface ConditionalRenderEntrypointContribution {
  kind: 'conditional-render';
  moduleRef: { type: 'module'; moduleId: string };
  component: string;
  label?: string;
}

/** An execution start a deployed resource owns: a queue consumer, a schedule, an API stage. */
export interface ResourceTriggerEntrypointContribution {
  kind: 'resource-trigger';
  resourceRef: { type: 'resource'; namespace: string; localKey: string };
  /** Trigger kind as declared in the trigger-type catalog. */
  triggerKind: string;
  /** Stable discriminator within the resource, e.g. the trigger name or its path. */
  discriminator: string;
  /** The module this trigger dispatches into, when the plugin resolved one. */
  handlerRef?: { type: 'module'; moduleId: string };
  label?: string;
}

export type EntrypointContribution =
  | ApiRouteEntrypointContribution
  | FileRouteEntrypointContribution
  | UiRouteEntrypointContribution
  | ConditionalRenderEntrypointContribution
  | ResourceTriggerEntrypointContribution;

/* --------------------------------- extensions --------------------------------- */

/**
 * A fact with no canonical meaning yet. It is stored beside the graph and echoed by generic tools
 * with its provenance; no traversal, dependency or architecture algorithm interprets it.
 *
 * The contribution carries no owner field: the host stamps `pluginId` from package identity, so a
 * payload cannot claim to belong to another plugin.
 */
export interface NamespacedExtensionContribution {
  /** Versioned namespaced schema id, `<owner>/<name>@<version>`. */
  schema: string;
  /** Unique within `(pluginId, schema)`. */
  localKey: string;
  subjectRef?: ProjectionRef;
  payload: JsonValue;
}

/** Where one accepted contribution came from. Every field is host-stamped. */
export interface ContributionProvenance extends PluginOwnerIdentity {
  contributorId: string;
  batchId: string;
}

/** A stored extension: the contribution after the host stamped ownership and provenance. */
export interface ExtensionRecord {
  pluginId: string;
  schema: string;
  localKey: string;
  subjectRef?: ProjectionRef;
  payload: JsonValue;
  provenance: ContributionProvenance;
}

/* ----------------------------- batches and contributors ----------------------------- */

export interface PluginProjectionDelta {
  resources?: RuntimeResourceContribution[];
  links?: SemanticLinkContribution[];
  entrypoints?: EntrypointContribution[];
  extensions?: NamespacedExtensionContribution[];
}

/**
 * The unit of atomicity. A rejected batch contributes nothing, and the contributor's other batches
 * are unaffected — usually one module or one infrastructure document each.
 *
 * `batchId` is unique within `(pluginId, contributorId)`.
 */
export interface PluginProjectionBatch {
  batchId: string;
  delta: PluginProjectionDelta;
}

/** One module as a projector sees it: location and ownership by package, with no producer identity. */
export interface ReadonlyModuleFact {
  moduleId: string;
  packageName: string;
  /** Repo-root-relative POSIX path. */
  repoRelPath: RepoRelPath;
}

/**
 * An infrastructure document the graph holds, with the id the engine minted for it.
 *
 * A projector that links to a build or deployment document needs its node id, and the id format is
 * the engine's to spell — a plugin that assembled `infra:<kind>:<path>` itself would be reproducing
 * a minting rule rather than reading one. `kind` is the parser's own, so a plugin asks for the
 * documents of an ecosystem it understands.
 */
export interface ReadonlyInfraModuleFact {
  /** The `kind` the parser that produced this document declared. */
  kind: string;
  /** Engine-minted node id. */
  moduleId: string;
  /** Repo-root-relative POSIX path. */
  repoRelPath: RepoRelPath;
}

/** Which infrastructure documents to read. Omitting `kind` returns every one of them. */
export interface InfraModuleSelector {
  kind?: string;
}

/** One fact published under a declared schema. */
export interface ReadonlyFactRecord {
  schema: string;
  subjectRef: ProjectionRef;
  value: JsonValue;
}

/**
 * The immutable view a contributor reads. It answers questions; it hands out no host map, no host
 * function and no graph.
 */
export interface ReadonlyFactView {
  hasModule(moduleId: string): boolean;
  moduleIds(): readonly string[];
  module(moduleId: string): ReadonlyModuleFact | undefined;
  /**
   * Whether the graph already holds this runtime resource.
   *
   * The guard a link needs when it points at a resource no batch contributes — one an IaC producer
   * emitted, or one a repository's own configuration excluded. A reference that resolves to nothing
   * takes its whole batch with it, so a projector asks first and drops the link, not the topology.
   */
  hasResource(identity: ResourceIdentity): boolean;
  /**
   * Infrastructure documents the graph holds, in a stable order.
   *
   * The read a projector needs to link a resource to a build or deployment document: it hands back
   * the engine-minted id beside the path, so the plugin matches on the path it understands and
   * references the id it was given.
   */
  infraModules(selector?: InfraModuleSelector): readonly ReadonlyInfraModuleFact[];
  /** Facts matching a schema selector, in a stable order. */
  select(selector: ProjectionFactSelector): readonly ReadonlyFactRecord[];
}

export interface ReadonlyProjectionInput {
  /** Absolute repository root. Path fields in facts are relative to it and POSIX-spelled. */
  repoRoot: HostPath;
  facts: ReadonlyFactView;
}

/**
 * A projector: declared fact needs in, batches out.
 *
 * `requires` names schemas, never other contributors. Execution order carries no data — a
 * contributor that needs another plugin's semantics reads them from the fact view, and a reference
 * to another contributor's output is resolved through the global index after every batch is in.
 */
export interface ProjectionContributor {
  id: string;
  requires?: readonly ProjectionFactSelector[];
  project(input: ReadonlyProjectionInput): readonly PluginProjectionBatch[];
}
