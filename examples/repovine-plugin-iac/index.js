// Example third-party repovine IaC plugin (OSS-plugin plan Phase 3/Path B).
//
// A deliberately tiny JSON parser for a fictional `edge-stack.json` format. It demonstrates the
// IaC side of the plugin contract:
//   - fileMatch/docFormat let the engine find and parse candidate artifacts;
//   - supports() claims only documents this plugin owns;
//   - parse() emits INFRA SEMANTICS ONLY (`kind` + `resources`). The engine stamps the
//     InfraModuleInfo id/filePath/relativeFilePath/contentHash at the Stage-1 boundary;
//   - per-resource contentHash is producer-owned because it fingerprints a resource fragment;
//   - triggerTypeMeta teaches the core how to project custom trigger types into entrypoints/edges
//     without a new interpreter.
//
// Authored through the SDK factories, which is what a real package does: `defineIaCPlugin` stamps
// the contract major, so the descriptor never carries a version number that quietly goes stale, and
// `defineIaCParser` types the parser against the same contract the conformance kit checks.

import * as path from 'node:path';
import { defineIaCParser, defineIaCPlugin, hashResourcePayload, lastPathSegment } from '@repovine/plugin-sdk';

const STACK_KIND = 'edge-stack';
const STACK_FILE = 'edge-stack.json';

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stackName(root, relPath) {
  // `relPath` is repo-relative POSIX by contract, so the directory holding the stack is a POSIX
  // question and `path.basename` is not it — on win32 that also splits on `\`, which in a
  // repo-relative path is a character in a filename.
  const stackDir = relPath.split('/').slice(0, -1).join('/');
  return asString(root.name) || lastPathSegment(stackDir) || 'edge-stack';
}

function collectQueues(root, name) {
  const resources = [];
  for (const entry of asArray(root.queues)) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    if (!id) continue;
    resources.push({
      id,
      kind: 'queue',
      provider: 'aws',
      contentHash: hashResourcePayload({ kind: 'edge-queue', entry }),
      attributes: {
        stackName: name,
        queueName: asString(entry.name) ?? id,
      },
    });
  }
  return resources;
}

function collectSecrets(root, name) {
  const resources = [];
  for (const entry of asArray(root.secrets)) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    if (!id) continue;
    resources.push({
      id,
      kind: 'secret',
      provider: 'aws',
      contentHash: hashResourcePayload({ kind: 'edge-secret', entry }),
      attributes: {
        stackName: name,
        source: asString(entry.source) ?? 'external',
      },
    });
  }
  return resources;
}

function collectFunctionEnvRefs(fn) {
  if (!isRecord(fn.env)) return [];
  const refs = [];
  for (const [varName, target] of Object.entries(fn.env)) {
    const targetLogicalId = asString(target);
    if (!targetLogicalId) continue;
    refs.push({ varName, refType: 'literal', targetLogicalId });
  }
  return refs;
}

function collectFunctionTriggers(fn) {
  const triggers = [];
  for (const route of asArray(fn.routes)) {
    if (!isRecord(route)) continue;
    const method = (asString(route.method) ?? 'GET').toUpperCase();
    const routePath = asString(route.path);
    if (!routePath) continue;
    triggers.push({
      name: `${method} ${routePath}`,
      type: 'edge-http',
      method,
      path: routePath,
    });
  }
  for (const queueRef of asArray(fn.consumes).map(asString).filter(Boolean)) {
    triggers.push({
      name: `consume ${queueRef}`,
      type: 'edge-queue',
      queueRef,
    });
  }
  return triggers;
}

function collectFunctions(root, name) {
  const resources = [];
  for (const fn of asArray(root.functions)) {
    if (!isRecord(fn)) continue;
    const id = asString(fn.id);
    if (!id) continue;
    const handler = asString(fn.handler);
    const attrs = { stackName: name };
    if (handler) attrs.handler = handler;
    const envRefs = collectFunctionEnvRefs(fn);
    const triggers = collectFunctionTriggers(fn);
    resources.push({
      id,
      kind: 'lambda',
      provider: 'aws',
      contentHash: hashResourcePayload({ kind: 'edge-function', fn }),
      attributes: attrs,
      envVars: isRecord(fn.env) ? Object.keys(fn.env) : undefined,
      envRefs: envRefs.length > 0 ? envRefs : undefined,
      triggers: triggers.length > 0 ? triggers : undefined,
    });
  }
  return resources;
}

const edgeStackParser = defineIaCParser({
  kind: STACK_KIND,
  fileMatch: { fileNames: [STACK_FILE] },
  docFormat: 'json',

  supports(filePath, doc) {
    return path.basename(filePath) === STACK_FILE &&
      isRecord(doc) &&
      doc['x-repovine-kind'] === STACK_KIND;
  },

  parse(filePath, relPath, doc) {
    if (!this.supports(filePath, doc)) return null;
    const root = doc;
    const name = stackName(root, relPath);
    const resources = [
      ...collectQueues(root, name),
      ...collectSecrets(root, name),
      ...collectFunctions(root, name),
    ];
    if (resources.length === 0) return null;
    return { kind: STACK_KIND, resources };
  },
});

export default defineIaCPlugin({
  id: 'edge-stack',
  parsers: [edgeStackParser],
  kindDomains: [
    {
      kind: STACK_KIND,
      meta: {
        domainId: 'domain:infra-edge-stack',
        label: 'infra-edge-stack',
        description: 'Domain: infra-edge-stack (example third-party IaC plugin)',
      },
    },
  ],
  triggerTypeMeta: [
    { type: 'edge-http', meta: { entrypointKind: 'api' } },
    { type: 'edge-queue', meta: { isStreamLike: true, entrypointKind: 'queue-consumer' } },
  ],
});
