import { canonicalJson } from '@repovine/plugin-sdk';
import type {
  Declared,
  EcosystemDirFact,
  PluginOwnerIdentity,
  PluginValueDeclaration,
  ResourceKindDeclaration,
  StampedDeclarationCatalog,
  TriggerEntryKind,
  TriggerTypeDeclaration,
} from '@repovine/plugin-sdk';
import { compareCodeUnits } from '../platform/ordering.js';

/**
 * The declaration catalog for one build.
 *
 * Declarations are the JSON half of a plugin: the host reads them from `package.json#repovine`
 * before any plugin code runs, and they outlive a disabled capability. This module merges every
 * active plugin's stamped catalog into one per-run table, so the facts a build acts on are the facts
 * that build's plugin set declared — a plugin removed from the config takes its declarations with
 * it, and nothing survives into the next build in a process that serves many.
 *
 * MERGE POLICY
 *
 * Each family has a composite key and an effect: the part the host acts on. Two declarations under
 * one key with the same effect are one record with both owners recorded; two with different effects
 * are a conflict, and a conflict drops both — no last-write-wins, and the diagnostic names both
 * owners and both effects. Key order and plugin registration order are never inputs.
 *
 * The catalog is plain serializable data: it crosses the Stage 2 worker boundary and the snapshot
 * cache with the facts it describes.
 */

/* ---------------------------------- keys ---------------------------------- */

export const DECLARATION_FAMILIES = ['dir', 'value', 'resource-kind', 'trigger-type'] as const;
export type DeclarationFamily = typeof DECLARATION_FAMILIES[number];

/** Textual key for one dir declaration. Also the spelling `plugins.retract` accepts. */
export function dirKey(name: string): string {
  return `dir:${name}`;
}

export function valueKey(axis: string, value: string): string {
  return `value:${axis}=${value}`;
}

export function resourceKindKey(
  declaration: Pick<ResourceKindDeclaration, 'namespace' | 'provider' | 'kind'>,
): string {
  return `resource-kind:${declaration.namespace}/${declaration.provider}/${declaration.kind}`;
}

/** A trigger type may be global, so an absent namespace/provider is spelled `*` rather than empty. */
export function triggerTypeKey(
  declaration: Pick<TriggerTypeDeclaration, 'type' | 'namespace' | 'provider'>,
): string {
  return `trigger-type:${declaration.namespace ?? '*'}/${declaration.provider ?? '*'}/${declaration.type}`;
}

/* --------------------------------- records --------------------------------- */

/**
 * One accepted declaration key, with every plugin that declared it.
 *
 * `effect` is what the host acts on and is identical across `declarations` by construction — a
 * differing effect is a conflict and never reaches a record. The declaring entries are kept whole,
 * so a reader can report which package stated a fact and why.
 */
export interface CatalogRecord<TDecl> {
  key: string;
  family: DeclarationFamily;
  effect: Record<string, unknown>;
  declarations: Declared<TDecl>[];
}

export interface DeclarationConflict {
  key: string;
  family: DeclarationFamily;
  /** Both sides, in key order: owner identity and the effect it stated. */
  sides: Array<{ declaredBy: PluginOwnerIdentity; effect: Record<string, unknown> }>;
}

/**
 * Two declarations the composite key separates but a single-component lookup cannot.
 *
 * The pre-boundary registries still key resource metadata by `kind` and trigger metadata by `type`.
 * When two composite keys narrow onto one component with different effects, the narrowed lookup
 * answers nothing and says so here, instead of returning whichever declaration arrived first.
 */
export interface CatalogAmbiguity {
  family: DeclarationFamily;
  /** The single component the lookup has: a resource `kind` or a trigger `type`. */
  component: string;
  /** Composite keys that narrow onto it. */
  keys: string[];
}

export interface RetractionOutcome {
  selector: string;
  /** Keys the selector removed. Empty when it matched nothing. */
  removed: string[];
}

