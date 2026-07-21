import * as path from 'node:path';
import type { IaCParser, InfraEnvRef, SemanticInfraDelta, InfraResource } from '@repovine/plugin-sdk';
import { addAttr, attrValue, hashResourcePayload, isRecord } from '../../stage1/iac/utils.js';

function vercelEnvVarNames(root: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const env = root.env;
  if (isRecord(env)) {
    for (const key of Object.keys(env)) out.add(key);
  }
  const build = root.build;
  if (isRecord(build) && isRecord(build.env)) {
    for (const key of Object.keys(build.env)) out.add(key);
  }
  return [...out].sort();
}

/**
 * Legacy Vercel secrets: an env value `@name` references a dashboard secret. Modern Vercel keeps
 * encrypted env without an in-file resource — that signal does not reach the repo, so only the
 * `@`-prefixed references are recoverable here (documented as a partial signal in limitations).
 */
function vercelSecretRefs(root: Record<string, unknown>): { secrets: InfraResource[]; envRefs: InfraEnvRef[] } {
  const secrets = new Map<string, InfraResource>();
  const envRefs: InfraEnvRef[] = [];
  const scan = (envObj: unknown): void => {
    if (!isRecord(envObj)) return;
    for (const [key, value] of Object.entries(envObj)) {
      const name = typeof value === 'string' ? value.match(/^@([A-Za-z0-9_-]+)$/)?.[1] : undefined;
      if (!name) continue;
      const id = `secret:${name}`;
      if (!secrets.has(id)) {
        secrets.set(id, {
          id,
          kind: 'secret',
          provider: 'vercel',
          contentHash: hashResourcePayload({ kind: 'vercel-secret', name }),
          attributes: { external: 'true', source: 'vercel-secret', secretName: name },
        });
      }
      envRefs.push({ varName: key, refType: 'ref', targetLogicalId: id });
    }
  };
  scan(root.env);
  scan(isRecord(root.build) ? root.build.env : undefined);
  return { secrets: [...secrets.values()], envRefs };
}

function vercelProjectAttributes(root: Record<string, unknown>): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const key of [
    'version', 'name', 'framework', 'buildCommand', 'devCommand', 'installCommand',
    'outputDirectory', 'public', 'cleanUrls', 'trailingSlash', 'regions',
  ]) {
    addAttr(attrs, key, root[key]);
  }
  return attrs;
}

function vercelFunctionAttributes(pattern: string, value: unknown): Record<string, string> {
  const attrs: Record<string, string> = { pattern, handler: pattern };
  if (isRecord(value)) {
    for (const key of ['runtime', 'maxDuration', 'memory', 'regions', 'includeFiles', 'excludeFiles']) {
      addAttr(attrs, key, value[key]);
    }
  } else {
    addAttr(attrs, 'config', value);
  }
  return attrs;
}

function addVercelRuleResources(
  resources: InfraResource[],
  type: 'rewrite' | 'redirect' | 'header' | 'route',
  value: unknown,
): void {
  if (!Array.isArray(value)) return;
  for (let i = 0; i < value.length; i++) {
    const rule = value[i];
    if (!isRecord(rule)) continue;
    const source = attrValue(rule.source ?? rule.src) ?? `#${i + 1}`;
    const destination = attrValue(rule.destination ?? rule.dest);
    const attrs: Record<string, string> = { type, source };
    addAttr(attrs, 'destination', destination);
    addAttr(attrs, 'statusCode', rule.statusCode);
    addAttr(attrs, 'permanent', rule.permanent);
    addAttr(attrs, 'continue', rule.continue);
    addAttr(attrs, 'check', rule.check);
    if (Array.isArray(rule.headers)) attrs.headers = String(rule.headers.length);
    if (Array.isArray(rule.methods)) attrs.methods = rule.methods.map(String).join(',');

    resources.push({
      id: `${type}:${source}`,
      kind: 'vercel-route',
      provider: 'vercel',
      contentHash: hashResourcePayload({ type, rule }),
      attributes: attrs,
    });
  }
}

export const vercelParser: IaCParser = {
  kind: 'vercel',
  fileMatch: { fileNames: ['vercel.json'] },
  docFormat: 'json',

  supports(filePath: string, doc: unknown): boolean {
    if (path.basename(filePath) !== 'vercel.json') return false;
    if (!isRecord(doc)) return false;
    return ['version', 'functions', 'crons', 'rewrites', 'redirects', 'headers', 'routes']
      .some(key => key in doc);
  },

  parse(filePath: string, relPath: string, doc: unknown): SemanticInfraDelta | null {
    if (!isRecord(doc)) return null;
    const root = doc;
    const resources: InfraResource[] = [];

    const projectAttrs = vercelProjectAttributes(root);
    const envVars = vercelEnvVarNames(root);
    const { secrets, envRefs } = vercelSecretRefs(root);
    if (Object.keys(projectAttrs).length > 0 || envVars.length > 0) {
      resources.push({
        id: 'project',
        kind: 'other',
        provider: 'vercel',
        contentHash: hashResourcePayload({ projectAttrs, envVars }),
        attributes: projectAttrs,
        envVars: envVars.length > 0 ? envVars : undefined,
        envRefs: envRefs.length > 0 ? envRefs : undefined,
      });
    }
    resources.push(...secrets);

    if (isRecord(root.functions)) {
      for (const [pattern, config] of Object.entries(root.functions)) {
        const attrs = vercelFunctionAttributes(pattern, config);
        resources.push({
          id: `function:${pattern}`,
          kind: 'vercel-function',
          provider: 'vercel',
          contentHash: hashResourcePayload({ pattern, config }),
          attributes: attrs,
        });
      }
    }

    if (Array.isArray(root.crons)) {
      for (let i = 0; i < root.crons.length; i++) {
        const cron = root.crons[i];
        if (!isRecord(cron)) continue;
        const cronPath = attrValue(cron.path) ?? `#${i + 1}`;
        const schedule = attrValue(cron.schedule);
        const attrs: Record<string, string> = { path: cronPath };
        addAttr(attrs, 'schedule', schedule);
        resources.push({
          id: `cron:${cronPath}`,
          kind: 'vercel-cron',
          provider: 'vercel',
          contentHash: hashResourcePayload({ cron }),
          attributes: attrs,
          triggers: [{
            name: `cron:${cronPath}`,
            type: 'schedule',
            path: cronPath,
            schedule,
          }],
        });
      }
    }

    addVercelRuleResources(resources, 'rewrite', root.rewrites);
    addVercelRuleResources(resources, 'redirect', root.redirects);
    addVercelRuleResources(resources, 'header', root.headers);
    addVercelRuleResources(resources, 'route', root.routes);

    if (resources.length === 0) return null;
    return { kind: 'vercel', resources };
  },
};
