import { canonicalJson, makeResourceId, repoRelativePosix } from '@repovine/plugin-sdk';
import type {
  InfraModuleSelector,
  ProjectionFactSelector,
  ReadonlyFactRecord,
  ReadonlyFactView,
  ReadonlyInfraModuleFact,
  ReadonlyModuleFact,
  ResourceIdentity,
} from '@repovine/plugin-sdk';
import type { RepositoryFactsSnapshot } from '../../types.js';
import { compareCodeUnits } from '../../platform/ordering.js';

/**
 * The immutable view a contributor reads.
 *
 * It answers questions and hands out no host map, no host function and no graph. Facts are selected
 * by schema, never by producer: a contributor that asked "who made this" would be reading the
 * ecosystem it is supposed to be independent of, and `ReadonlyFactRecord` carries no producer id to
 * read.
 */
export interface FactViewInput {
  snapshot: RepositoryFactsSnapshot;
  /** Facts published under declared schemas. Empty until a producer publishes one. */
  facts?: readonly ReadonlyFactRecord[];
  /** Minted ids of the runtime resources the graph already holds. */
  resourceIds?: ReadonlySet<string>;
}

function recordOrder(a: ReadonlyFactRecord, b: ReadonlyFactRecord): number {
  return compareCodeUnits(
    `${a.schema}\0${canonicalJson(a.subjectRef)}\0${canonicalJson(a.value)}`,
    `${b.schema}\0${canonicalJson(b.subjectRef)}\0${canonicalJson(b.value)}`,
  );
}

export function createFactView(input: FactViewInput): ReadonlyFactView {
  const modules = new Map<string, ReadonlyModuleFact>();
  for (const mod of input.snapshot.modules) {
    modules.set(mod.id, {
      moduleId: mod.id,
      packageName: mod.packageName,
      repoRelPath: repoRelativePosix(input.snapshot.repoRoot, mod.absPath),
    });
  }
  const moduleIds = [...modules.keys()].sort(compareCodeUnits);

  // Infrastructure documents, carrying the id the engine minted. Sorted by that id so a projector
  // reading them twice gets the same order, and scan order is not a channel.
  const infraModules: ReadonlyInfraModuleFact[] = (input.snapshot.infraModules ?? [])
    .map(mod => ({ kind: mod.kind, moduleId: mod.id, repoRelPath: mod.repoRelPath }))
    .sort((a, b) => compareCodeUnits(a.moduleId, b.moduleId));

  const bySchema = new Map<string, ReadonlyFactRecord[]>();
  for (const record of [...(input.facts ?? [])].sort(recordOrder)) {
    const bucket = bySchema.get(record.schema);
    if (bucket) bucket.push(record);
    else bySchema.set(record.schema, [record]);
  }

  const resourceIds = input.resourceIds ?? new Set<string>();

  return {
    hasModule: (moduleId: string): boolean => modules.has(moduleId),
    moduleIds: (): readonly string[] => moduleIds,
    module: (moduleId: string): ReadonlyModuleFact | undefined => modules.get(moduleId),
    hasResource: (identity: ResourceIdentity): boolean => resourceIds.has(makeResourceId(identity)),
    infraModules: (selector?: InfraModuleSelector): readonly ReadonlyInfraModuleFact[] =>
      selector?.kind === undefined
        ? infraModules
        : infraModules.filter(mod => mod.kind === selector.kind),
    select: (selector: ProjectionFactSelector): readonly ReadonlyFactRecord[] => {
      const matches = bySchema.get(selector.schema) ?? [];
      if (selector.field === undefined) return matches;
      return matches.filter(record =>
        typeof record.value === 'object'
        && record.value !== null
        && !Array.isArray(record.value)
        && selector.field! in record.value);
    },
  };
}
