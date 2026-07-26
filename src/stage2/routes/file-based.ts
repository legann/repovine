import type { RepositoryFactsSnapshot } from '../../types.js';

export interface FileBasedRoute {
  path: string;
  framework: string;
  moduleId: string;
  fileType: string;
  method?: string;
}

/**
 * Infer file-based routes from normalized RouteInfo hints.
 *
 * Source plugins are the canonical inference point: this helper only projects enriched
 * `semanticHints.routes` into the legacy MCP shape used by entrypoints.
 */
export function inferFileBasedRoutes(snapshot: Pick<RepositoryFactsSnapshot, 'modules'>): FileBasedRoute[] {
  const out: FileBasedRoute[] = [];

  for (const mod of snapshot.modules) {
    for (const route of mod.semanticHints?.routes ?? []) {
      if (route.source !== 'file' || !route.framework || !route.fileType) continue;
      out.push({
        path: route.path,
        framework: route.framework,
        moduleId: mod.id,
        fileType: route.fileType,
        ...(route.method ? { method: route.method } : {}),
      });
    }
  }
  return out;
}

export function fileBasedEntryKind(fileType: string): 'page' | 'route' | 'api' {
  if (fileType === 'page' || fileType === 'layout' || fileType === 'default') return 'page';
  if (fileType === 'api' || fileType === 'server' || fileType === 'server-api' || fileType === 'route') return 'api';
  return 'route';
}
