import * as path from 'node:path';
import type {
  IaCParser,
  ReadonlyFactRecord,
  SemanticInfraDelta,
  InfraResource,
  InfraResourceKind,
} from '@repovine/plugin-sdk';
import type { ResourceIdentity } from '@repovine/plugin-sdk';
import { hashResourcePayload } from '@repovine/plugin-sdk';
import { enrichK8sResourceAttributes } from '../k8s-workload.js';

const k8sKindMap: Record<string, InfraResourceKind> = {
  Deployment: 'k8s-deployment',
  Service: 'k8s-service',
  ConfigMap: 'k8s-crd',
  Secret: 'secret',
  ServiceAccount: 'k8s-crd',
  Namespace: 'k8s-crd',
  DaemonSet: 'k8s-deployment',
  StatefulSet: 'k8s-deployment',
  CronJob: 'k8s-deployment',
  Job: 'k8s-deployment',
  Ingress: 'k8s-service',
};

/** The namespace stand-in for an object whose manifest names none. Cluster scope is still a scope. */
const K8S_CLUSTER_SCOPE = '_';

/** Schema of the fact carrying what a manifest says beyond the canonical resource fields. */
export const K8S_OBJECT_SCHEMA = 'kubernetes/object@1';

/**
 * The scope a Kubernetes object resolves its own references in.
 *
 * A name in a manifest reaches its own namespace and no further. The string is prefixed so it names
 * a Kubernetes namespace rather than any namespace: the host compares it against other plugins'
 * scopes and reads nothing inside it.
 */
export function k8sRefScope(namespace: string | undefined): string {
  return `k8s/${namespace ?? K8S_CLUSTER_SCOPE}`;
}

/** Backend Service names an Ingress routes to, in declaration order and without repeats. */
function ingressBackends(attrs: Record<string, string>): string[] {
  const backends: string[] = [];
  if (attrs.ingressBackends) {
    for (const part of attrs.ingressBackends.split(',')) {
      const trimmed = part.trim();
      if (trimmed) backends.push(trimmed);
    }
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('ingressBackend') && value) backends.push(value);
  }
  return [...new Set(backends.filter(Boolean))];
}

/**
 * Identity of one Kubernetes object.
 *
 * A name is unique per `(namespace, kind)` and nowhere wider, so both belong in the key. The
 * manifest's own `kind` spelling is used rather than the coarse resource kind the graph shows: two
 * objects the graph both calls a service are still a Service and an Ingress to the cluster.
 */
export function k8sIdentity(
  namespace: string | undefined,
  manifestKind: string,
  name: string,
): ResourceIdentity {
  return {
    namespace: 'k8s',
    localKey: `${namespace ?? K8S_CLUSTER_SCOPE}/${manifestKind}/${name}`,
  };
}

export const kubernetesParser: IaCParser = {
  kind: 'kubernetes',
  fileMatch: { extensions: ['.yaml', '.yml'] },
  loaderId: 'yaml',

  supports(_absPath, doc): boolean {
    if (!doc || typeof doc !== 'object') return false;
    const d = doc as Record<string, unknown>;
    if (d.Resources && typeof d.Resources === 'object') return false;
    if (typeof d.Transform === 'string') return false;
    if (typeof d.apiVersion === 'string' && typeof d.kind === 'string') return true;
    return false;
  },

  parse(absPath, repoRelPath, doc): SemanticInfraDelta | null {
    if (!doc || typeof doc !== 'object') return null;
    const d = doc as { apiVersion?: string; kind?: string; metadata?: { name?: string; namespace?: string } };
    const kindStr = d.kind ?? 'Unknown';
    const resKind: InfraResourceKind = k8sKindMap[kindStr] ?? 'k8s-crd';
    const name = d.metadata?.name ?? path.basename(absPath, path.extname(absPath));
    const k8sResourceBody = {
      id: name,
      apiVersion: d.apiVersion,
      kind: kindStr,
      metadata: d.metadata,
    };
    const attributes: Record<string, string> = {
      apiVersion: String(d.apiVersion ?? ''),
      kind: kindStr,
      ...(d.metadata?.namespace ? { namespace: d.metadata.namespace } : {}),
    };
    const envRefs = enrichK8sResourceAttributes(d as Record<string, unknown>, attributes);
    const identity = k8sIdentity(d.metadata?.namespace, kindStr, name);
    const refScope = k8sRefScope(d.metadata?.namespace);
    const resources: InfraResource[] = [{
      id: name,
      kind: resKind,
      provider: 'k8s',
      identity,
      refScope,
      contentHash: hashResourcePayload(k8sResourceBody),
      attributes,
      envRefs: envRefs.length > 0 ? envRefs : undefined,
    }];
    // What this manifest says that no canonical field carries: its own kind spelling, the scope it
    // lives in, and the Services an Ingress routes to. The projector reads them back; the host
    // stores strings it never interprets.
    const facts: ReadonlyFactRecord[] = [{
      schema: K8S_OBJECT_SCHEMA,
      subjectRef: { type: 'resource', namespace: identity.namespace, localKey: identity.localKey },
      value: {
        localKey: identity.localKey,
        manifestKind: kindStr,
        name,
        refScope,
        backends: ingressBackends(attributes),
      },
    }];
    return { kind: 'kubernetes', resources, facts };
  },
};
