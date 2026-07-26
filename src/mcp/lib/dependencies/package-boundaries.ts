import type { McpToolRuntime } from '../../types.js';
import { paginateList } from '../../response/pagination.js';
import { narrowTruncation, truncationMap } from '../../../response/truncation.js';

export function analyzePackageBoundaries(ctx: McpToolRuntime, args: Record<string, unknown>): unknown {
  const { graph, modulesById } = ctx.getState();
  const filterPkg = args.packageId as string | undefined;
  const direction = (args.direction as string) ?? 'both';
  const topN = (args.topN as number) ?? 5;
  const limit = typeof args.limit === 'number' ? Math.max(1, args.limit) : 20;
  const offset = typeof args.offset === 'number' ? Math.max(0, args.offset) : 0;

  const pkgOfModule = (modId: string): string | undefined => {
    const edges = graph.inEdges.get(modId) ?? [];
    const pkgEdge = edges.find(e => e.kind === 'contains' && e.from.startsWith('pkg:'));
    return pkgEdge?.from;
  };

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

  const isIndexModule = (label: string): boolean =>
    label.endsWith('/index') || label.endsWith('…/index');

  // Resolved barrel imports can produce both importer→barrel and synthetic importer→leaf edges.
  // The latter has no direct import symbols and must not double-count the same package boundary.
  for (const entry of edgeAgg.values()) {
    const importersWithBarrelEntry = new Set(
      entry.moduleEdges
        .filter(edge => edge.symbols.length > 0 && isIndexModule(edge.toModule))
        .map(edge => edge.fromModuleId),
    );
    const deduped = new Map<string, ModuleBoundaryEdge>();
    for (const edge of entry.moduleEdges) {
      if (
        edge.barrelRedirected
        && !isIndexModule(edge.toModule)
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
    });
  }

  (edges as Array<{ moduleEdges: number }>).sort((a, b) => b.moduleEdges - a.moduleEdges);

  type ViolationDetail = { fromModule: string; symbols: string[] };
  type ViolationGroup = {
    targetModule: string;
    targetPackage: string;
    importedBy: ViolationDetail[];
    allSymbols: Set<string>;
  };
  const groups = new Map<string, ViolationGroup>();
  const moduleLabels = new Set(
    [...(graph.byType.get('module') ?? [])]
      .map(id => graph.nodes.get(id)?.label)
      .filter((label): label is string => typeof label === 'string'),
  );

  for (const entry of edgeAgg.values()) {
    for (const me of entry.moduleEdges) {
      if (me.symbols.length === 0) continue;
      const toModLabel = me.toModule;
      if (isIndexModule(toModLabel)) continue;
      const indexLabel = toModLabel.replace(/\/[^/]+$/, '/index');
      if (!moduleLabels.has(indexLabel)) continue;

      const groupKey = `${entry.to}|${toModLabel}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          targetModule: toModLabel,
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

  const packageIndexPath = (pkgId: string): string | undefined => {
    const pkgNode = graph.nodes.get(pkgId);
    if (!pkgNode || pkgNode.type !== 'package') return undefined;
    const containedMods = (graph.outEdges.get(pkgId) ?? [])
      .filter(e => e.kind === 'contains')
      .map(e => e.to);
    for (const modId of containedMods) {
      const n = graph.nodes.get(modId);
      if (n?.type === 'module') {
        const relPath = n.data && 'relativeFilePath' in n.data ? (n.data as { relativeFilePath?: string }).relativeFilePath : undefined;
        if (relPath && (relPath.endsWith('/index.ts') || relPath.endsWith('/index.tsx'))) {
          if (relPath === 'src/index.ts' || relPath === 'src/index.tsx') {
            const pkgPath = pkgNode.data && 'path' in pkgNode.data ? (pkgNode.data as { path?: string }).path : undefined;
            return pkgPath ? `${pkgPath}/${relPath}` : relPath;
          }
        }
      }
    }
    return undefined;
  };

  const relativeImportFromLabel = (label: string): string => {
    const stripped = label.replace(/^…\//, '').replace(/^\.\.\.\//, '');
    return './' + stripped;
  };

  const boundaryViolations = [...groups.values()]
    .map(g => {
      const symbols = [...g.allSymbols].sort();
      const exportPath = packageIndexPath(g.targetPackage);
      const suggestedFix = exportPath && symbols.length > 0
        ? {
            exportLocation: exportPath,
            exportStatement: `export { ${symbols.join(', ')} } from '${relativeImportFromLabel(g.targetModule)}';`,
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
