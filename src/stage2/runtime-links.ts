import type { InfraResource, RepositoryGraph, RepositoryFactsSnapshot } from '../types.js';
import { addEdge, hasEdge, nodesOfType } from '../graph/index.js';
import { makeRuntimeResourceId } from '../graph/make-runtime-resource-id.js';
import { normalizeLinkingConfig } from '../stage1/linking-config.js';

function normalizeRelPath(value: string): string {
  const out: string[] = [];
  for (const segment of value.replace(/\\/g, '/').replace(/\/+/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

function dirnameRelPath(relPath: string): string {
  const normalized = normalizeRelPath(relPath);
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx) : '';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** SAM CodeUri or Terraform filename/zip path → search root relative to repo. */
export function resolveArtifactRoot(
  attributes: Record<string, string> | undefined,
  infraRelPath?: string,
): string | undefined {
  if (!attributes) return undefined;
  const codeUri = resolveCodeUriRoot(attributes.codeUri, infraRelPath);
  if (codeUri) return codeUri;
  const filename = attributes.filename;
  if (!filename) return undefined;
  const raw = filename.replace(/\\/g, '/');
  if (/^[a-z]+:\/\//i.test(raw)) return undefined;
  const templateDir = infraRelPath ? dirnameRelPath(infraRelPath) : '';
  const joined = raw.startsWith('../') || raw.startsWith('./')
    ? normalizeRelPath(templateDir ? `${templateDir}/${raw}` : raw)
    : normalizeRelPath(raw);
  const withoutArchive = joined.replace(/\.(zip|jar|war)$/i, '');
  return dirnameRelPath(withoutArchive) || withoutArchive;
}

function resolveCodeUriRoot(codeUri: string | undefined, infraRelPath: string | undefined): string | undefined {
  if (!codeUri) return undefined;
  const raw = codeUri.replace(/\\/g, '/').replace(/\/+$|^\.\/$/g, '');
  if (/^[a-z]+:\/\//i.test(raw)) return undefined;
  const templateDir = infraRelPath ? dirnameRelPath(infraRelPath) : '';
  if (!raw || raw === '.') return templateDir || undefined;
  if (raw.startsWith('./') || raw.startsWith('../')) {
    return normalizeRelPath(templateDir ? `${templateDir}/${raw}` : raw);
  }
  return normalizeRelPath(raw);
}

export function runtimeEntrySearchRoots(
  snapshot: RepositoryFactsSnapshot,
  attributes?: Record<string, string>,
  infraRelPath?: string,
): string[] {
  const linking = normalizeLinkingConfig(snapshot.linkingConfig);
  const roots: string[] = [];
  const artifactRoot = resolveArtifactRoot(attributes, infraRelPath);
  if (artifactRoot) roots.push(artifactRoot);
  roots.push(...linking.handlers.searchRoots);
  for (const pkg of snapshot.packages) {
    roots.push(pkg.path);
    roots.push(normalizeRelPath(`${pkg.path}/src`));
  }
  roots.push('');
  return uniqueStrings(roots.map(normalizeRelPath));
}

function imagePathTokens(image: string): string[] {
  const ref = image.split('@')[0].toLowerCase();
  const nameTag = ref.includes('/') ? ref.slice(ref.lastIndexOf('/') + 1) : ref;
  const stem = nameTag.includes(':') ? nameTag.slice(0, nameTag.indexOf(':')) : nameTag;
  const tokens = new Set<string>();
  if (stem.length >= 2) tokens.add(stem);
  const repoPath = (ref.includes(':') ? ref.slice(0, ref.indexOf(':')) : ref).split('/').slice(0, -1);
  for (const segment of repoPath) {
    if (segment.length < 2) continue;
    tokens.add(segment);
    for (const part of segment.split(/[-_.]/)) {
      if (part.length >= 2) tokens.add(part);
    }
  }
  return [...tokens];
}

function dockerfilePathTokens(relPath: string): string[] {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  const tokens = new Set<string>();
  const dir = dirnameRelPath(normalized);
  if (dir) {
    for (const segment of dir.split('/')) {
      if (segment.length >= 2) tokens.add(segment);
      for (const part of segment.split(/[-_.]/)) {
        if (part.length >= 2) tokens.add(part);
      }
    }
  }
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (base.startsWith('dockerfile')) {
    const parent = dir ? dir.slice(dir.lastIndexOf('/') + 1) : '';
    if (parent.length >= 2) tokens.add(parent);
  }
  return [...tokens];
}

function listDockerfileModuleIds(graph: RepositoryGraph): string[] {
  const out: string[] = [];
  for (const node of graph.nodes.values()) {
    if (node.type === 'module' && node.id.startsWith('infra:dockerfile:')) {
      out.push(node.id);
    }
  }
  return out;
}

function resolveDockerfileModuleId(
  image: string,
  graph: RepositoryGraph,
  dockerfileRoots: string[],
  serviceLabel?: string,
): string | undefined {
  const imageTokens = imagePathTokens(image);
  const dockerfiles = listDockerfileModuleIds(graph);
  let best: { id: string; score: number } | undefined;
  const serviceLower = serviceLabel?.toLowerCase();

  for (const dockerfileId of dockerfiles) {
    const rel = dockerfileId.slice('infra:dockerfile:'.length).toLowerCase();
    const pathTokens = dockerfilePathTokens(rel);
    let score = 0;
    for (const token of imageTokens) {
      if (rel.includes(token)) score += token.length >= 4 ? 4 : 2;
      for (const pathToken of pathTokens) {
        if (pathToken === token || pathToken.includes(token) || token.includes(pathToken)) {
          score += 4;
        }
      }
      if (serviceLower && token.length >= 3 && serviceLower.includes(token)) score += 5;
    }
    for (const root of dockerfileRoots) {
      const norm = root.replace(/\\/g, '/').toLowerCase();
      if (norm && rel.startsWith(norm)) score += 3;
    }
    if (!best || score > best.score) best = { id: dockerfileId, score };
  }

  return best && best.score > 0 ? best.id : undefined;
}

function collectContainerImages(attrs: Record<string, string>): string[] {
  const images: string[] = [];
  if (attrs.containerImages) {
    for (const part of attrs.containerImages.split(',')) {
      const trimmed = part.trim();
      if (trimmed) images.push(trimmed);
    }
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('containerImage') && value) images.push(value);
    if (key.startsWith('containerEnvImage_') && value) images.push(value);
    if (key === 'image' && value) images.push(value);
  }
  return uniqueStrings(images);
}

function shouldLinkResource(res: InfraResource): boolean {
  if (res.kind === 'k8s-deployment' || res.kind === 'k8s-service') return true;
  if (res.attributes.role === 'container-image') return true;
  return Boolean(res.attributes.containerImages || res.attributes.containerImage0);
}

function findK8sIngressBackendServiceId(
  graph: RepositoryGraph,
  label: string,
  namespace: string | undefined,
): string | undefined {
  const serviceSet = nodesOfType(graph, 'runtime-resource');
  if (serviceSet.length === 0) return undefined;
  const namespacePrefix = `resource:k8s:${namespace ?? '_'}/`;
  let untypedServiceId: string | undefined;
  for (const id of serviceSet) {
    const node = graph.nodes.get(id);
    if (node?.type !== 'runtime-resource' || node.label !== label) continue;
    const data = (node.data ?? {}) as { kind?: string; k8sKind?: string; provider?: string };
    if (data.kind !== 'k8s-service' || data.provider !== 'k8s') continue;
    // Kubernetes Ingress service backends are namespace-local. Once ids encode namespaces,
    // label-only lookup must not reconnect an ingress to a same-name Service elsewhere.
    if (!id.startsWith(namespacePrefix)) continue;
    if (data.k8sKind === 'Ingress') continue;
    if (data.k8sKind === 'Service') return id;
    untypedServiceId ??= id;
  }
  return untypedServiceId;
}

function collectIngressBackends(attrs: Record<string, string>): string[] {
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
  return uniqueStrings(backends);
}

/**
 * Link Kubernetes Ingress resources to backend Service nodes via `routes_to` edges.
 */
export function linkK8sIngressRoutes(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
): void {
  for (const infraMod of snapshot.infraModules ?? []) {
    for (const res of infraMod.resources) {
      if (res.provider !== 'k8s' || res.kind !== 'k8s-service') continue;
      const backends = collectIngressBackends(res.attributes);
      if (backends.length === 0) continue;
      const ingressServiceId = makeRuntimeResourceId(res);
      if (!graph.nodes.has(ingressServiceId)) continue;
      for (const backendName of backends) {
        const targetServiceId = findK8sIngressBackendServiceId(
          graph,
          backendName,
          res.attributes.namespace,
        );
        if (
          !targetServiceId
          || targetServiceId === ingressServiceId
          || hasEdge(graph, ingressServiceId, 'routes_to', targetServiceId)
        ) continue;
        addEdge(graph, ingressServiceId, targetServiceId, 'routes_to');
      }
    }
  }
}

/**
 * Link k8s workloads, helm values images, and env image refs to Dockerfile modules in-repo.
 */
export function linkContainerRuntimeTargets(
  graph: RepositoryGraph,
  snapshot: RepositoryFactsSnapshot,
): void {
  const linking = normalizeLinkingConfig(snapshot.linkingConfig);
  const imageToDockerfile = new Map<string, string>();

  for (const infraMod of snapshot.infraModules ?? []) {
    for (const res of infraMod.resources) {
      if (!shouldLinkResource(res)) continue;
      const serviceId = makeRuntimeResourceId(res);
      if (!graph.nodes.has(serviceId)) continue;

      const images = collectContainerImages(res.attributes);
      for (const image of images) {
        let dockerfileId = imageToDockerfile.get(image);
        if (!dockerfileId) {
          dockerfileId = resolveDockerfileModuleId(
            image,
            graph,
            linking.containers.dockerfileRoots,
            res.id,
          );
          if (dockerfileId) imageToDockerfile.set(image, dockerfileId);
        }
        if (!dockerfileId || !graph.nodes.has(dockerfileId)) continue;
        if (hasEdge(graph, serviceId, 'infra', dockerfileId)) continue;
        addEdge(graph, serviceId, dockerfileId, 'infra');
      }

      for (const [key, value] of Object.entries(res.attributes)) {
        if (!key.startsWith('containerEnvImage_') && !key.endsWith('_IMAGE')) continue;
        if (!value.includes('/')) continue;
        const envImage = value;
        const dockerfileId = imageToDockerfile.get(envImage)
          ?? resolveDockerfileModuleId(envImage, graph, linking.containers.dockerfileRoots, res.id);
        if (dockerfileId) imageToDockerfile.set(envImage, dockerfileId);
        if (!dockerfileId || hasEdge(graph, serviceId, 'infra', dockerfileId)) continue;
        addEdge(graph, serviceId, dockerfileId, 'infra');
      }
    }
  }
}
