/**
 * Shared pagination / summary helpers for domain MCP tools.
 */

export const DOMAIN_TOP_MODULES_DEFAULT = 15;
export const DOMAIN_MODULE_LIMIT_MAX = 200;

export type DomainModuleRow = {
  id: string;
  label: string;
  exports?: number;
  links?: number;
};

export type DomainPaginationInput = {
  moduleLimit?: number;
  offset?: number;
  summaryOnly?: boolean;
};

export type DomainPaginationResult = {
  totalModules: number;
  returned: number;
  offset: number;
  truncated: boolean;
  summaryOnly: boolean;
  hint?: string;
};

export function parseDomainPaginationArgs(args: Record<string, unknown>): DomainPaginationInput {
  const moduleLimit = args.moduleLimit as number | undefined;
  const offset = args.offset as number | undefined;
  if (moduleLimit !== undefined && (moduleLimit < 1 || moduleLimit > DOMAIN_MODULE_LIMIT_MAX)) {
    throw new Error(`moduleLimit must be between 1 and ${DOMAIN_MODULE_LIMIT_MAX}`);
  }
  if (offset !== undefined && offset < 0) {
    throw new Error('offset must be >= 0');
  }
  return {
    moduleLimit,
    offset,
    summaryOnly: args.summaryOnly === true,
  };
}

export function sortModulesByConnectivity(modules: DomainModuleRow[]): DomainModuleRow[] {
  return [...modules].sort(
    (a, b) => (b.links ?? 0) - (a.links ?? 0) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
}

export function paginateDomainModules(
  modules: DomainModuleRow[],
  input: DomainPaginationInput,
): { modules: DomainModuleRow[]; topModules?: DomainModuleRow[]; pagination: DomainPaginationResult } {
  const total = modules.length;
  const summaryOnly = input.summaryOnly === true;
  const offset = Math.max(0, input.offset ?? 0);

  const sorted = sortModulesByConnectivity(modules);

  if (summaryOnly) {
    const topN = Math.min(input.moduleLimit ?? DOMAIN_TOP_MODULES_DEFAULT, DOMAIN_MODULE_LIMIT_MAX);
    const topModules = sorted.slice(0, topN);
    return {
      modules: [],
      topModules,
      pagination: {
        totalModules: total,
        returned: topModules.length,
        offset: 0,
        truncated: total > topModules.length,
        summaryOnly: true,
        hint:
          total > topModules.length
            ? `${total} modules in domain. summaryOnly returns top ${topModules.length} by link count. Set summaryOnly:false with moduleLimit/offset for a paginated list, or narrow the domain tag.`
            : undefined,
      },
    };
  }

  if (input.moduleLimit === undefined) {
    return {
      modules: sorted,
      pagination: {
        totalModules: total,
        returned: total,
        offset: 0,
        truncated: false,
        summaryOnly: false,
      },
    };
  }

  const limit = Math.min(input.moduleLimit, DOMAIN_MODULE_LIMIT_MAX);
  const page = sorted.slice(offset, offset + limit);
  const truncated = offset + page.length < total;
  const start = total === 0 ? 0 : offset + 1;
  const end = offset + page.length;

  return {
    modules: page,
    pagination: {
      totalModules: total,
      returned: page.length,
      offset,
      truncated,
      summaryOnly: false,
      hint: truncated
        ? `${total} modules. Showing ${start}-${end}. Pass offset:${end} with the same moduleLimit for the next page.`
        : offset > 0
          ? `Showing modules ${start}-${end} of ${total}.`
          : undefined,
    },
  };
}

export function flattenByPackage(
  byPackage: Record<string, Array<{ id: string; label: string }>>,
): Array<{ id: string; label: string }> {
  return Object.values(byPackage).flat();
}

export function regroupByPackage(
  entries: Array<{ id: string; label: string }>,
  graphPkgResolver: (moduleId: string) => string,
): Record<string, Array<{ id: string; label: string }>> {
  const byPkg = new Map<string, Array<{ id: string; label: string }>>();
  for (const entry of entries) {
    const pkg = graphPkgResolver(entry.id);
    let arr = byPkg.get(pkg);
    if (!arr) {
      arr = [];
      byPkg.set(pkg, arr);
    }
    arr.push(entry);
  }
  return Object.fromEntries(byPkg.entries());
}
