import * as path from 'node:path';
import type { IaCParser, InfraEnvRef, ReadonlyFactRecord, SemanticInfraDelta, InfraResource } from '@repovine/plugin-sdk';
import type { ResourceIdentity } from '@repovine/plugin-sdk';
import {
  addAttr,
  attrValue,
  hashResourcePayload,
  isRecord,
  pathGroupingLabel,
} from '@repovine/plugin-sdk';

/**
 * Identity of one Compose service or secret.
 *
 * These resources are not addressed by any cloud API — they exist in the repository, and the id the
 * parser already mints is unique within the file that declares them. `generic` is the namespace for
 * exactly that: infrastructure described in a repo rather than provisioned in an account.
 */
function genericIdentity(id: string): ResourceIdentity {
  return { namespace: 'generic', localKey: id };
}


/**
 * Schema of the build fact this plugin publishes.
 *
 * The owner segment is this plugin's own id, which the host checks: a producer publishes under a
 * schema it owns, and a reader selects that schema without naming a producer.
 */
const BUILD_FACT_SCHEMA = 'docker-compose/build@1';

function isDockerComposeFileName(base: string): boolean {
  return /^(docker-compose(\.[\w.-]+)?|compose(\.[\w.-]+)?)\.ya?ml$/i.test(base);
}

/** Top-level `secrets:` block → secret resources (file-based or `external: true`). */
function collectComposeSecrets(root: Record<string, unknown>): Map<string, InfraResource> {
  const out = new Map<string, InfraResource>();
  if (!isRecord(root.secrets)) return out;
  for (const [name, def] of Object.entries(root.secrets)) {
    const d = isRecord(def) ? def : {};
    const attributes: Record<string, string> = { source: 'compose-secret' };
    if (d.external === true || isRecord(d.external)) attributes.external = 'true';
    addAttr(attributes, 'file', d.file);
    addAttr(attributes, 'environment', d.environment);
    const externalName = isRecord(d.external) ? d.external.name : undefined;
    addAttr(attributes, 'secretName', d.name ?? externalName);
    out.set(name, {
      id: name,
      kind: 'secret',
      provider: 'generic',
      identity: genericIdentity(name),
      contentHash: hashResourcePayload({ kind: 'docker-compose-secret', name, def }),
      attributes,
    });
  }
  return out;
}

/** Normalize compose `environment` (map or `KEY=value` list) to entries. */
function composeEnvEntries(environment: unknown): Array<[string, string | undefined]> {
  if (isRecord(environment)) {
    return Object.entries(environment).map(([k, v]) => [k, attrValue(v)]);
  }
  if (Array.isArray(environment)) {
    const out: Array<[string, string | undefined]> = [];
    for (const item of environment) {
      if (typeof item !== 'string') continue;
      const eq = item.indexOf('=');
      out.push(eq < 0 ? [item, undefined] : [item.slice(0, eq), item.slice(eq + 1)]);
    }
    return out;
  }
  return [];
}

/** Compose `env_file` accepts a string, a list of strings, or `{ path, required }` long syntax. */
function composeEnvFilePaths(envFile: unknown): string[] {
  const out: string[] = [];
  const push = (entry: unknown): void => {
    if (typeof entry === 'string') out.push(entry);
    else if (isRecord(entry) && typeof entry.path === 'string') out.push(entry.path);
  };
  if (Array.isArray(envFile)) envFile.forEach(push);
  else push(envFile);
  return out;
}

/** Service `secrets:` accepts bare names (short) or `{ source, target }` objects (long). */
function composeServiceSecretNames(secrets: unknown): string[] {
  if (!Array.isArray(secrets)) return [];
  const out: string[] = [];
  for (const entry of secrets) {
    if (typeof entry === 'string') out.push(entry);
    else if (isRecord(entry) && typeof entry.source === 'string') out.push(entry.source);
  }
  return out;
}

const RUN_SECRETS_RE = /\/run\/secrets\/([^/\s]+)/;

/**
 * Build a service's secret envRefs from `secrets:` mounts, `*_FILE` env conventions
 * (`/run/secrets/<name>`), and `env_file:`. Declared/`_FILE` refs target the top-level secret node;
 * env_file refs synthesize an external secret node (a discrete secret-bearing source).
 */
