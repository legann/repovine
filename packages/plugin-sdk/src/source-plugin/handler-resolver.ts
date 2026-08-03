import type { HandlerResolveContext } from './types.js';
import type { RepoRelPath } from '../path-contract.js';

function handlerPathPart(handlerRef: string): string | undefined {
  const idx = handlerRef.lastIndexOf('.');
  if (idx <= 0) return undefined;
  return handlerRef.slice(0, idx);
}

function uniqueRepoRelPaths(values: RepoRelPath[]): RepoRelPath[] {
  return [...new Set(values.filter(v => v !== undefined))];
}

function joinRepoRelPath(ctx: HandlerResolveContext, ...parts: Array<string | undefined>): RepoRelPath {
  return ctx.normalizeRepoRelPath(parts.filter((p): p is string => Boolean(p)).join('/'));
}

const COMMON_BUILD_OUTPUT_ROOTS = new Set(['build', 'dist', 'dist-bundled', 'out']);

function sourceRootsFromArtifactRoot(ctx: HandlerResolveContext): RepoRelPath[] {
  if (!ctx.repoRelArtifactRoot) return [];
  const artifactRoot = ctx.normalizeRepoRelPath(ctx.repoRelArtifactRoot);
  const roots = [artifactRoot];
  const segments = artifactRoot.split('/');

  for (let i = 0; i < segments.length; i += 1) {
    if (!COMMON_BUILD_OUTPUT_ROOTS.has(segments[i])) continue;
    const packageRoot = segments.slice(0, i).join('/');
    roots.push(joinRepoRelPath(ctx, packageRoot, 'src'));
  }

  return uniqueRepoRelPaths(roots);
}

function handlerPathMapCandidates(
  pathPart: string,
  ctx: HandlerResolveContext,
): RepoRelPath[] {
  const handlerPathMap = ctx.repoRelHandlerPathMap ?? {};
  const keys = [pathPart];
  if (ctx.repoRelArtifactRoot) {
    keys.push(joinRepoRelPath(ctx, ctx.repoRelArtifactRoot, pathPart));
  }
  return uniqueRepoRelPaths(
    keys.map(key => handlerPathMap[key]).filter((x): x is RepoRelPath => Boolean(x)),
  );
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

  const pathCandidates = uniqueRepoRelPaths(
    [...handlerPathMapCandidates(pathPart, ctx), ctx.normalizeRepoRelPath(pathPart)],
  );
  const artifactRoots = sourceRootsFromArtifactRoot(ctx);

  for (const rel of pathCandidates) {
    const normalizedRel = ctx.normalizeRepoRelPath(rel);

    for (const root of artifactRoots) {
      const candidate = joinRepoRelPath(ctx, root, normalizedRel);
      const modId = ctx.resolveModuleByRepoRelPath(candidate);
      if (modId) return modId;
    }

    const direct = ctx.resolveModuleByRepoRelPath(normalizedRel);
    if (direct) return direct;

    for (const root of ctx.repoRelSearchRoots) {
      const candidate = joinRepoRelPath(ctx, root, normalizedRel);
      const modId = ctx.resolveModuleByRepoRelPath(candidate);
      if (modId) return modId;
    }
  }

  return undefined;
}
