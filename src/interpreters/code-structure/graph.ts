import type { ExportInfo, ModuleInfo, RepositoryGraph, RepositoryFactsSnapshot } from '../../types.js';
import { addNode, addEdge } from '../../graph/index.js';
import { shortModuleLabel } from '../../stage2/module-label.js';

/**
 * Structural graph contribution: root + packages + modules + import edges + export symbols +
 * implements edges. Lifted verbatim from stage2 pass1/pass2/pass3 (pass4 added with the dormant
 * `implements` edge activation). Trusted builtin layers mutate ctx.graph directly (the passes read
 * back node existence as they go), so the layer returns an empty delta; the legacy insertion order
 * is preserved exactly.
 */
export function contributeStructural(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): void {
  pass1Packages(graph, snapshot);
  pass2Modules(graph, snapshot);
  pass3ExportSymbols(graph, snapshot);
  pass4ImplementsEdges(graph, snapshot);
  passReExportEdges(graph, snapshot);
  passBarrelImportLinks(graph, snapshot);
}

// ── Pass 1: Root + packages ──

function pass1Packages(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): void {
  addNode(graph, {
    id: 'root',
    type: 'root',
    label: 'Repository',
    description: `Root of ${snapshot.packages.length} packages`,
  });

  for (const pkg of snapshot.packages) {
    const pkgId = `pkg:${pkg.name}`;
    addNode(graph, {
      id: pkgId,
      type: 'package',
      label: pkg.name,
      description: `Package ${pkg.name} (${pkg.path})`,
      data: { path: pkg.path, version: pkg.version, sourcePluginId: pkg.sourcePluginId },
    });
    addEdge(graph, 'root', pkgId, 'contains');
  }
}

// ── Pass 2: Modules + imports ──

function pass2Modules(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): void {
  for (const mod of snapshot.modules) {
    addNode(graph, {
      id: mod.id,
      type: 'module',
      label: shortModuleLabel(mod.relativeFilePath),
      description: `Module ${mod.relativeFilePath} in ${mod.packageName}`,
      data: {
        filePath: mod.filePath,
        relativeFilePath: mod.relativeFilePath,
        hasRoutes: mod.semanticHints?.hasRoutes ?? undefined,
        envVars: mod.semanticHints?.envVars,
        ssr: mod.semanticHints?.ssr,
        sourcePluginId: mod.sourcePluginId,
      },
    });

    const pkgId = `pkg:${mod.packageName}`;
    if (graph.nodes.has(pkgId)) {
      addEdge(graph, pkgId, mod.id, 'contains');
    }
  }

  // Import edges (only for module-level resolved imports). An edge is flagged type-only iff every
  // contributing import to that target is `import type` (erased at build); architecture detectors
  // filter those out (isRuntimeImportEdge), dependency-impact keeps them. Insertion order matches
  // the previous first-seen dedup, so edge ordering is preserved.
  for (const mod of snapshot.modules) {
    const targetTypeOnly = new Map<string, boolean>();
    for (const imp of mod.imports) {
      if (imp.isExternal || !imp.resolvedModuleId) continue;
      if (imp.resolvedModuleId.startsWith('pkg:')) continue;
      if (imp.resolvedModuleId === mod.id) continue;
      const prev = targetTypeOnly.get(imp.resolvedModuleId);
      targetTypeOnly.set(imp.resolvedModuleId, (prev ?? true) && (imp.isTypeOnly ?? false));
    }
    for (const [targetId, allTypeOnly] of targetTypeOnly) {
      if (graph.nodes.has(targetId)) {
        addEdge(graph, mod.id, targetId, 'imports', allTypeOnly ? { isTypeOnly: true } : undefined);
      }
    }
  }
}

// ── Pass 3: Export symbols (exports with symbol detail) ──

