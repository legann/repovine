import type { HandlerResolveContext } from './types.js';

function handlerPathPart(handlerRef: string): string | undefined {
  const idx = handlerRef.lastIndexOf('.');
  if (idx <= 0) return undefined;
  return handlerRef.slice(0, idx);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(v => v !== undefined))];
}

function joinRelPath(ctx: HandlerResolveContext, ...parts: Array<string | undefined>): string {
  return ctx.normalizeRelPath(parts.filter((p): p is string => Boolean(p)).join('/'));
}

const COMMON_BUILD_OUTPUT_ROOTS = new Set(['build', 'dist', 'dist-bundled', 'out']);

function sourceRootsFromArtifactRoot(ctx: HandlerResolveContext): string[] {
  if (!ctx.artifactRoot) return [];
  const artifactRoot = ctx.normalizeRelPath(ctx.artifactRoot);
  const roots = [artifactRoot];
  const segments = artifactRoot.split('/');

  for (let i = 0; i < segments.length; i += 1) {
    if (!COMMON_BUILD_OUTPUT_ROOTS.has(segments[i])) continue;
    const packageRoot = segments.slice(0, i).join('/');
    roots.push(joinRelPath(ctx, packageRoot, 'src'));
  }

  return uniqueStrings(roots);
}

function handlerPathMapCandidates(
  pathPart: string,
  ctx: HandlerResolveContext,
): string[] {
  const handlerPathMap = ctx.handlerPathMap ?? {};
  const keys = [pathPart];
  if (ctx.artifactRoot) {
    keys.push(joinRelPath(ctx, ctx.artifactRoot, pathPart));
  }
  return uniqueStrings(keys.map(key => handlerPathMap[key]).filter((x): x is string => Boolean(x)));
}

/**
 * Default Lambda handler convention for path-like runtimes:
 * `src/users.handler` resolves to a module at `src/users`, with host-provided artifact roots and
 * bundle aliases applied before lookup. Source plugins with FQCN/package-specific handler formats
 * should provide their own resolver.
 */
export function resolveDottedPathHandlerToModule(
  handlerRef: string,
  ctx: HandlerResolveContext,
): string | undefined {
  const pathPart = handlerPathPart(handlerRef);
  if (!pathPart) return undefined;

  const pathCandidates = uniqueStrings(
    [...handlerPathMapCandidates(pathPart, ctx), pathPart],
  );
  const artifactRoots = sourceRootsFromArtifactRoot(ctx);

  for (const rel of pathCandidates) {
    const normalizedRel = ctx.normalizeRelPath(rel);

    for (const root of artifactRoots) {
      const candidate = joinRelPath(ctx, root, normalizedRel);
      const modId = ctx.resolveModuleByRepoPath(candidate);
      if (modId) return modId;
    }

    const direct = ctx.resolveModuleByRepoPath(normalizedRel);
    if (direct) return direct;

    for (const root of ctx.searchRoots) {
      const candidate = joinRelPath(ctx, root, normalizedRel);
      const modId = ctx.resolveModuleByRepoPath(candidate);
      if (modId) return modId;
    }
  }

  return undefined;
}
