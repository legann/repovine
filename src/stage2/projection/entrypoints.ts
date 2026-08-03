import { ENTRYPOINT_CONTRIBUTION_KINDS, makeResourceId } from '@repovine/plugin-sdk';
import type { EntrypointContribution, EntrypointContributionKind } from '@repovine/plugin-sdk';
import type { EntrypointFragment } from '../../interpreter/types.js';

/**
 * Canonical entrypoint contribution → the fragment shape every entrypoint reader already consumes.
 *
 * A contribution kind describes the shape of the execution start, never the language or framework
 * behind it, so the same normalised route from any plugin lands on the same fragment. The fragment
 * `kind` vocabulary is the public one (`api`, `route`, …) and is narrower than the contribution
 * vocabulary: two contribution kinds that start execution the same way share one fragment kind.
 */
const FRAGMENT_KINDS: Readonly<Record<Exclude<EntrypointContributionKind, 'resource-trigger'>, string>> =
  Object.freeze({
    'api-route': 'api',
    'file-route': 'route',
    'ui-route': 'route',
    'conditional-render': 'conditional-render',
  });

/**
 * Contribution kinds the converter answers for. Total over the contract by construction: a kind
 * added to `ENTRYPOINT_CONTRIBUTION_KINDS` without an arm below is a compile error.
 */
export const CONVERTED_ENTRYPOINT_KINDS: readonly EntrypointContributionKind[] =
  ENTRYPOINT_CONTRIBUTION_KINDS;

/**
 * Stable id for a projected entrypoint.
 *
 * The spelling matches the ids the pre-boundary layers mint for the same execution starts, so a
 * projected route and the route a built-in produced for the same module and path are one entry
 * rather than two that differ by producer.
 */
export function projectedEntrypointId(contribution: EntrypointContribution): string {
  switch (contribution.kind) {
    case 'api-route':
      return `entrypoint:api:${contribution.moduleRef.moduleId}:${contribution.path}:${contribution.method}`;
    case 'file-route': {
      const method = contribution.method ? `:${contribution.method}` : '';
      return `entrypoint:file:${contribution.moduleRef.moduleId}:${contribution.path}:${contribution.fileType}${method}`;
    }
    case 'ui-route':
      return `entrypoint:route:${contribution.moduleRef.moduleId}:${contribution.path}`;
    case 'conditional-render':
      return `entrypoint:conditional:${contribution.moduleRef.moduleId}:${contribution.component}`;
    case 'resource-trigger': {
      const resourceId = makeResourceId(contribution.resourceRef);
      return `entrypoint:${contribution.triggerKind}:${resourceId}:${contribution.discriminator}`;
    }
  }
}

/** Convert one accepted contribution into the fragment shape entrypoint readers consume. */
export function toEntrypointFragment(contribution: EntrypointContribution): EntrypointFragment {
  const id = projectedEntrypointId(contribution);
  if (contribution.kind === 'resource-trigger') {
    return {
      id,
      kind: contribution.triggerKind,
      layer: 'backend',
      serviceId: makeResourceId(contribution.resourceRef),
      discriminator: contribution.discriminator,
      ...(contribution.handlerRef ? { handlerModule: contribution.handlerRef.moduleId } : {}),
      ...(contribution.label === undefined ? {} : { label: contribution.label }),
      source: 'projection',
    };
  }

  const base = {
    id,
    kind: FRAGMENT_KINDS[contribution.kind],
    moduleId: contribution.moduleRef.moduleId,
    ...(contribution.label === undefined ? {} : { label: contribution.label }),
    source: 'projection',
  };

  switch (contribution.kind) {
    case 'api-route':
      return { ...base, layer: 'backend', path: contribution.path, method: contribution.method };
    case 'file-route':
      return {
        ...base,
        layer: 'backend',
        path: contribution.path,
        fileType: contribution.fileType,
        ...(contribution.method === undefined ? {} : { method: contribution.method }),
      };
    case 'ui-route':
      return { ...base, layer: 'frontend', path: contribution.path };
    case 'conditional-render':
      return { ...base, layer: 'frontend', component: contribution.component };
  }
}
