import type { RepositoryFactsSnapshot } from '../types.js';
import { normalizeLinkingConfig } from '../stage1/linking-config.js';
import { resolveRelPath, toPosixPath } from '../platform/paths.js';

function dirnameRelPath(relPath: string): string {
  const normalized = resolveRelPath(relPath);
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(0, idx) : '';
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** SAM CodeUri or Terraform filename/zip path → search root relative to repo. */
export function resolveArtifactRoot(
  attributes: Record<string, string> | undefined,
  infraRelPath?: string,
): string | undefined {
  if (!attributes) return undefined;
  const codeUri = resolveCodeUriRoot(attributes.codeUri, infraRelPath);
  if (codeUri) return codeUri;
  const filename = attributes.filename;
  if (!filename) return undefined;
  const raw = toPosixPath(filename);
  if (/^[a-z]+:\/\//i.test(raw)) return undefined;
  const templateDir = infraRelPath ? dirnameRelPath(infraRelPath) : '';
  const joined = raw.startsWith('../') || raw.startsWith('./')
    ? resolveRelPath(templateDir ? `${templateDir}/${raw}` : raw)
    : resolveRelPath(raw);
  const withoutArchive = joined.replace(/\.(zip|jar|war)$/i, '');
  return dirnameRelPath(withoutArchive) || withoutArchive;
}

function resolveCodeUriRoot(codeUri: string | undefined, infraRelPath: string | undefined): string | undefined {
  if (!codeUri) return undefined;
  const raw = toPosixPath(codeUri).replace(/\/+$|^\.\/$/g, '');
  if (/^[a-z]+:\/\//i.test(raw)) return undefined;
  const templateDir = infraRelPath ? dirnameRelPath(infraRelPath) : '';
  if (!raw || raw === '.') return templateDir || undefined;
  if (raw.startsWith('./') || raw.startsWith('../')) {
    return resolveRelPath(templateDir ? `${templateDir}/${raw}` : raw);
  }
  return resolveRelPath(raw);
}

export function runtimeEntrySearchRoots(
  snapshot: RepositoryFactsSnapshot,
  attributes?: Record<string, string>,
  infraRelPath?: string,
): string[] {
  const linking = normalizeLinkingConfig(snapshot.linkingConfig);
  const roots: string[] = [];
  const artifactRoot = resolveArtifactRoot(attributes, infraRelPath);
  if (artifactRoot) roots.push(artifactRoot);
  roots.push(...linking.handlers.searchRoots);
  for (const pkg of snapshot.packages) {
    roots.push(pkg.repoRelDir);
    roots.push(resolveRelPath(`${pkg.repoRelDir}/src`));
  }
  roots.push('');
  return uniqueStrings(roots.map(resolveRelPath));
}
