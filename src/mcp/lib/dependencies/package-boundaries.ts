import type { McpToolRuntime } from '../../types.js';
import { modulePackageId, nodesOfType, packageModuleIds } from '../../../graph/index.js';
import { isBarrelModule, isBarrelRelPath, moduleDirPath, moduleRelPath } from '../../../graph/module-files.js';
import { stripModuleIdSuffix } from '../../../stage1/source/registry.js';
import { compareCodeUnits } from '../../../platform/ordering.js';
import { paginateList } from '../../response/pagination.js';
import { narrowTruncation, truncationMap } from '../../../response/truncation.js';

export function analyzePackageBoundaries(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, modulesById } = ctx.getState();
  const filterPkg = args.packageId as string | undefined;
  const direction = (args.direction as string) ?? 'both';
  const topN = (args.topN as number) ?? 5;
  const limit = typeof args.limit === 'number' ? Math.max(1, args.limit) : 20;
  const offset = typeof args.offset === 'number' ? Math.max(0, args.offset) : 0;

  const pkgOfModule = (modId: string): string | undefined => modulePackageId(graph, modId);

  type ModuleBoundaryEdge = {
    fromModuleId: string;
    fromModule: string;
    toModuleId: string;
    toModule: string;
    symbols: string[];
    barrelRedirected: boolean;
  };
  const edgeAgg = new Map<string, {
    from: string;
    to: string;
    moduleEdges: ModuleBoundaryEdge[];
  }>();

  for (const edge of graph.edges) {
    if (edge.kind !== 'imports') continue;
    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    if (!fromNode || fromNode.type !== 'module' || !toNode || toNode.type !== 'module') continue;

    const fromPkg = pkgOfModule(edge.from);
    const toPkg = pkgOfModule(edge.to);
    if (!fromPkg || !toPkg || fromPkg === toPkg) continue;

    if (filterPkg) {
      if (direction === 'imports' && fromPkg !== filterPkg) continue;
      if (direction === 'exports' && toPkg !== filterPkg) continue;
      if (direction === 'both' && fromPkg !== filterPkg && toPkg !== filterPkg) continue;
    }

    const key = `${fromPkg}→${toPkg}`;
    let entry = edgeAgg.get(key);
    if (!entry) {
      entry = { from: fromPkg, to: toPkg, moduleEdges: [] };
      edgeAgg.set(key, entry);
    }

    const directImports = modulesById.get(edge.from)?.imports
      .filter(i => i.resolvedModuleId === edge.to) ?? [];
    const symbols = directImports.flatMap(i => i.importedNames);

    entry.moduleEdges.push({
      fromModuleId: edge.from,
      fromModule: fromNode.label,
      toModuleId: edge.to,
      toModule: toNode.label,
      symbols,
      barrelRedirected: directImports.length === 0 && (edge.metadata?.usedNames?.length ?? 0) > 0,
    });
  }

  const isBarrel = (moduleId: string): boolean => isBarrelModule(graph, moduleId);

  // Resolved barrel imports can produce both importer→barrel and synthetic importer→leaf edges.
  // The latter has no direct import symbols and must not double-count the same package boundary.
  for (const entry of edgeAgg.values()) {
    const importersWithBarrelEntry = new Set(
      entry.moduleEdges
        .filter(edge => edge.symbols.length > 0 && isBarrel(edge.toModuleId))
        .map(edge => edge.fromModuleId),
    );
    const deduped = new Map<string, ModuleBoundaryEdge>();
    for (const edge of entry.moduleEdges) {
      if (
        edge.barrelRedirected
        && !isBarrel(edge.toModuleId)
        && importersWithBarrelEntry.has(edge.fromModuleId)
      ) continue;
      const edgeKey = `${edge.fromModuleId}\0${edge.toModuleId}`;
      const existing = deduped.get(edgeKey);
      if (!existing) {
        deduped.set(edgeKey, edge);
        continue;
      }
      existing.symbols = [...new Set([...existing.symbols, ...edge.symbols])];
    }
    entry.moduleEdges = [...deduped.values()];
  }

  const packages = new Set<string>();
  const edges: unknown[] = [];

  for (const entry of edgeAgg.values()) {
    packages.add(entry.from);
    packages.add(entry.to);
    entry.moduleEdges.sort((a, b) => b.symbols.length - a.symbols.length);
    edges.push({
      from: entry.from,
      to: entry.to,
      moduleEdges: entry.moduleEdges.length,
      direction: 'imports',
      topModuleEdges: entry.moduleEdges.slice(0, topN).map(me => ({
        fromModule: me.fromModule,
        toModule: me.toModule,
        symbols: me.symbols,
      })),
      // The cut is named the same way the importer preview beside it is: a count next to a slice is
      // not the bound block a reader looks for, and this list is capped on every edge that has more.
      ...(entry.moduleEdges.length > topN
        ? {
          truncation: {
            topModuleEdges: narrowTruncation({
              shown: topN,
              total: entry.moduleEdges.length,
              hint: 'Module edges are previewed per package edge; scope analyze_dependencies to one package for the full set.',
            }),
          },
        }
        : {}),
    });
  }

  (edges as Array<{ moduleEdges: number }>).sort((a, b) => b.moduleEdges - a.moduleEdges);

  type ViolationDetail = { fromModule: string; symbols: string[] };
  type ViolationGroup = {
    targetModule: string;
    targetModuleId: string;
    targetPackage: string;
    importedBy: ViolationDetail[];
    allSymbols: Set<string>;
  };
  const groups = new Map<string, ViolationGroup>();
  // Directories that hold a barrel, keyed by package: the violation is "this leaf was imported
  // across a package boundary while a barrel sits next to it". Both halves are read from the
  // modules' own file paths, so the answer does not change with how a label was spelled.
  const barrelDirsByPackage = new Map<string, Set<string>>();
  for (const modId of nodesOfType(graph, 'module')) {
    if (!isBarrelModule(graph, modId)) continue;
    const pkgId = pkgOfModule(modId);
    const dir = moduleDirPath(graph, modId);
    if (!pkgId || dir === undefined) continue;
    let dirs = barrelDirsByPackage.get(pkgId);
    if (!dirs) { dirs = new Set(); barrelDirsByPackage.set(pkgId, dirs); }
    dirs.add(dir);
  }

  for (const entry of edgeAgg.values()) {
    for (const me of entry.moduleEdges) {
      if (me.symbols.length === 0) continue;
      const toModLabel = me.toModule;
      if (isBarrel(me.toModuleId)) continue;
      const targetDir = moduleDirPath(graph, me.toModuleId);
      if (targetDir === undefined) continue;
      if (!barrelDirsByPackage.get(entry.to)?.has(targetDir)) continue;

      const groupKey = `${entry.to}|${toModLabel}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          targetModule: toModLabel,
          targetModuleId: me.toModuleId,
          targetPackage: entry.to,
          importedBy: [],
          allSymbols: new Set(),
        };
        groups.set(groupKey, group);
      }
      group.importedBy.push({ fromModule: me.fromModule, symbols: me.symbols });
      for (const s of me.symbols) group.allSymbols.add(s);
    }
  }

  /**
   * The package's public entry file: its shallowest barrel, package-relative path and all.
   *
   * Read from the modules' own file paths and the registry's index basenames, so a package whose
   * entry is `src/index.mjs` or `pkg/__init__.py` answers as readily as one whose entry is
   * `src/index.ts`. Returns both forms — the repo-relative one names the file to edit, the
   * package-relative one is what the export specifier is measured from.
   */
  const packageEntryFile = (pkgId: string): { repoPath: string; pkgRelPath: string } | undefined => {
    const pkgNode = graph.nodes.get(pkgId);
    if (pkgNode?.type !== 'package') return undefined;
    const barrels = packageModuleIds(graph, pkgId)
      .map(modId => moduleRelPath(graph, modId))
      .filter((rel): rel is string => rel !== undefined && isBarrelRelPath(rel))
      .sort(compareCodeUnits);
    if (barrels.length === 0) return undefined;
    // The shallowest barrel is the package's public entry — but only when it is the ONLY one at
    // that depth. `bin/index.ts` beside `src/index.ts` names two entries and no way to tell which
    // is public, so the answer is a refusal and the violation carries no suggested fix. Guessing
    // would put a ready-to-paste export into a file the package does not publish.
    const depth = Math.min(...barrels.map(rel => rel.split('/').length));
    const shallowest = barrels.filter(rel => rel.split('/').length === depth);
    const pkgRelPath = shallowest.length === 1 ? shallowest[0] : undefined;
    if (!pkgRelPath) return undefined;
    const pkgPath = pkgNode.data?.path;
    return { repoPath: pkgPath ? `${pkgPath}/${pkgRelPath}` : pkgRelPath, pkgRelPath };
  };

  /**
   * The specifier the entry file would import the target by.
   *
   * Both ends are real package-relative paths. The previous form rebuilt this from the target's
   * display label, which keeps at most two segments behind `…/`, so the suggestion named
   * `./nested/thing` for a file at `src/deep/nested/thing.ts` — a module that is not there.
   */
  const relativeImportSpecifier = (fromPkgRelPath: string, targetModuleId: string): string | undefined => {
    const targetRel = moduleRelPath(graph, targetModuleId);
    if (targetRel === undefined) return undefined;
    const fromDir = fromPkgRelPath.split('/').slice(0, -1);
    const toParts = stripModuleIdSuffix(targetRel).split('/');
    let shared = 0;
    while (shared < fromDir.length && shared < toParts.length - 1 && fromDir[shared] === toParts[shared]) shared++;
    const up = fromDir.length - shared;
    const rest = toParts.slice(shared).join('/');
    return up > 0 ? `${'../'.repeat(up)}${rest}` : `./${rest}`;
  };

  const boundaryViolations = [...groups.values()]
    .map(g => {
      const symbols = [...g.allSymbols].sort();
      const entryFile = packageEntryFile(g.targetPackage);
      const specifier = entryFile && relativeImportSpecifier(entryFile.pkgRelPath, g.targetModuleId);
      const suggestedFix = entryFile && specifier && symbols.length > 0
        ? {
            exportLocation: entryFile.repoPath,
            exportStatement: `export { ${symbols.join(', ')} } from '${specifier}';`,
            fixesViolations: g.importedBy.length,
          }
        : undefined;
      const shownImporters = g.importedBy.slice(0, 10);
      return {
        targetModule: g.targetModule,
        targetPackage: g.targetPackage,
        importedBy: shownImporters.map(d => ({
          from: d.fromModule,
          symbols: d.symbols,
        })),
        importerCount: g.importedBy.length,
        ...(g.importedBy.length > shownImporters.length
          ? {
            truncation: {
              importedBy: narrowTruncation({
                shown: shownImporters.length,
                total: g.importedBy.length,
                hint: 'Importer lists are previewed per violation; scope analyze_dependencies to the target package for the full set.',
              }),
            },
          }
          : {}),
        ...(suggestedFix ? { suggestedFix } : {}),
      };
    })
    .sort((a, b) => b.importerCount - a.importerCount);

  const pagedEdges = paginateList(edges, {
    limit, offset, noun: 'cross-package edge', narrow: 'filter by package scope or direction',
  });
  const pagedViolations = paginateList(boundaryViolations, {
    limit, offset, noun: 'boundary violation', narrow: 'filter by package scope',
  });
  const truncation = truncationMap({
    edges: pagedEdges.truncation,
    ...(boundaryViolations.length > 0 ? { boundaryViolations: pagedViolations.truncation } : {}),
  });
  return {
    packages: [...packages].sort(),
    edges: pagedEdges.page,
    ...(boundaryViolations.length > 0 ? { boundaryViolations: pagedViolations.page } : {}),
    ...(truncation ? { truncation } : {}),
  };
}
