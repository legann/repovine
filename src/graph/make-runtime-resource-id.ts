import type { InfraResource } from '../types.js';

/** Stable runtime-resource node id for an infra resource (must match graph construction). */
export function makeRuntimeResourceId(res: InfraResource): string {
  const base = res.id;
  if (res.provider === 'aws') {
    if (res.kind === 'lambda') return `resource:aws-lambda:${base}`;
    if (res.kind === 'queue') return `resource:aws-sqs:${base}`;
    if (res.kind === 'topic') return `resource:aws-sns:${base}`;
    if (res.kind === 'table') return `resource:aws-dynamodb:${base}`;
    if (res.kind === 'api') return `resource:aws-api:${base}`;
    if (res.kind === 'bucket') return `resource:aws-s3:${base}`;
  }
  if (res.provider === 'k8s') {
    const originalKind = res.attributes.kind ?? res.kind;
    return `${k8sNamespacePrefix(res.attributes.namespace)}${originalKind}/${base}`;
  }
  return `resource:${res.provider}:${base}`;
}

/**
 * The id prefix every k8s runtime-resource in a namespace shares.
 *
 * Exported so a caller filtering by namespace builds the prefix from the minter rather than
 * spelling it again — including the `_` stand-in for a resource whose manifest names no namespace.
 */
export function k8sNamespacePrefix(namespace: string | undefined): string {
  return `resource:k8s:${namespace ?? '_'}/`;
}
