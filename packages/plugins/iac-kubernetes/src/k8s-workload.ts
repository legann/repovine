/** Extract runtime-link attributes from Kubernetes workload manifests. */

import type { InfraEnvRef } from '@repovine/plugin-sdk';

const WORKLOAD_KINDS = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'CronJob',
  'Job',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function podSpecFromDoc(doc: Record<string, unknown>): Record<string, unknown> | undefined {
  const spec = doc.spec;
  if (!isRecord(spec)) return undefined;
  if (isRecord(spec.template) && isRecord(spec.template.spec)) {
    return spec.template.spec;
  }
  if (doc.kind === 'CronJob' && isRecord(spec.jobTemplate)
    && isRecord(spec.jobTemplate.spec)
    && isRecord(spec.jobTemplate.spec.template)
    && isRecord(spec.jobTemplate.spec.template.spec)) {
    return spec.jobTemplate.spec.template.spec;
  }
  if (doc.kind === 'Job' && isRecord(spec.template) && isRecord(spec.template.spec)) {
    return spec.template.spec;
  }
  if (isRecord(spec)) return spec;
  return undefined;
}

function addEnvRef(
  out: InfraEnvRef[],
  seen: Set<string>,
  ref: InfraEnvRef,
): void {
  const key = `${ref.varName}:${ref.refType}:${ref.targetLogicalId ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(ref);
}

function secretNameFromRef(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  return name || undefined;
}

function appendEnv(
  attrs: Record<string, string>,
  containers: unknown[],
  envRefs: InfraEnvRef[],
  seen: Set<string>,
): void {
  let envIndex = 0;
  for (const raw of containers) {
    if (!isRecord(raw)) continue;
    const envList = raw.env;
    if (!Array.isArray(envList)) continue;
    for (const entry of envList) {
      if (!isRecord(entry)) continue;
      const name = typeof entry.name === 'string' ? entry.name : undefined;
      const value = typeof entry.value === 'string' ? entry.value : undefined;
      if (!name) continue;
      if (value !== undefined) {
        attrs[`env${envIndex}_${name}`] = value;
        envIndex++;
        if (name.endsWith('_IMAGE') || name === 'IMAGE') {
          attrs[`containerEnvImage_${name}`] = value;
        }
      }
      if (!isRecord(entry.valueFrom)) continue;
      const secretName = secretNameFromRef(entry.valueFrom.secretKeyRef);
      if (secretName) {
        addEnvRef(envRefs, seen, { varName: name, refType: 'literal', targetLogicalId: secretName });
        continue;
      }
      const configMapName = secretNameFromRef(entry.valueFrom.configMapKeyRef);
      if (configMapName) {
        addEnvRef(envRefs, seen, { varName: name, refType: 'literal', targetLogicalId: configMapName });
      }
    }
  }
}

function appendEnvFrom(containers: unknown[], envRefs: InfraEnvRef[], seen: Set<string>): void {
  for (const raw of containers) {
    if (!isRecord(raw) || !Array.isArray(raw.envFrom)) continue;
    for (const entry of raw.envFrom) {
      if (!isRecord(entry)) continue;
      const secretName = secretNameFromRef(entry.secretRef);
      if (secretName) {
        addEnvRef(envRefs, seen, {
          varName: `envFrom:${secretName}`,
          refType: 'literal',
          targetLogicalId: secretName,
        });
        continue;
      }
      const configMapName = secretNameFromRef(entry.configMapRef);
      if (configMapName) {
        addEnvRef(envRefs, seen, {
          varName: `envFrom:${configMapName}`,
          refType: 'literal',
          targetLogicalId: configMapName,
        });
      }
    }
  }
}

function appendSecretVolumes(podSpec: Record<string, unknown>, envRefs: InfraEnvRef[], seen: Set<string>): void {
  if (!Array.isArray(podSpec.volumes)) return;
  for (const volume of podSpec.volumes) {
    if (!isRecord(volume) || !isRecord(volume.secret)) continue;
    const secretName = typeof volume.secret.secretName === 'string' ? volume.secret.secretName.trim() : '';
    if (!secretName) continue;
    const volumeName = typeof volume.name === 'string' && volume.name.trim() ? volume.name.trim() : secretName;
    addEnvRef(envRefs, seen, {
      varName: `volume:${volumeName}`,
      refType: 'literal',
      targetLogicalId: secretName,
    });
  }
}

function appendProbes(attrs: Record<string, string>, containers: unknown[]): void {
  for (let i = 0; i < containers.length; i++) {
    const raw = containers[i];
    if (!isRecord(raw)) continue;
    for (const probeKind of ['livenessProbe', 'readinessProbe'] as const) {
      const probe = raw[probeKind];
      if (!isRecord(probe)) continue;
      const httpGet = probe.httpGet;
      if (!isRecord(httpGet)) continue;
      const pathValue = typeof httpGet.path === 'string' ? httpGet.path : undefined;
      const portValue = httpGet.port != null ? String(httpGet.port) : undefined;
      if (pathValue) attrs[`${probeKind}${i}Path`] = pathValue;
      if (portValue) attrs[`${probeKind}${i}Port`] = portValue;
    }
  }
}

/**
 * Merge container images, env, probe hints, and ingress backends into IaC resource attributes.
 */
export function enrichK8sResourceAttributes(
  doc: Record<string, unknown>,
  attrs: Record<string, string>,
): InfraEnvRef[] {
  const envRefs = enrichK8sWorkloadPodAttributes(doc, attrs);
  const kind = typeof doc.kind === 'string' ? doc.kind : '';
  if (kind === 'Ingress') enrichK8sIngressAttributes(doc, attrs);
  return envRefs;
}

function enrichK8sWorkloadPodAttributes(
  doc: Record<string, unknown>,
  attrs: Record<string, string>,
): InfraEnvRef[] {
  const kind = typeof doc.kind === 'string' ? doc.kind : '';
  if (!WORKLOAD_KINDS.has(kind)) return [];

  const podSpec = podSpecFromDoc(doc);
  if (!podSpec) return [];

  const containers = Array.isArray(podSpec.containers) ? podSpec.containers : [];
  const initContainers = Array.isArray(podSpec.initContainers) ? podSpec.initContainers : [];
  const allContainers = [...containers, ...initContainers];
  const envRefs: InfraEnvRef[] = [];
  const seenEnvRefs = new Set<string>();
  const images: string[] = [];
  for (let i = 0; i < allContainers.length; i++) {
    const c = allContainers[i];
    if (!isRecord(c)) continue;
    if (typeof c.name === 'string') attrs[`containerName${i}`] = c.name;
    if (typeof c.image === 'string') {
      attrs[`containerImage${i}`] = c.image;
      images.push(c.image);
    }
  }
  if (images.length > 0) attrs.containerImages = images.join(',');

  appendEnv(attrs, allContainers, envRefs, seenEnvRefs);
  appendEnvFrom(allContainers, envRefs, seenEnvRefs);
  appendSecretVolumes(podSpec, envRefs, seenEnvRefs);
  appendProbes(attrs, allContainers);
  return envRefs;
}

function enrichK8sIngressAttributes(doc: Record<string, unknown>, attrs: Record<string, string>): void {
  const spec = doc.spec;
  if (!isRecord(spec)) return;
  const rules = spec.rules;
  if (!Array.isArray(rules)) return;
  const backends: string[] = [];
  let idx = 0;
  for (const rule of rules) {
    if (!isRecord(rule)) continue;
    const http = rule.http;
    if (!isRecord(http)) continue;
    const paths = http.paths;
    if (!Array.isArray(paths)) continue;
    for (const entry of paths) {
      if (!isRecord(entry)) continue;
      const backend = entry.backend;
      if (!isRecord(backend)) continue;
      const svc = backend.service;
      if (!isRecord(svc)) continue;
      const name = typeof svc.name === 'string' ? svc.name.trim() : '';
      if (!name) continue;
      attrs[`ingressBackend${idx}`] = name;
      idx++;
      backends.push(name);
    }
  }
  if (backends.length > 0) {
    attrs.ingressBackends = [...new Set(backends)].join(',');
  }
}
