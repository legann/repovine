import { makeResourceId, parseResourceId } from '@repovine/plugin-sdk';
import type { InfraResource } from '../types.js';

/**
 * Stable runtime-resource node id for an infra resource (must match graph construction).
 *
 * The plugin that emitted the resource computed its identity; the host encodes the two components
 * and nothing else. What makes an AWS Lambda distinct from an AWS queue, or one Kubernetes object
 * from another in a second namespace, is ecosystem knowledge, and reading it here would put every
 * future ecosystem's rule in the engine.
 */
export function makeRuntimeResourceId(res: InfraResource): string {
  return makeResourceId(res.identity);
}

/**
 * The declaration key components of an already-minted resource node: the namespace read back out of
 * its id, beside the provider the node carries.
 *
 * A query layer holds an id and a node, not the `InfraResource` a plugin emitted. The encoding is
 * lossless, so the namespace a declaration is keyed by is recoverable rather than re-derived from
 * the id's spelling.
 */
export function runtimeResourceIdentity(
  serviceId: string,
  provider?: string,
): { namespace?: string; provider?: string } {
  const parsed = parseResourceId(serviceId);
  return {
    ...(parsed === undefined ? {} : { namespace: parsed.namespace }),
    ...(provider === undefined ? {} : { provider }),
  };
}