export interface DeclarationCatalog {
  dirs: CatalogRecord<EcosystemDirFact>[];
  values: CatalogRecord<PluginValueDeclaration>[];
  resourceKinds: CatalogRecord<ResourceKindDeclaration>[];
  triggerTypes: CatalogRecord<TriggerTypeDeclaration>[];
  conflicts: DeclarationConflict[];
  ambiguities: CatalogAmbiguity[];
  retractions: RetractionOutcome[];
}

export function emptyDeclarationCatalog(): DeclarationCatalog {
  return {
    dirs: [],
    values: [],
    resourceKinds: [],
    triggerTypes: [],
    conflicts: [],
    ambiguities: [],
    retractions: [],
  };
}

/* ---------------------------------- effects ---------------------------------- */

/** What the host does with a claimed directory name. `because` is evidence, not effect. */
function dirEffect(declaration: EcosystemDirFact): Record<string, unknown> {
  return { role: declaration.role };
}

/** What a value declaration adds to an axis. `because` is evidence, not effect. */
function valueEffect(declaration: PluginValueDeclaration): Record<string, unknown> {
  return { label: declaration.label ?? null };
}

function resourceKindEffect(declaration: ResourceKindDeclaration): Record<string, unknown> {
  return {
    service: declaration.service ?? null,
    hasCodeHandler: declaration.hasCodeHandler ?? null,
  };
}

function triggerTypeEffect(declaration: TriggerTypeDeclaration): Record<string, unknown> {
  return {
    isStreamLike: declaration.isStreamLike ?? null,
    entrypointKind: declaration.entrypointKind ?? null,
  };
}

/* ---------------------------------- merge ---------------------------------- */

interface FamilySpec<TDecl> {
  family: DeclarationFamily;
  key(declaration: TDecl): string;
  effect(declaration: TDecl): Record<string, unknown>;
}

const DIR_SPEC: FamilySpec<EcosystemDirFact> = {
  family: 'dir',
  key: declaration => dirKey(declaration.name),
  effect: dirEffect,
};

const VALUE_SPEC: FamilySpec<PluginValueDeclaration> = {
  family: 'value',
  key: declaration => valueKey(declaration.axis, declaration.value),
  effect: valueEffect,
};

const RESOURCE_KIND_SPEC: FamilySpec<ResourceKindDeclaration> = {
  family: 'resource-kind',
  key: resourceKindKey,
  effect: resourceKindEffect,
};

const TRIGGER_TYPE_SPEC: FamilySpec<TriggerTypeDeclaration> = {
  family: 'trigger-type',
  key: triggerTypeKey,
  effect: triggerTypeEffect,
};

function ownerOrder(a: PluginOwnerIdentity, b: PluginOwnerIdentity): number {
  return compareCodeUnits(
    `${a.pluginId}\0${a.packageName}\0${a.packageVersion}`,
    `${b.pluginId}\0${b.packageName}\0${b.packageVersion}`,
  );
}

/**
 * Merge one family across plugins.
 *
 * The input is read into a key-addressed table before anything is decided, so the outcome for a key
 * depends on the set of declarations under it and not on which plugin was read first. A key whose
 * declarations disagree yields no record at all: dropping both sides is what makes a conflict
 * visible to the build instead of resolvable by reordering the config.
 */
function mergeFamily<TDecl>(
  spec: FamilySpec<TDecl>,
  declarations: ReadonlyArray<Declared<TDecl>>,
  conflicts: DeclarationConflict[],
): CatalogRecord<TDecl>[] {
  const byKey = new Map<string, Array<Declared<TDecl>>>();
  for (const declaration of declarations) {
    const key = spec.key(declaration);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(declaration);
    else byKey.set(key, [declaration]);
  }

  const records: CatalogRecord<TDecl>[] = [];
  for (const key of [...byKey.keys()].sort(compareCodeUnits)) {
    const bucket = [...byKey.get(key)!].sort((a, b) => ownerOrder(a.declaredBy, b.declaredBy));
    const effects = new Map<string, Array<Declared<TDecl>>>();
    for (const declaration of bucket) {
      const canonical = canonicalJson(spec.effect(declaration));
      const same = effects.get(canonical);
      if (same) same.push(declaration);
      else effects.set(canonical, [declaration]);
    }

    if (effects.size > 1) {
      conflicts.push({
        key,
        family: spec.family,
        sides: bucket.map(declaration => ({
          declaredBy: declaration.declaredBy,
          effect: spec.effect(declaration),
        })),
      });
      continue;
    }

    records.push({
      key,
      family: spec.family,
      effect: spec.effect(bucket[0]),
      declarations: bucket,
    });
  }
  return records;
}

