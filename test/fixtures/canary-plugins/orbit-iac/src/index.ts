import {
  definePlugin,
  toPosixPath,
} from '@repovine/plugin-sdk';
import type {
  DocumentLoader,
  DocumentLoadInput,
  JsonValue,
  LoadedDocument,
  PackageInfo,
  PendingModuleDraft,
  PluginProjectionBatch,
  PluginRuntimeDescriptor,
  ProjectionContributor,
  ReadonlyFactRecord,
  ReadonlyProjectionInput,
  SourceDiscoveryResult,
  SourceExtractInput,
  SourceExtractResult,
  SourceRuntimeCapability,
} from '@repovine/plugin-sdk';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Orbit: an infrastructure ecosystem that exists nowhere but this fixture.
 *
 * Its provider, its resource kinds, its trigger type, its file format and its identity keys are all
 * invented here. The engine has no name for any of them, which is the point: it stores, compares and
 * reports the labels without branching on them, and the topology reaches the graph through the same
 * contract a real ecosystem uses.
 *
 * A `.orbit` document is a line-based format of this ecosystem's own design:
 *
 *   service checkout
 *   handler cmd/checkout/main.go
 *   route GET /checkout
 *   region eu-central
 *
 * The loader turns those bytes into a document; the projector turns documents into resources, links,
 * one entrypoint-bearing trigger and one namespaced extension for the part that has no canonical
 * meaning at all.
 */

const PLUGIN_ID = 'orbit';
const NAMESPACE = 'orbit';
const PROVIDER = 'orbit';
const SERVICE_SCHEMA = 'orbit/service@1';
const DEPLOYMENT_SCHEMA = 'orbit/deployment@1';
const LOADER_ID = 'orbit-manifest';

const SKIP_DIRS = new Set(['node_modules', '.git', '.repovine']);

interface OrbitService {
  name: string;
  handler?: string;
  routeMethod?: string;
  routePath?: string;
  region?: string;
}

/* --------------------------------- the loader --------------------------------- */

/**
 * Decode one `.orbit` document. The host read the file; this turns its bytes into structured data
 * and nothing else — no second walk of the filesystem, no path of its own.
 */
function parseOrbit(text: string): OrbitService[] {
  const services: OrbitService[] = [];
  let current: OrbitService | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const rest = line.slice(space + 1).trim();
    if (key === 'service') {
      current = { name: rest };
      services.push(current);
      continue;
    }
    if (!current) continue;
    if (key === 'handler') current.handler = rest;
    else if (key === 'region') current.region = rest;
    else if (key === 'route') {
      const parts = rest.split(/\s+/);
      current.routeMethod = (parts[0] ?? 'GET').toUpperCase();
      current.routePath = parts[1] ?? '/';
    }
  }
  return services;
}

const loader: DocumentLoader = {
  id: LOADER_ID,
  load(input: DocumentLoadInput): readonly LoadedDocument[] {
    const text = new TextDecoder().decode(input.content);
    return [{
      documentKey: input.relativeFilePath,
      value: parseOrbit(text) as unknown as JsonValue,
    }];
  },
};

/* --------------------------------- discovery --------------------------------- */

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(abs, out);
    else if (entry.endsWith('.orbit')) out.push(abs);
  }
}

function discover(repoRoot: string): SourceDiscoveryResult {
  const files: string[] = [];
  walk(repoRoot, files);
  if (files.length === 0) return { packages: [], pendingByPath: new Map() };

  // One stack per repository: the manifests are claimed so the host reads them, they are never code
  // and this plugin emits no module for them.
  const pkg: PackageInfo = { name: 'orbit-stack', path: '.', sourcePluginId: PLUGIN_ID };
  const pendingByPath = new Map<string, PendingModuleDraft>();
  for (const abs of files) {
    pendingByPath.set(abs, {
      filePath: abs,
      pkg,
      relPath: toPosixPath(relative(repoRoot, abs)),
      sourcePluginId: PLUGIN_ID,
    });
  }
  return { packages: [pkg], pendingByPath };
}

/* --------------------------------- extraction --------------------------------- */

/**
 * Publish what each manifest declares, and no modules at all.
 *
 * An orbit manifest is infrastructure, not code, so nothing here becomes a module. What leaves this
 * pass is facts under this plugin's own schemas — the channel a Stage 2 projector reads, and the
 * only one that survives the isolate boundary between the two passes.
 */
