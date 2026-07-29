import { makeResourceId } from '@repovine/plugin-sdk';
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
