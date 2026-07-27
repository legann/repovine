/**
 * Shared pagination / summary helpers for domain MCP tools.
 */
import { compareCodeUnits } from '../platform/ordering.js';
import { argTruncation, pageTruncation, type Truncation } from '../response/truncation.js';

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

export type DomainModuleSlice = {
  summaryOnly: boolean;
  truncation?: Truncation;
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
    (a, b) => (b.links ?? 0) - (a.links ?? 0) || compareCodeUnits(a.label, b.label) || compareCodeUnits(a.id, b.id),
  );
}

export function paginateDomainModules(
  modules: DomainModuleRow[],
  input: DomainPaginationInput,
): { modules: DomainModuleRow[]; topModules?: DomainModuleRow[]; pagination: DomainModuleSlice } {
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
        summaryOnly: true,
        // A summary is a mode, not a page: the rest is behind the flag, not behind an offset.
        ...(total > topModules.length
          ? {
            truncation: argTruncation({
              shown: topModules.length,
              total,
              arg: 'view',
              value: 'modules',
              hint: `A domain summary returns the top ${topModules.length} modules by link count; view:"modules" pages the whole list with limit/offset, or narrow the domain tag.`,
            }),
          }
          : {}),
      },
    };
  }

  if (input.moduleLimit === undefined) {
    return { modules: sorted, pagination: { summaryOnly: false } };
  }

  const limit = Math.min(input.moduleLimit, DOMAIN_MODULE_LIMIT_MAX);
  const page = sorted.slice(offset, offset + limit);
  const end = offset + page.length;

  return {
    modules: page,
    pagination: {
      summaryOnly: false,
      truncation: pageTruncation({
        shown: page.length,
        total,
        offset,
        noun: 'module',
        hint: `${total} modules. Showing ${total === 0 ? 0 : offset + 1}-${end}. Pass offset ${end} with the same limit for the next page.`,
      }),
    },
  };
}

export interface PackageGrouping {
  byPackage: Record<string, Array<{ id: string; label: string }>>;
  /** Entries whose owning package the graph does not name. Kept as a list: a package id is an id. */
  withoutPackage: Array<{ id: string; label: string }>;
}

export function flattenByPackage(grouping: PackageGrouping): Array<{ id: string; label: string }> {
  return [...Object.values(grouping.byPackage).flat(), ...grouping.withoutPackage];
}

export function regroupByPackage(
  entries: Array<{ id: string; label: string }>,
  graphPkgResolver: (moduleId: string) => string | undefined,
): PackageGrouping {
  const byPkg = new Map<string, Array<{ id: string; label: string }>>();
  const withoutPackage: Array<{ id: string; label: string }> = [];
  for (const entry of entries) {
    const pkg = graphPkgResolver(entry.id);
    if (pkg === undefined) {
      withoutPackage.push(entry);
      continue;
    }
    let arr = byPkg.get(pkg);
    if (!arr) {
      arr = [];
      byPkg.set(pkg, arr);
    }
    arr.push(entry);
  }
  return { byPackage: Object.fromEntries(byPkg.entries()), withoutPackage };
}