/* -------------------------------- narrowing -------------------------------- */

/**
 * Component a composite key narrows onto for the pre-boundary single-key lookups.
 *
 * Resource metadata is looked up by `kind` and trigger metadata by `type` until the registries take
 * the composite key. Narrowing is computed once here, with every collision named, so the read path
 * never has to choose between two declarations.
 */
function narrowByComponent<TDecl>(
  records: ReadonlyArray<CatalogRecord<TDecl>>,
  component: (record: CatalogRecord<TDecl>) => string,
  ambiguities: CatalogAmbiguity[],
): Array<[string, Record<string, unknown>]> {
  const byComponent = new Map<string, CatalogRecord<TDecl>[]>();
  for (const record of records) {
    const name = component(record);
    const bucket = byComponent.get(name);
    if (bucket) bucket.push(record);
    else byComponent.set(name, [record]);
  }

  const out: Array<[string, Record<string, unknown>]> = [];
  for (const name of [...byComponent.keys()].sort(compareCodeUnits)) {
    const bucket = byComponent.get(name)!;
    const distinct = new Set(bucket.map(record => canonicalJson(record.effect)));
    if (distinct.size > 1) {
      ambiguities.push({
        family: bucket[0].family,
        component: name,
        keys: bucket.map(record => record.key).sort(compareCodeUnits),
      });
      continue;
    }
    out.push([name, bucket[0].effect]);
  }
  return out;
}

/* -------------------------------- retraction -------------------------------- */

function applyRetractions(
  catalog: DeclarationCatalog,
  selectors: readonly string[],
): void {
  for (const selector of [...selectors].sort(compareCodeUnits)) {
    const removed: string[] = [];
    const drop = <T>(records: CatalogRecord<T>[]): CatalogRecord<T>[] =>
      records.filter(record => {
        if (record.key !== selector) return true;
        removed.push(record.key);
        return false;
      });
    catalog.dirs = drop(catalog.dirs);
    catalog.values = drop(catalog.values);
    catalog.resourceKinds = drop(catalog.resourceKinds);
    catalog.triggerTypes = drop(catalog.triggerTypes);
    catalog.retractions.push({ selector, removed: removed.sort(compareCodeUnits) });
  }
}

/* ---------------------------------- build ---------------------------------- */

export interface BuildDeclarationCatalogInput {
  /** One stamped catalog per active plugin, in any order. */
  catalogs: readonly StampedDeclarationCatalog[];
  /** Keys `plugins.retract` names. A selector that matches nothing is reported, not silent. */
  retract?: readonly string[];
}

/**
 * Build the catalog for one run.
 *
 * Retraction runs after the merge, so a retracted key is removed from a decided catalog rather than
 * from one plugin's input — a fact two plugins declare leaves on one selector, and the outcome does
 * not depend on which plugin is read.
 */
export function buildDeclarationCatalog(input: BuildDeclarationCatalogInput): DeclarationCatalog {
  const conflicts: DeclarationConflict[] = [];
  const catalog: DeclarationCatalog = {
    dirs: mergeFamily(DIR_SPEC, input.catalogs.flatMap(c => c.dirs), conflicts),
    values: mergeFamily(VALUE_SPEC, input.catalogs.flatMap(c => c.values), conflicts),
    resourceKinds: mergeFamily(RESOURCE_KIND_SPEC, input.catalogs.flatMap(c => c.resourceKinds), conflicts),
    triggerTypes: mergeFamily(TRIGGER_TYPE_SPEC, input.catalogs.flatMap(c => c.triggerTypes), conflicts),
    conflicts: conflicts.sort((a, b) => compareCodeUnits(a.key, b.key)),
    ambiguities: [],
    retractions: [],
  };
  applyRetractions(catalog, input.retract ?? []);
  return catalog;
}