function extract(input: SourceExtractInput): SourceExtractResult {
  const facts: ReadonlyFactRecord[] = [];

  // The host hands every discovered file its minted module id, whichever ecosystem claimed it. That
  // is how an orbit handler path becomes a reference to a Go module without this plugin knowing what
  // Go is, or the Go plugin knowing that orbit exists.
  const idByRelPath = new Map<string, string>();
  for (const [abs, moduleId] of input.absPathToId) {
    idByRelPath.set(toPosixPath(relative(input.repoRoot, abs)), moduleId);
  }

  for (const pending of input.pendingModules) {
    const text = input.sourceByModuleId.get(pending.moduleId)?.content;
    if (text === undefined) continue;
    const documents = loader.load({
      relativeFilePath: pending.relPath,
      content: new TextEncoder().encode(text),
    });

    for (const document of documents) {
      for (const service of document.value as unknown as OrbitService[]) {
        const localKey = `service:${service.name}`;
        const handlerModuleId = service.handler === undefined
          ? undefined
          : idByRelPath.get(service.handler);
        // The subject is the code the service deploys when this ecosystem's handler convention
        // resolves to one, and the service itself when it does not: a fact always says what it is
        // about, and an unresolved handler costs the link, not the service.
        facts.push({
          schema: SERVICE_SCHEMA,
          subjectRef: handlerModuleId === undefined
            ? { type: 'resource', namespace: NAMESPACE, localKey }
            : { type: 'module', moduleId: handlerModuleId },
          value: {
            namespace: NAMESPACE,
            localKey,
            name: service.name,
            documentKey: document.documentKey,
            handler: service.handler ?? null,
            handlerModuleId: handlerModuleId ?? null,
            routeMethod: service.routeMethod ?? null,
            routePath: service.routePath ?? null,
            region: service.region ?? null,
          },
        });
      }
    }
  }

  // No delta: an orbit manifest never becomes a module. The facts above carry everything it says.
  return { deltas: [], reused: 0, rescanned: 0, facts };
}

const source: SourceRuntimeCapability = {
  fileMatch: { fileNamePatterns: [/\.orbit$/] },
  capabilities: { extensions: ['.orbit'] },
  discover,
  extract,
};

/* --------------------------------- projection --------------------------------- */

interface ServiceFact {
  localKey: string;
  name: string;
  documentKey: string;
  handler: string | null;
  handlerModuleId: string | null;
  routeMethod: string | null;
  routePath: string | null;
  region: string | null;
}

function asServiceFact(value: unknown): ServiceFact | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (typeof r.localKey !== 'string' || typeof r.name !== 'string') return undefined;
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    localKey: r.localKey,
    name: r.name,
    documentKey: typeof r.documentKey === 'string' ? r.documentKey : '',
    handler: text(r.handler),
    handlerModuleId: text(r.handlerModuleId),
    routeMethod: text(r.routeMethod),
    routePath: text(r.routePath),
    region: text(r.region),
  };
}

/** A stable fingerprint of one service's own declaration fragment. */
function fingerprint(service: ServiceFact): string {
  const text = JSON.stringify([service.name, service.handler, service.routeMethod, service.routePath, service.region]);

  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * One batch per service: its resource, the link to the code it deploys, its trigger entrypoint, and
 * the deployment detail that has no canonical meaning.
 *
 * The handler path is matched against the modules the view carries, whoever produced them. A service
 * whose handler resolves to nothing still contributes its resource — the link is what is missing,
 * not the topology.
 */
const stackProjector: ProjectionContributor = {
  id: 'orbit-stack',
  requires: [{ schema: SERVICE_SCHEMA }],
  project(input: ReadonlyProjectionInput): readonly PluginProjectionBatch[] {
    const batches: PluginProjectionBatch[] = [];

    for (const record of input.facts.select({ schema: SERVICE_SCHEMA })) {
      const service = asServiceFact(record.value);
      if (!service) continue;

      // A handler the host never minted a module for is not referenced: the batch would carry a
      // dangling reference and be refused whole, taking the resource with it.
      const handlerModuleId = service.handlerModuleId !== null && input.facts.hasModule(service.handlerModuleId)
        ? service.handlerModuleId
        : undefined;

      const batch: PluginProjectionBatch = {
        batchId: `${service.documentKey}#${service.name}`,
        delta: {
          resources: [{
            namespace: NAMESPACE,
            localKey: service.localKey,
            provider: PROVIDER,
            kind: 'service',
            label: service.name,
            contentHash: fingerprint(service),
            ...(service.region === null ? {} : { attributes: { region: service.region } }),
          }],
          extensions: [{
            schema: DEPLOYMENT_SCHEMA,
            localKey: service.name,
            subjectRef: { type: 'resource', namespace: NAMESPACE, localKey: service.localKey },
            payload: {
              region: service.region,
              rolloutStrategy: 'blue-green',
              declaredIn: service.documentKey,
            },
          }],
        },
      };

      if (handlerModuleId !== undefined) {
        batch.delta.links = [{
          from: { type: 'resource', namespace: NAMESPACE, localKey: service.localKey },
          to: { type: 'module', moduleId: handlerModuleId },
          relation: 'routes-to',
          because: 'the orbit service dispatches into this handler',
        }];
      }

      if (service.routePath !== null) {
        batch.delta.entrypoints = [{
          kind: 'resource-trigger',
          resourceRef: { type: 'resource', namespace: NAMESPACE, localKey: service.localKey },
          triggerKind: 'api',
          discriminator: service.routePath,
          ...(handlerModuleId === undefined ? {} : { handlerRef: { type: 'module', moduleId: handlerModuleId } }),
          label: `${service.routeMethod ?? 'GET'} ${service.routePath}`,
        }];
      }

      batches.push(batch);
    }

    return batches;
  },
};

const descriptor: PluginRuntimeDescriptor = definePlugin({
  id: PLUGIN_ID,
  capabilities: { source, loaders: [loader], projectors: [stackProjector] },
});

export default descriptor;
