import {
  asHostPath,
  asPkgRelPath,
  asRepoRelPath,
  definePlugin,
  hostPathKey,
  toPosixPath,
} from '@repovine/plugin-sdk';
import type {
  ExportInfo,
  HostPath,
  ImportInfo,
  PackageInfo,
  PendingModuleDraft,
  PluginProjectionBatch,
  PluginRuntimeDescriptor,
  ProjectionContributor,
  ReadonlyFactRecord,
  ReadonlyProjectionInput,
  SemanticModuleDelta,
  SourceDiscoveryResult,
  SourceExtractInput,
  SourceExtractResult,
  SourceRuntimeCapability,
} from '@repovine/plugin-sdk';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Go, as an ecosystem living outside the engine repository.
 *
 * It owns everything about Go: `go.mod` as the package marker, the import block as the dependency
 * syntax, the exported-identifier rule, and its own route syntax. The engine learns none of that —
 * it receives packages, modules, and facts under a schema this plugin owns.
 *
 * The route leaves here twice-normalised: as a fact (`go/route@1`) a Stage 1 producer publishes, and
 * as the canonical `api-route` contribution the projector derives from it. Nothing in this file
 * spells a graph node id or a repovine-internal name.
 */

const PLUGIN_ID = 'go';
const ROUTE_SCHEMA = 'go/route@1';
/** The other canary's schema. Read by name, never by producer: this plugin has no idea who fills it. */
const ORBIT_SERVICE_SCHEMA = 'orbit/service@1';

const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', '.repovine']);

interface GoRouteFact {
  method: string;
  path: string;
  handler: string;
}

interface OrbitServiceFact {
  namespace: string;
  localKey: string;
}

/* --------------------------------- discovery --------------------------------- */

function walk(dir: string, out: string[], names: readonly string[]): void {
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
    if (isDir) walk(abs, out, names);
    else if (names.some(name => entry === name || entry.endsWith(name))) out.push(abs);
  }
}

/** `module example.com/shop` in a `go.mod` names the package; the directory holding it is its root. */
function moduleNameOf(goModPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(goModPath, 'utf-8');
  } catch {
    return undefined;
  }
  const match = /^module\s+(\S+)/m.exec(text);
  return match?.[1];
}

function discover(repoRoot: HostPath): SourceDiscoveryResult {
  const goMods: string[] = [];
  walk(repoRoot, goMods, ['go.mod']);

  const packages: PackageInfo[] = [];
  const pendingByAbsPath = new Map<HostPath, PendingModuleDraft>();

  for (const goMod of goMods) {
    const root = goMod.slice(0, goMod.length - 'go.mod'.length - 1) || repoRoot;
    const name = moduleNameOf(goMod);
    if (name === undefined) continue;
    const pkg: PackageInfo = {
      name,
      repoRelDir: asRepoRelPath(toPosixPath(relative(repoRoot, root)) || '.'),
      sourcePluginId: PLUGIN_ID,
    };
    packages.push(pkg);

    const sources: string[] = [];
    walk(root, sources, ['.go']);
    for (const abs of sources) {
      const absPath = asHostPath(abs);
      pendingByAbsPath.set(hostPathKey(absPath), {
        absPath,
        pkg,
        pkgRelPath: asPkgRelPath(toPosixPath(relative(root, abs))),
        sourcePluginId: PLUGIN_ID,
      });
    }
  }

  return { packages, pendingByAbsPath };
}

/* --------------------------------- extraction --------------------------------- */

const IMPORT_BLOCK = /import\s*\(([\s\S]*?)\)/g;
const IMPORT_SINGLE = /^\s*import\s+(?:[A-Za-z_.][\w.]*\s+)?"([^"]+)"/gm;
const IMPORT_LINE = /^\s*(?:[A-Za-z_.][\w.]*\s+)?"([^"]+)"/gm;
const FUNC = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm;
const ROUTE = /router\.(Get|Post|Put|Delete|Patch)\("([^"]+)",\s*([A-Za-z_]\w*)\)/g;

/** A Go import path is local when it starts with the module path of a package in this build. */
function resolveImport(specifier: string, packages: readonly PackageInfo[]): string | undefined {
  for (const pkg of packages) {
    if (specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)) return pkg.name;
  }
  return undefined;
}

function importsOf(
  text: string,
  packages: readonly PackageInfo[],
  absPathToId: ReadonlyMap<HostPath, string>,
  repoRoot: HostPath,
): ImportInfo[] {
  const specifiers: string[] = [];
  for (const block of text.matchAll(IMPORT_BLOCK)) {
    for (const line of (block[1] ?? '').matchAll(IMPORT_LINE)) {
      if (line[1]) specifiers.push(line[1]);
    }
  }
  for (const single of text.matchAll(IMPORT_SINGLE)) {
    if (single[1]) specifiers.push(single[1]);
  }

  const out: ImportInfo[] = [];
  for (const specifier of specifiers) {
    const owner = resolveImport(specifier, packages);
    // A Go import names a directory inside its module; the engine minted an id per file, so the
    // package-relative directory resolves to the file the directory holds.
    let resolvedModuleId: string | undefined;
    if (owner !== undefined) {
      const sub = specifier === owner ? '' : specifier.slice(owner.length + 1);
      for (const [abs, id] of absPathToId) {
        const rel = toPosixPath(relative(repoRoot, abs));
        const dir = rel.slice(0, rel.lastIndexOf('/'));
        if (sub === '' ? dir === '' : dir.endsWith(sub)) {
          resolvedModuleId = id;
          break;
        }
      }
    }
    out.push({
      moduleSpecifier: specifier,
      ...(resolvedModuleId === undefined ? {} : { resolvedModuleId }),
      importedNames: [],
      isTypeOnly: false,
      isExternal: owner === undefined,
    });
  }
  return out;
}

