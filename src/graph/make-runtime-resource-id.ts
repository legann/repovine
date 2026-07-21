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
    const namespace = res.attributes.namespace ?? '_';
    const originalKind = res.attributes.kind ?? res.kind;
    return `resource:k8s:${namespace}/${originalKind}/${base}`;
  }
  return `resource:${res.provider}:${base}`;
}
