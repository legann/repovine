import type { SemanticHints, RouteInfo } from '@repovine/plugin-sdk';

/** Raw route row emitted by the stdlib `ast` subprocess (see `extract.ts` PY_AST_SCRIPT). */
export interface RawFrameworkRoute {
  path: string;
  method?: string;
  component: string;
  line?: number;
  /** Server-rendered template names this route's view renders (same-file detection only). */
  rendersTemplate?: string[];
}

export type PythonWebFramework = 'fastapi' | 'django' | 'drf' | 'flask';

/** Normalize Django-style paths (`users/`) to absolute URL paths (`/users/`). Regex paths stay as-is. */
export function normalizeApiPath(path: string, framework?: PythonWebFramework | null): string {
  if (path.startsWith('^')) return path;
  if ((framework === 'django' || framework === 'drf') && !path.startsWith('/')) return `/${path}`;
  if (!path.startsWith('/')) return `/${path}`;
  return path;
}

/** Map ast-provable framework routes into `SemanticHints` (backend API only). */
export function frameworkHintsFromRaw(input: {
  framework?: PythonWebFramework | null;
  routes?: RawFrameworkRoute[];
}): Pick<SemanticHints, 'hasRoutes' | 'routes' | 'webFramework'> | undefined {
  const rawRoutes = input.routes ?? [];
  if (rawRoutes.length === 0) return undefined;

  const framework = input.framework ?? undefined;
  const routes: RouteInfo[] = rawRoutes.map(r => ({
    path: normalizeApiPath(r.path, framework),
    component: r.component,
    source: framework === 'fastapi' || framework === 'flask' ? 'decorator' : 'ast',
    kind: 'api',
    ...(r.method ? { method: r.method.toUpperCase() } : {}),
    ...(r.rendersTemplate && r.rendersTemplate.length > 0 ? { rendersTemplate: r.rendersTemplate } : {}),
  }));

  routes.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      (a.method ?? '').localeCompare(b.method ?? '') ||
      a.component.localeCompare(b.component),
  );

  return {
    hasRoutes: true,
    routes,
    ...(framework ? { webFramework: framework } : {}),
  };
}
