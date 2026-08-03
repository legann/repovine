declare const pathBase: unique symbol;

/**
 * An absolute path spelled for the current host filesystem.
 *
 * The brand is compile-time only: snapshots, workers and JSON still carry a plain string.
 */
export type HostPath = string & { readonly [pathBase]: 'host' };

/** A POSIX-separated path measured from the repository root. */
export type RepoRelPath = string & { readonly [pathBase]: 'repo' };

/** A POSIX-separated path measured from one package root. */
export type PkgRelPath = string & { readonly [pathBase]: 'package' };

/**
 * Assert the base of a path already obtained from a host-filesystem operation.
 *
 * This does not resolve or normalize: changing the spelling would change host-path map identity.
 */
export function asHostPath(value: string): HostPath {
  return value as HostPath;
}

/**
 * Assert that a value has already been measured from the repository root and POSIX-normalized.
 */
export function asRepoRelPath(value: string): RepoRelPath {
  return value as RepoRelPath;
}

/**
 * Assert that a value has already been measured from a package root and POSIX-normalized.
 */
export function asPkgRelPath(value: string): PkgRelPath {
  return value as PkgRelPath;
}
