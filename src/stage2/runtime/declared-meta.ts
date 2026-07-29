import type { ResourceKindMeta, TriggerTypeMeta } from '@repovine/plugin-sdk';
import { getResourceKindMeta, getTriggerTypeMeta } from '../../stage1/iac/registry.js';
import {
  catalogResourceKindMeta,
  catalogTriggerTypeMeta,
  type DeclarationCatalog,
} from '../../plugins/declaration-catalog.js';

/**
 * Metadata a resource kind or a trigger type was declared with.
 *
 * Two sources answer today. The per-run declaration catalog carries what this build's manifests
 * declared; it travels with the facts, so it reaches composition inside the Stage 2 worker isolate,
 * where a process-global registry populated on the main thread never arrived. The pre-boundary
 * registry carries what the built-in IaC descriptors register at module load.
 *
 * The catalog answers first, because it is the per-run fact and the registry is process state. This
 * pairing is temporary: stage 6 moves the built-ins onto declarations and the registry read below
 * goes with them.
 */

export function resolveResourceKindMeta(
  catalog: DeclarationCatalog | undefined,
  kind: string,
): ResourceKindMeta | undefined {
  const declared = catalog === undefined ? undefined : catalogResourceKindMeta(catalog, kind);
  if (declared !== undefined) {
    return declared.hasCodeHandler === undefined ? {} : { hasCodeHandler: declared.hasCodeHandler };
  }
  return getResourceKindMeta(kind);
}

export function resolveTriggerTypeMeta(
  catalog: DeclarationCatalog | undefined,
  type: string,
): TriggerTypeMeta | undefined {
  const declared = catalog === undefined ? undefined : catalogTriggerTypeMeta(catalog, type);
  if (declared !== undefined) {
    return {
      ...(declared.isStreamLike === undefined ? {} : { isStreamLike: declared.isStreamLike }),
      ...(declared.entrypointKind === undefined ? {} : { entrypointKind: declared.entrypointKind }),
    };
  }
  return getTriggerTypeMeta(type);
}
