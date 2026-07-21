import * as fs from 'node:fs';
import { z } from 'zod';
import { domainsConfigFilePath } from '../paths.js';

const stringArray = z.array(z.string());
const stringRecord = z.record(z.string(), z.string());

export const DomainsConfigSchema = z.object({
  domains: z.record(z.string(), z.object({
    paths: stringArray.optional(),
    aliases: stringArray.optional(),
  })).optional(),
  infra: z.object({
    excludeSuffixes: stringArray.optional(),
    excludePatterns: stringArray.optional(),
    /** Committed "keep and stop suggesting" markers — the symmetric counterpart of exclude. Inert
     * resources listed here stay materialized AND are dropped from advisor suggestions, surviving a
     * `.repovine/` wipe (unlike the machine-local declined cache). Also the opt-out for `pruneInert`. */
    keep: z.object({
      suffixes: stringArray.optional(),
      patterns: stringArray.optional(),
    }).optional(),
    /** When true, runtime-resource nodes that no load-bearing edge witnesses (only structural
     * contains/tagged) are pruned from the graph after it builds — the builder-level form of the
     * witness rule (D6). Off by default; `infra.keep` overrides it per resource. */
    pruneInert: z.boolean().optional(),
  }).optional(),
  basename: z.object({
    pascalCase: z.enum(['lightweight', 'reject']).optional(),
    files: z.object({
      include: stringArray.optional(),
      exclude: stringArray.optional(),
    }).optional(),
  }).optional(),
  packages: z.object({
    enabled: z.boolean().optional(),
    exclude: stringArray.optional(),
    rename: stringRecord.optional(),
    merge: z.record(z.string(), stringArray).optional(),
  }).optional(),
  structuralDirs: stringArray.optional(),
}).strict();

export type DomainsConfigFile = z.infer<typeof DomainsConfigSchema>;

export interface DomainsConfig extends DomainsConfigFile {
  /** Precomputed alias (lowercase) -> canonical; set by loadDomainsConfig for O(1) resolve. */
  _aliasToCanonical?: Record<string, string>;
  /** Precomputed regex versions of basename.files globs; set by loadDomainsConfig. */
  _fileAsDomainInclude?: RegExp[];
  _fileAsDomainExclude?: RegExp[];
  /** Precomputed structuralDirs set (lowercase); set by loadDomainsConfig. */
  _structuralDirs?: Set<string>;
}

export const DOMAINS_CONFIG_MERGE_STRATEGY = {
  'domains.<canonical>.paths': 'by-id + array-union',
  'domains.<canonical>.aliases': 'by-id + array-union',
  'infra.excludeSuffixes': 'array-union',
  'infra.excludePatterns': 'array-union',
  'infra.keep.suffixes': 'array-union',
  'infra.keep.patterns': 'array-union',
  'infra.pruneInert': 'set-once',
  'basename.pascalCase': 'set-once',
  'basename.files.include': 'array-union',
  'basename.files.exclude': 'array-union',
  'packages.enabled': 'set-once',
  'packages.exclude': 'array-union',
  'packages.rename': 'key-union',
  'packages.merge': 'key-union',
  structuralDirs: 'array-union',
} as const;

/**
 * Convert a glob like `**\/*.controller.ts` to a regex anchored to the full string.
 * Supports: `*` (any chars except `/`), `**` (any chars including `/`), `?` (single char).
 * Brace expansion is NOT supported — keep globs simple.
 */
export function globToRegex(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (glob[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * Load optional domains config from repo.
 *
 * First-version schema only: the loader accepts the consolidated domains/infra/basename/
 * packages/structuralDirs shape and returns null for absent or invalid files.
 */
export function loadDomainsConfig(repoRoot: string): DomainsConfig | null {
  const filePath = domainsConfigFilePath(repoRoot);
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = DomainsConfigSchema.safeParse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    if (!parsed.success) {
      console.error(`Domains config: validation errors in ${filePath}, ignoring file\n${parsed.error.message}`);
      return null;
    }

    const config: DomainsConfig = parsed.data;
    const aliasMap: Record<string, string> = {};
    for (const [canonical, entry] of Object.entries(config.domains ?? {})) {
      aliasMap[canonical.toLowerCase()] = canonical;
      for (const alias of entry.aliases ?? []) {
        aliasMap[String(alias).toLowerCase()] = canonical;
      }
    }
    if (Object.keys(aliasMap).length > 0) {
      config._aliasToCanonical = aliasMap;
    }

    if (Array.isArray(config.basename?.files?.include)) {
      config._fileAsDomainInclude = config.basename.files.include.map(globToRegex);
    }
    if (Array.isArray(config.basename?.files?.exclude)) {
      config._fileAsDomainExclude = config.basename.files.exclude.map(globToRegex);
    }
    if (Array.isArray(config.structuralDirs)) {
      config._structuralDirs = new Set(config.structuralDirs.map(d => String(d).toLowerCase()));
    }
    return config;
  } catch (err) {
    console.error(`Domains config: failed to parse ${filePath}, ignoring file — ${(err as Error).message}`);
    return null;
  }
}
