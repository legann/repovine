import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IaCParser, InfraEnvRef, ReadonlyFactRecord, SemanticInfraDelta, InfraResource } from '@repovine/plugin-sdk';
import type { ResourceIdentity } from '@repovine/plugin-sdk';
import { hashResourcePayload, isRecord, pathMatchKey } from '@repovine/plugin-sdk';

/**
 * Identity of one Helm values resource.
 *
 * These resources are not addressed by any cloud API — they exist in the repository, and the id the
 * parser already mints is unique within the file that declares them. `generic` is the namespace for
 * exactly that: infrastructure described in a repo rather than provisioned in an account.
 */
/**
 * Schema of the image fact this plugin publishes. The owner segment is this plugin's own id, which
 * the host checks.
 */
const HELM_IMAGE_FACT_SCHEMA = 'helm/container-image@1';

function genericIdentity(id: string): ResourceIdentity {
  return { namespace: 'generic', localKey: id };
}


export interface HelmImageRef {
  key: string;
  repository: string;
  tag?: string;
}

export interface HelmSecretRef {
  key: string;
  secretName: string;
}

export function collectHelmImages(obj: unknown, prefix = ''): HelmImageRef[] {
  const out: HelmImageRef[] = [];
  walkHelmImages(obj, prefix, out);
  return out;
}

function walkHelmImages(obj: unknown, prefix: string, out: HelmImageRef[]): void {
  if (!isRecord(obj)) return;

  const image = obj.image;
  if (isRecord(image) && typeof image.repository === 'string') {
    const repository = image.repository.trim();
    const tag = typeof image.tag === 'string' ? image.tag.trim() : undefined;
    if (repository) {
      out.push({ key: prefix || 'image', repository, tag });
    }
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'image') continue;
    const next = prefix ? `${prefix}.${key}` : key;
    walkHelmImages(value, next, out);
  }
}

// Without rendering the chart templates we cannot see the actual Secret manifests, so this is a
// best-effort signal: explicit `existingSecret` / `secretName` / `secretRef` keys name a secret the
// chart consumes. Substring heuristics on values (e.g. any "password" key) are intentionally avoided
// to keep precision high — the rendering gap is documented in limitations-and-risks.
const HELM_SECRET_REF_KEY = /^(?:existingSecret|secretName|secretRef)$/i;

export function collectHelmSecrets(obj: unknown, prefix = ''): HelmSecretRef[] {
  const out: HelmSecretRef[] = [];
  walkHelmSecrets(obj, prefix, out);
  return out;
}

function walkHelmSecrets(obj: unknown, prefix: string, out: HelmSecretRef[]): void {
  if (!isRecord(obj)) return;
  for (const [key, value] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (HELM_SECRET_REF_KEY.test(key) && typeof value === 'string' && value.trim()) {
      out.push({ key: next, secretName: value.trim() });
      continue;
    }
    walkHelmSecrets(value, next, out);
  }
}

function isHelmValuesFileName(filePath: string): boolean {
  const base = path.basename(filePath);
  return /^values(-[\w.-]+)?\.ya?ml$/i.test(base);
}

function isUnderHelmChart(filePath: string): boolean {
  const norm = pathMatchKey(filePath);
  if (
    norm.includes('/helm/')
    || norm.startsWith('helm/')
    || norm.includes('/charts/')
    || norm.startsWith('charts/')
  ) return true;

  const dir = path.dirname(filePath);
  return fs.existsSync(path.join(dir, 'Chart.yaml')) || fs.existsSync(path.join(dir, 'Chart.yml'));
}

export const helmValuesParser: IaCParser = {
  kind: 'helm',
  fileMatch: { fileNamePatterns: [/^values(-[\w.-]+)?\.ya?ml$/i] },
  loaderId: 'yaml',

  supports(absPath, doc): boolean {
    if (!isRecord(doc)) return false;
    if (!isHelmValuesFileName(absPath)) return false;
    if (!isUnderHelmChart(absPath)) return false;
    if (typeof doc.apiVersion === 'string' && doc.apiVersion.startsWith('v2') && typeof doc.name === 'string') {
      return false;
    }
    return collectHelmImages(doc).length > 0 || collectHelmSecrets(doc).length > 0;
  },

  parse(absPath, repoRelPath, doc): SemanticInfraDelta | null {
    if (!isRecord(doc)) return null;
    const images = collectHelmImages(doc);
    const secretRefs = collectHelmSecrets(doc);
    if (images.length === 0 && secretRefs.length === 0) return null;

    const resources: InfraResource[] = images.map(img => {
      const id = img.key.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'image';
      const image = img.tag ? `${img.repository}:${img.tag}` : img.repository;
      const body = { id, repository: img.repository, tag: img.tag, image, helmValuesKey: img.key };
      // A secret declared under the same values subtree as the image (e.g. app.image + app.existingSecret)
      // is consumed by that workload — link image → secret so the relationship survives in the graph.
      const envRefs: InfraEnvRef[] = secretRefs
        .filter(ref => ref.key.startsWith(`${img.key}.`))
        .map(ref => ({ varName: ref.key, refType: 'literal', targetLogicalId: `secret:${ref.secretName}` }));
      return {
        id,
        kind: 'other',
        provider: 'generic',
        identity: genericIdentity(id),
        contentHash: hashResourcePayload(body),
        attributes: {
          role: 'container-image',
          helmValuesKey: img.key,
          imageRepository: img.repository,
          ...(img.tag ? { imageTag: img.tag } : {}),
          image,
        },
        envRefs: envRefs.length > 0 ? envRefs : undefined,
      };
    });

    const secretById = new Map<string, InfraResource>();
    for (const ref of secretRefs) {
      const id = `secret:${ref.secretName}`;
      if (secretById.has(id)) continue;
      secretById.set(id, {
        id,
        kind: 'secret',
        provider: 'generic',
        identity: genericIdentity(id),
        contentHash: hashResourcePayload({ kind: 'helm-secret', secretName: ref.secretName }),
        attributes: { external: 'true', source: 'helm-values', secretName: ref.secretName, helmValuesKey: ref.key },
      });
    }
    resources.push(...secretById.values());

    // Image references these values declare, published for whoever owns Dockerfiles to resolve. The
    // resources are already built, so the fact is derived from them rather than threaded through.
    const facts: ReadonlyFactRecord[] = resources
      .filter(res => res.attributes.role === 'container-image' && res.attributes.image)
      .map(res => ({
        schema: HELM_IMAGE_FACT_SCHEMA,
        subjectRef: { type: 'resource' as const, ...genericIdentity(res.id) },
        value: { localKey: res.id, containerImages: [res.attributes.image!] },
      }));

    return { kind: 'helm', resources, facts: facts.length > 0 ? facts : undefined };
  },
};