function pass3ExportSymbols(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): void {
  for (const mod of snapshot.modules) {
    for (const exp of mod.exports) {
      if (shouldSkipExport(exp)) continue;

      const capId = `export:${mod.id.slice(4)}/${exp.name}`;
      addNode(graph, {
        id: capId,
        type: 'export-symbol',
        label: capLabel(exp),
        description: capDescription(exp),
        data: {
          symbolKind: exp.kind,
          signature: exp.signature,
          params: exp.params,
          returnType: exp.returnType,
          typeValue: exp.typeValue,
          fields: exp.fields,
          implementsInterfaces: exp.implementsInterfaces,
          calls: exp.calls,
          privateMembers: exp.privateMembers,
          internals: exp.internals,
          lineRange: exp.lineRange,
          isDefault: exp.isDefault,
        },
      });
      addEdge(graph, mod.id, capId, 'contains');
    }
  }
}

// ── Pass 4: Implements edges (class export-symbol → interface export-symbol) ──

/**
 * Materialize the `implements` edge from the neutral `implementsInterfaces` fact. Runs after
 * pass3 so every `export-symbol` node already exists. Language-agnostic by construction: it only
 * consumes neutral facts the source plugin already emits — `ExportInfo.implementsInterfaces` (the
 * interface names), `ImportInfo.importedNames`, and `ImportInfo.resolvedModuleId`. No language
 * branch lives here; remaining language specifics (aliases beyond local binding, namespace-qualified
 * names, re-export chains) are honest under-capture, not a special case.
 */
function pass4ImplementsEdges(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): void {
  for (const mod of snapshot.modules) {
    for (const exp of mod.exports) {
      const ifaceNames = exp.implementsInterfaces;
      if (!ifaceNames || ifaceNames.length === 0) continue;

      const classId = `export:${mod.id.slice(4)}/${exp.name}`;
      if (!graph.nodes.has(classId)) continue;

      const seen = new Set<string>();
      for (const ifaceName of ifaceNames) {
        const targetId = resolveImplementsTarget(graph, mod, ifaceName);
        if (!targetId || targetId === classId || seen.has(targetId)) continue;
        seen.add(targetId);
        addEdge(graph, classId, targetId, 'implements');
      }
    }
  }
}

/**
 * Resolve an interface name to its `export-symbol` node id on already-existing neutral facts:
 *   1. declared in the same module, or
 *   2. imported by local name (importedNames carries the local binding, so `IFoo as IBar`
 *      aliases resolve — both sides are local).
 * External / unresolved / re-exported-through-barrel names return undefined (honest skip).
 */
function resolveImplementsTarget(
  graph: RepositoryGraph,
  mod: ModuleInfo,
  ifaceName: string,
): string | undefined {
  const sameModuleId = `export:${mod.id.slice(4)}/${ifaceName}`;
  if (graph.nodes.has(sameModuleId)) return sameModuleId;

  for (const imp of mod.imports) {
    if (imp.isExternal || !imp.resolvedModuleId) continue;
    if (!imp.resolvedModuleId.startsWith('mod:')) continue;
    if (!imp.importedNames.includes(ifaceName)) continue;
    const importedId = `export:${imp.resolvedModuleId.slice(4)}/${ifaceName}`;
    if (graph.nodes.has(importedId)) return importedId;
  }

  return undefined;
}

// ── Pass: Re-export edges (barrel → re-exported module) ──

/**
 * Materialize the `reexports` edge from the neutral `reExports` fact: a barrel module that does
 * `export * from './x'` / `export { y } from './x'` gets an edge to each resolved target. Built-in
 * structural fact; the barrel-import linker (next pass) follows these to the defining leaf.
 */
function passReExportEdges(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): void {
  for (const mod of snapshot.modules) {
    if (!mod.reExports?.length) continue;
    const seen = new Set<string>();
    for (const re of mod.reExports) {
      const target = re.resolvedModuleId;
      if (!target || !target.startsWith('mod:') || target === mod.id || seen.has(target)) continue;
      seen.add(target);
      if (graph.nodes.has(target)) addEdge(graph, mod.id, target, 'reexports');
    }
  }
}

// ── Pass: Barrel import links (importer → defining leaf, across re-export barrels) ──