/** Go's export rule is spelling: an identifier that starts upper-case is exported. */
function exportsOf(text: string): ExportInfo[] {
  const lines = text.split('\n');
  const out: ExportInfo[] = [];
  for (const match of text.matchAll(FUNC)) {
    const name = match[1] ?? '';
    if (name === '' || name[0] !== name[0]?.toUpperCase()) continue;
    const start = lines.slice(0, text.slice(0, match.index).split('\n').length).length;
    out.push({
      name,
      kind: 'function',
      isDefault: false,
      lineRange: { start, end: start },
    });
  }
  return out;
}

function routesOf(text: string): GoRouteFact[] {
  const out: GoRouteFact[] = [];
  for (const match of text.matchAll(ROUTE)) {
    out.push({
      method: (match[1] ?? 'Get').toUpperCase(),
      path: match[2] ?? '/',
      handler: match[3] ?? '',
    });
  }
  return out;
}

function extract(input: SourceExtractInput): SourceExtractResult {
  const deltas: SemanticModuleDelta[] = [];
  const facts: ReadonlyFactRecord[] = [];

  for (const pending of input.pendingModules) {
    const source = input.sourceByModuleId.get(pending.moduleId);
    if (!source) continue;
    const text = source.content;

    const delta: SemanticModuleDelta = {
      moduleId: pending.moduleId,
      imports: importsOf(text, input.packages, input.absPathToId, input.repoRoot),
      exports: exportsOf(text),
    };
    deltas.push(delta);

    for (const route of routesOf(text)) {
      facts.push({
        schema: ROUTE_SCHEMA,
        subjectRef: { type: 'module', moduleId: pending.moduleId },
        value: { method: route.method, path: route.path, handler: route.handler },
      });
    }
  }

  return { deltas, reused: 0, rescanned: deltas.length, facts };
}

const source: SourceRuntimeCapability = {
  packageMarkers: ['go.mod'],
  fileMatch: { extensions: ['.go'] },
  capabilities: {
    extensions: ['.go'],
    moduleIdNormalize: { stripSuffixes: ['.go'] },
  },
  discover,
  extract,
};

/* --------------------------------- projection --------------------------------- */

function asRoute(value: unknown): GoRouteFact | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { method, path, handler } = record;
  if (typeof method !== 'string' || typeof path !== 'string' || typeof handler !== 'string') return undefined;
  return { method, path, handler };
}

function asOrbitService(value: unknown): OrbitServiceFact | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { namespace, localKey } = record;
  if (typeof namespace !== 'string' || typeof localKey !== 'string') return undefined;
  return { namespace, localKey };
}

/**
 * Routes and deployment bindings, from facts alone.
 *
 * The route batch is keyed per module, so one unreadable route costs its own module and nothing
 * else. The binding batch references a resource this plugin does not create and cannot see while it
 * runs: it names the other ecosystem's identity components, and the host resolves them against the
 * index of every accepted batch after both plugins have contributed.
 */
const routeProjector: ProjectionContributor = {
  id: 'go-routes',
  requires: [{ schema: ROUTE_SCHEMA }, { schema: ORBIT_SERVICE_SCHEMA }],
  project(input: ReadonlyProjectionInput): readonly PluginProjectionBatch[] {
    const batches: PluginProjectionBatch[] = [];

    for (const record of input.facts.select({ schema: ROUTE_SCHEMA })) {
      if (record.subjectRef.type !== 'module') continue;
      const route = asRoute(record.value);
      if (!route) continue;
      const { moduleId } = record.subjectRef;
      batches.push({
        batchId: `route:${moduleId}:${route.method}:${route.path}`,
        delta: {
          entrypoints: [{
            kind: 'api-route',
            moduleRef: { type: 'module', moduleId },
            path: route.path,
            method: route.method,
            label: route.handler,
          }],
        },
      });
    }

    for (const record of input.facts.select({ schema: ORBIT_SERVICE_SCHEMA })) {
      if (record.subjectRef.type !== 'module') continue;
      const service = asOrbitService(record.value);
      if (!service) continue;
      const { moduleId } = record.subjectRef;
      batches.push({
        batchId: `binding:${moduleId}:${service.localKey}`,
        delta: {
          links: [{
            from: { type: 'module', moduleId },
            to: { type: 'resource', namespace: service.namespace, localKey: service.localKey },
            relation: 'binds-to',
            because: 'the orbit stack deploys this Go handler as that service',
          }],
        },
      });
    }

    return batches;
  },
};

const descriptor: PluginRuntimeDescriptor = definePlugin({
  id: PLUGIN_ID,
  capabilities: { source, projectors: [routeProjector] },
});

export default descriptor;