/* ---------------------------------- reads ---------------------------------- */

interface NarrowedLookups {
  resourceKindByKind: Map<string, Record<string, unknown>>;
  triggerTypeByType: Map<string, Record<string, unknown>>;
  ambiguities: CatalogAmbiguity[];
}

/**
 * Narrowed lookups are derived, not stored: a catalog crosses the worker boundary and the cache as
 * data, and a Map does neither. Memoized per catalog object so a build derives them once.
 */
const narrowedByCatalog = new WeakMap<DeclarationCatalog, NarrowedLookups>();

function narrowed(catalog: DeclarationCatalog): NarrowedLookups {
  const cached = narrowedByCatalog.get(catalog);
  if (cached) return cached;
  const ambiguities: CatalogAmbiguity[] = [];
  const derived: NarrowedLookups = {
    resourceKindByKind: new Map(
      narrowByComponent(catalog.resourceKinds, record => record.declarations[0].kind, ambiguities),
    ),
    triggerTypeByType: new Map(
      narrowByComponent(catalog.triggerTypes, record => record.declarations[0].type, ambiguities),
    ),
    ambiguities,
  };
  narrowedByCatalog.set(catalog, derived);
  return derived;
}

/** Collisions the single-component lookups cannot answer. Derived from the catalog on first read. */
export function catalogAmbiguities(catalog: DeclarationCatalog): readonly CatalogAmbiguity[] {
  return narrowed(catalog).ambiguities;
}

export interface CatalogResourceKindMeta {
  service?: string;
  hasCodeHandler?: boolean;
}

export interface CatalogTriggerTypeMeta {
  isStreamLike?: boolean;
  entrypointKind?: TriggerEntryKind;
}

/** Resource metadata a plugin declared for this `kind`, or undefined when none did unambiguously. */
export function catalogResourceKindMeta(
  catalog: DeclarationCatalog,
  kind: string,
): CatalogResourceKindMeta | undefined {
  const effect = narrowed(catalog).resourceKindByKind.get(kind);
  if (!effect) return undefined;
  return {
    ...(effect.service === null ? {} : { service: effect.service as string }),
    ...(effect.hasCodeHandler === null ? {} : { hasCodeHandler: effect.hasCodeHandler as boolean }),
  };
}

/** Trigger metadata a plugin declared for this `type`, or undefined when none did unambiguously. */
export function catalogTriggerTypeMeta(
  catalog: DeclarationCatalog,
  type: string,
): CatalogTriggerTypeMeta | undefined {
  const effect = narrowed(catalog).triggerTypeByType.get(type);
  if (!effect) return undefined;
  return {
    ...(effect.isStreamLike === null ? {} : { isStreamLike: effect.isStreamLike as boolean }),
    ...(effect.entrypointKind === null ? {} : { entrypointKind: effect.entrypointKind as TriggerEntryKind }),
  };
}

/**
 * Identity of everything the catalog decides, for the snapshot-reuse fingerprint.
 *
 * Folds the accepted keys with their effects and owners, plus what was refused and retracted: a
 * build that dropped a conflicting declaration produced different facts than one that accepted it,
 * so the two must not share a cache entry.
 */
export function declarationCatalogIdentity(catalog: DeclarationCatalog): unknown {
  const foldRecords = <T>(records: ReadonlyArray<CatalogRecord<T>>): unknown[] =>
    records.map(record => [
      record.key,
      record.effect,
      record.declarations.map(declaration => [
        declaration.declaredBy.pluginId,
        declaration.declaredBy.packageName,
        declaration.declaredBy.packageVersion,
      ]),
    ]);
  return {
    dirs: foldRecords(catalog.dirs),
    values: foldRecords(catalog.values),
    resourceKinds: foldRecords(catalog.resourceKinds),
    triggerTypes: foldRecords(catalog.triggerTypes),
    conflicts: catalog.conflicts.map(conflict => [conflict.key, conflict.sides.length]),
    retractions: catalog.retractions.map(retraction => [retraction.selector, retraction.removed]),
  };
}