/**
 * Resolve a barrel-routed import to the defining leaf. An `import { x } from 'pkg'` resolves to the
 * package's entry/barrel module; this follows the barrel's re-export chain (star re-exports always,
 * named re-exports only when they carry the imported name) to the module whose own `exports[]`
 * declares `x`, and adds an `importer → leaf` import edge. So a cross-package consumer becomes a
 * resolved (not name-only) caller of the leaf's export. Memoized per (barrel, name).
 */
function passBarrelImportLinks(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): void {
  const modulesById = new Map(snapshot.modules.map(m => [m.id, m] as const));
  const leafCache = new Map<string, string[]>();

  const resolveLeaves = (barrelId: string, name: string): string[] => {
    const cacheKey = `${barrelId}\t${name}`;
    const cached = leafCache.get(cacheKey);
    if (cached) return cached;
    const leaves: string[] = [];
    const visited = new Set<string>([barrelId]);
    const queue: string[] = [barrelId];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      const mod = modulesById.get(id);
      if (!mod) continue;
      if (id !== barrelId && mod.exports.some(e => e.name === name)) {
        leaves.push(id);
        continue; // a module that declares the name is the leaf; do not descend past it.
      }
      for (const re of mod.reExports ?? []) {
        const target = re.resolvedModuleId;
        if (!target || !target.startsWith('mod:') || visited.has(target)) continue;
        if (!re.isStar && !re.names?.includes(name)) continue;
        visited.add(target);
        queue.push(target);
      }
    }
    leafCache.set(cacheKey, leaves);
    return leaves;
  };

  for (const mod of snapshot.modules) {
    const existing = new Set(
      (graph.outEdges.get(mod.id) ?? []).filter(e => e.kind === 'imports').map(e => e.to),
    );
    // Accumulate the imported names that route to each leaf, so the redirected edge carries every
    // name (the reverse-by-export query filters on it) and we add one edge per leaf.
    const namesByLeaf = new Map<string, Set<string>>();
    const leafHasValueImport = new Set<string>(); // a leaf reached by ≥1 value import is a runtime edge
    for (const imp of mod.imports) {
      const target = imp.resolvedModuleId;
      if (imp.isExternal || !target || !target.startsWith('mod:')) continue;
      const barrel = modulesById.get(target);
      if (!barrel?.reExports?.length) continue; // not a barrel — pass2 already added importer → target.
      for (const name of imp.importedNames) {
        if (name.startsWith('* as ')) continue; // namespace import: no single name to resolve.
        for (const leafId of resolveLeaves(target, name)) {
          if (leafId === mod.id || existing.has(leafId)) continue;
          let set = namesByLeaf.get(leafId);
          if (!set) { set = new Set(); namesByLeaf.set(leafId, set); }
          set.add(name);
          if (!imp.isTypeOnly) leafHasValueImport.add(leafId);
        }
      }
    }
    for (const [leafId, names] of namesByLeaf) {
      if (graph.nodes.has(leafId)) {
        addEdge(graph, mod.id, leafId, 'imports', leafHasValueImport.has(leafId)
          ? { usedNames: [...names] }
          : { usedNames: [...names], isTypeOnly: true });
      }
    }
  }
}

/**
 * Drop a default export only when nothing can name it — `export default { … }` or a bare literal
 * would project a node labelled `default` carrying no information. A default that re-exports a
 * named local declaration (`const plugin = …; export default plugin`) is kept: for a plugin
 * descriptor that default IS the module's whole contract, and dropping it made such modules read
 * as exporting nothing at all.
 */
function shouldSkipExport(exp: ExportInfo): boolean {
  if (exp.name === 'default' && !exp.signature && !exp.defaultLocalName) return true;
  return false;
}

/** Display name: a signature-less default is shown with the local declaration it points at. */
function capLabel(exp: ExportInfo): string {
  if (exp.name === 'default' && !exp.signature && exp.defaultLocalName) {
    return `default (${exp.defaultLocalName})`;
  }
  return exp.name;
}

function capDescription(exp: ExportInfo): string {
  const label = capLabel(exp);
  if (exp.signature) return `${exp.kind} ${label}: ${exp.signature}`;
  return `${exp.kind} ${label}`;
}
