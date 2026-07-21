import * as path from 'node:path';
import type {
  IaCParser,
  SemanticInfraDelta,
  InfraResource,
  InfraResourceKind,
} from '@repovine/plugin-sdk';
import { enrichK8sResourceAttributes } from '../../../stage1/k8s-workload.js';
import { hashResourcePayload } from '../../../stage1/iac/utils.js';

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

export const kubernetesParser: IaCParser = {
  kind: 'kubernetes',
  fileMatch: { extensions: ['.yaml', '.yml'] },
  docFormat: 'yaml',

  supports(_filePath, doc): boolean {
    if (!doc || typeof doc !== 'object') return false;
    const d = doc as Record<string, unknown>;
    if (d.Resources && typeof d.Resources === 'object') return false;
    if (typeof d.Transform === 'string') return false;
    if (typeof d.apiVersion === 'string' && typeof d.kind === 'string') return true;
    return false;
  },

  parse(filePath: string, relPath: string, doc: unknown): SemanticInfraDelta | null {
    if (!doc || typeof doc !== 'object') return null;
    const d = doc as { apiVersion?: string; kind?: string; metadata?: { name?: string; namespace?: string } };
    const kindStr = d.kind ?? 'Unknown';
    const resKind: InfraResourceKind = k8sKindMap[kindStr] ?? 'k8s-crd';
    const name = d.metadata?.name ?? path.basename(filePath, path.extname(filePath));
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
    const resources: InfraResource[] = [{
      id: name,
      kind: resKind,
      provider: 'k8s',
      contentHash: hashResourcePayload(k8sResourceBody),
      attributes,
      envRefs: envRefs.length > 0 ? envRefs : undefined,
    }];
    return { kind: 'kubernetes', resources };
  },
};
