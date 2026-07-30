import type { SemanticHints, RouteInfo } from '@repovine/plugin-sdk';
import { compareCodeUnits } from '@repovine/plugin-sdk';
/** Raw route row emitted by the stdlib `ast` subprocess (see `extract.ts` PY_AST_SCRIPT). */
export interface RawFrameworkRoute {
  path: string;
  method?: string;
  component: string;
  line?: number;
  /** Server-rendered template names this route's view renders (same-file detection only). */
  rendersTemplate?: string[];
  /**
   * How this row was declared, when the extractor knows per row rather than per framework.
   *
   * aiohttp is why this exists: it declares routes both by decorating a handler
   * (`@routes.get('/x')`) and by a registration call (`app.router.add_get('/x', h)`), so the
   * framework alone does not answer the question.
   */
  syntax?: 'decorator' | 'call';
}

export type PythonWebFramework = 'fastapi' | 'django' | 'drf' | 'flask' | 'aiohttp';

/** Frameworks whose routes are declared by decorating the handler, rather than by a registration call. */
const DECORATOR_FRAMEWORKS = new Set<PythonWebFramework>(['fastapi', 'flask', 'aiohttp']);

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
    declaredIn: 'code',
    syntax: r.syntax ?? (framework && DECORATOR_FRAMEWORKS.has(framework) ? 'decorator' : 'call'),
    kind: 'api',
    ...(r.method ? { method: r.method.toUpperCase() } : {}),
    ...(r.rendersTemplate && r.rendersTemplate.length > 0 ? { rendersTemplate: r.rendersTemplate } : {}),
  }));

  routes.sort(
    (a, b) =>
      compareCodeUnits(a.path, b.path) ||
      compareCodeUnits(a.method ?? '', b.method ?? '') ||
      compareCodeUnits(a.component, b.component),
  );

  return {
    hasRoutes: true,
    routes,
    ...(framework ? { webFramework: framework } : {}),
  };
}