function composeServiceSecretRefs(
  svc: Record<string, unknown>,
  secrets: Map<string, InfraResource>,
): InfraEnvRef[] {
  const refs: InfraEnvRef[] = [];
  const seen = new Set<string>();
  const add = (varName: string, targetLogicalId: string): void => {
    const key = `${varName}:${targetLogicalId}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ varName, refType: 'literal', targetLogicalId });
  };
  const ensureSecret = (id: string, attrs: Record<string, string>): void => {
    if (secrets.has(id)) return;
    secrets.set(id, {
      id,
      kind: 'secret',
      provider: 'generic',
      identity: genericIdentity(id),
      contentHash: hashResourcePayload({ kind: 'docker-compose-secret', id, attrs }),
      attributes: attrs,
    });
  };

  for (const name of composeServiceSecretNames(svc.secrets)) {
    ensureSecret(name, { source: 'compose-secret' });
    add(`secret:${name}`, name);
  }

  for (const [key, value] of composeEnvEntries(svc.environment)) {
    if (!key.endsWith('_FILE')) continue;
    const secretName = value?.match(RUN_SECRETS_RE)?.[1];
    if (!secretName) continue;
    ensureSecret(secretName, { source: 'compose-secret' });
    add(key, secretName);
  }

  for (const envFile of composeEnvFilePaths(svc.env_file)) {
    const id = `secret:${envFile.replace(/^\.\/+/, '')}`;
    ensureSecret(id, { external: 'true', source: 'env_file', file: envFile });
    add(`env_file:${envFile}`, id);
  }

  return refs;
}

function dockerComposeServiceAttributes(
  composeRelPath: string,
  serviceName: string,
  svc: Record<string, unknown>,
): Record<string, string> {
  const attrs: Record<string, string> = { serviceName };
  addAttr(attrs, 'image', svc.image);

  const composeDir = path.posix.dirname(composeRelPath);
  const makeRepoRelPath = (baseDir: string, child: string): string =>
    path.posix.normalize(path.posix.join(baseDir, child)).replace(/^\.\/+/, '');

  const build = svc.build;
  if (typeof build === 'string') {
    attrs.build = build;
    attrs.dockerfile = makeRepoRelPath(makeRepoRelPath(composeDir, build), 'Dockerfile');
  } else if (isRecord(build)) {
    addAttr(attrs, 'buildContext', build.context);
    const context = typeof build.context === 'string' && build.context.trim().length > 0 ? build.context : '.';
    const dockerfile = typeof build.dockerfile === 'string' && build.dockerfile.trim().length > 0
      ? build.dockerfile
      : 'Dockerfile';
    attrs.dockerfile = makeRepoRelPath(makeRepoRelPath(composeDir, context), dockerfile);
    addAttr(attrs, 'target', build.target);
  }

  if (Array.isArray(svc.ports)) attrs.ports = String(svc.ports.length);
  if (Array.isArray(svc.volumes)) attrs.volumes = String(svc.volumes.length);
  if (Array.isArray(svc.depends_on)) attrs.dependsOn = String(svc.depends_on.length);
  if (isRecord(svc.depends_on)) attrs.dependsOn = String(Object.keys(svc.depends_on).length);
  if (Array.isArray(svc.environment)) attrs.environment = String(svc.environment.length);
  if (isRecord(svc.environment)) attrs.environment = String(Object.keys(svc.environment).length);

  return attrs;
}

export const dockerComposeParser: IaCParser = {
  kind: 'docker-compose',
  fileMatch: { fileNamePatterns: [/^(docker-compose(\.[\w.-]+)?|compose(\.[\w.-]+)?)\.ya?ml$/i] },
  loaderId: 'yaml',

  supports(absPath, doc): boolean {
    const base = path.basename(absPath);
    if (!isDockerComposeFileName(base)) return false;
    if (!isRecord(doc)) return false;
    return isRecord(doc.services);
  },

  parse(absPath, repoRelPath, doc): SemanticInfraDelta | null {
    if (!isRecord(doc) || !isRecord(doc.services)) return null;
    const root = doc;
    const services = root.services as Record<string, unknown>;

    const domainPath = pathGroupingLabel(repoRelPath);

    const secrets = collectComposeSecrets(root);
    const resources: InfraResource[] = [];
    const facts: ReadonlyFactRecord[] = [];
    for (const [serviceName, serviceVal] of Object.entries(services)) {
      if (!isRecord(serviceVal)) continue;
      const attrs: Record<string, string> = { domainPath, ...dockerComposeServiceAttributes(repoRelPath, serviceName, serviceVal) };
      const envRefs = composeServiceSecretRefs(serviceVal, secrets);
      // The build recipe this service names, published as a fact rather than left as an attribute
      // for someone else to interpret. Whoever owns Dockerfiles reads it and draws the link; this
      // parser states what the compose file says and stops there.
      if (attrs.dockerfile) {
        facts.push({
          schema: BUILD_FACT_SCHEMA,
          subjectRef: { type: 'resource', ...genericIdentity(serviceName) },
          value: { serviceName, dockerfileRepoRelPath: attrs.dockerfile },
        });
      }
      resources.push({
        id: serviceName,
        kind: 'other',
        provider: 'generic',
        identity: genericIdentity(serviceName),
        contentHash: hashResourcePayload({ kind: 'docker-compose-service', serviceName, service: serviceVal }),
        attributes: attrs,
        envRefs: envRefs.length > 0 ? envRefs : undefined,
      });
    }

    // Secret nodes (declared top-level + synthesized from service refs) come after services so
    // service scan order is preserved; the deferred infra-link pass wires uses_env regardless.
    resources.push(...secrets.values());

    if (resources.length === 0) return null;

    return { kind: 'docker-compose', resources, facts: facts.length > 0 ? facts : undefined };
  },
};
