import * as fs from 'node:fs';
import { z } from 'zod';
import { compileGlob, type GlobMatcher } from '@repovine/plugin-sdk';
import { domainsConfigFilePath } from '../paths.js';
import { domainLabelSlug, domainSlug } from './domain-slug.js';

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
     * witness rule. Off by default; `infra.keep` overrides it per resource. */
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
  /** Precomputed alias -> canonical, both in the label alphabet; set by loadDomainsConfig. */
  _aliasToCanonical?: Record<string, string>;
  /** Precomputed matchers for basename.files globs; set by loadDomainsConfig. */
  _fileAsDomainInclude?: GlobMatcher[];
  _fileAsDomainExclude?: GlobMatcher[];
  /** Precomputed structuralDirs set, in the label alphabet; set by loadDomainsConfig. */
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
 * The glob dialect a domains pattern is written in ships in the SDK: `build.scan` is matched by both
 * the engine and the producers it hands compiled patterns to, so the matcher has one implementation.
 * Domains patterns are compiled with the same one.
 */
export { compileGlob };
export type { GlobMatcher };

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
    // Both halves are spelled in the label alphabet: a config key written `Foo Bar` names the
    // domain node `domain:foo-bar`, so `foo-bar` is the spelling a caller's scope argument carries
    // and the spelling the table must answer to.
    for (const [canonical, entry] of Object.entries(config.domains ?? {})) {
      const label = domainLabelSlug(canonical);
      if (!label) continue;
      aliasMap[label] = label;
      for (const alias of entry.aliases ?? []) {
        const aliasLabel = domainLabelSlug(String(alias));
        if (aliasLabel) aliasMap[aliasLabel] = label;
      }
    }
    if (Object.keys(aliasMap).length > 0) {
      config._aliasToCanonical = aliasMap;
    }

    if (Array.isArray(config.basename?.files?.include)) {
      config._fileAsDomainInclude = config.basename.files.include.map(compileGlob);
    }
    if (Array.isArray(config.basename?.files?.exclude)) {
      config._fileAsDomainExclude = config.basename.files.exclude.map(compileGlob);
    }
    if (Array.isArray(config.structuralDirs)) {
      config._structuralDirs = new Set(config.structuralDirs.map(d => domainSlug(String(d))));
    }
    return config;
  } catch (err) {
    console.error(`Domains config: failed to parse ${filePath}, ignoring file — ${(err as Error).message}`);
    return null;
  }
}
