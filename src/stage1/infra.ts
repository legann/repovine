import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type { IaCDocFormat, InfraModuleInfo, PackageInfo } from '../types.js';
import { HASH_WIDTH, sha256Hex, walkRepository } from '@repovine/plugin-sdk';
import { CLOUDFORMATION_SAFE_SCHEMA } from './iac/yaml-schema.js';
// Side-effect import: registers all built-in IaC parsers in the shared registry.
import './iac/bootstrap.js';
import {
  getParsers,
  isInfraCandidate,
  parserMatchesFile,
  pickDocFormatForFile,
} from './iac/registry.js';
import type { CompiledScanPatterns } from '../scan-filters.js';
import { shouldScanInfraPath } from '../scan-filters.js';
import { infraNodeId } from '../graph/node-ids.js';

export interface InfraScanOptions {
  repoRoot: string;
  /** Unused by the scan itself (infra discovery is filesystem-driven from repoRoot); kept
   * optional so callers may pass it without effect. */
  packages?: PackageInfo[];
  /** Compiled `scan.include` / `scan.exclude` from repovine.config.json. */
  scanPatterns?: CompiledScanPatterns;
}

/**
 * Recursively discover candidate infra files under dir, relative to repoRoot.
 * A file is a candidate if any registered parser claims it via its fileMatch (or if a parser
 * declared no fileMatch, in which case it sees everything).
 */
function discoverInfraFiles(repoRoot: string, dir: string, out: { filePath: string; relPath: string }[]): void {
  walkRepository(dir, {
    repoRoot,
    onFile: ({ absPath, relFromRoot, name }) => {
      const ext = path.extname(name).toLowerCase();
      if (!isInfraCandidate(name, ext)) return;
      out.push({ filePath: absPath, relPath: relFromRoot });
    },
  });
}

function mergeInfraModule(
  infraModules: InfraModuleInfo[],
  byId: Map<string, InfraModuleInfo>,
  mod: InfraModuleInfo,
): void {
  const existing = byId.get(mod.id);
  if (!existing) {
    byId.set(mod.id, mod);
    infraModules.push(mod);
    return;
  }

  // Same id ⇒ same kind ⇒ same relPath ⇒ same file, so the engine-stamped module contentHash is
  // already identical; only the per-document resources need to be folded together.
  existing.resources.push(...mod.resources);
}

/** Engine-owned module fingerprint: hash the raw infra file once, like collectTemplates.
 * Empty sentinel when unreadable so a later run re-reads. */
function infraFileContentHash(filePath: string): string {
  try {
    return sha256Hex(fs.readFileSync(filePath, 'utf8'), HASH_WIDTH.content);
  } catch {
    return '';
  }
}

function readDocsByFormat(filePath: string, relPath: string, format: IaCDocFormat): unknown[] | null {
  try {
    if (format === 'dockerfile' || format === 'hcl' || format === 'raw') {
      return [fs.readFileSync(filePath, 'utf8')];
    }
    if (format === 'json') {
      const text = fs.readFileSync(filePath, 'utf8');
      return [JSON.parse(text)];
    }
    // yaml — also covers SAM/CloudFormation thanks to the CFN-safe schema.
    const text = fs.readFileSync(filePath, 'utf8');
    return yaml.loadAll(text, null, { schema: CLOUDFORMATION_SAFE_SCHEMA })
      .filter((doc): doc is NonNullable<unknown> => doc != null);
  } catch (err) {
    if (process.env.REPOVINE_VERBOSE) {
      console.warn(`  ⚠ Infra: failed to read ${relPath}:`, (err as Error).message);
    }
    return null;
  }
}

function readInfraDocuments(filePath: string, relPath: string): unknown[] | null {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  const format = pickDocFormatForFile(base, ext);
  if (!format) return null;
  return readDocsByFormat(filePath, relPath, format);
}

export function collectInfraModules(options: InfraScanOptions): InfraModuleInfo[] {
  const { repoRoot, scanPatterns } = options;
  const infraModules: InfraModuleInfo[] = [];
  const modulesById = new Map<string, InfraModuleInfo>();

  const candidates: { filePath: string; relPath: string }[] = [];
  discoverInfraFiles(repoRoot, repoRoot, candidates);
  if (candidates.length === 0) return infraModules;

  const parsers = getParsers();
  for (const { filePath, relPath } of candidates) {
    if (scanPatterns && !shouldScanInfraPath(relPath, scanPatterns)) continue;
    const docs = readInfraDocuments(filePath, relPath);
    if (!docs) continue;

    const base = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    // Module-level metadata is engine-owned: a single raw-file fingerprint shared by every
    // document the file produces. Computed once per file regardless of parser/doc count.
    const fileContentHash = infraFileContentHash(filePath);

    for (const doc of docs) {
      for (const parser of parsers) {
        if (!parserMatchesFile(parser, base, ext)) continue;
        if (!parser.supports(filePath, doc)) continue;
        const delta = parser.parse(filePath, relPath, doc);
        if (delta) {
          // Stamp all mechanical/agnostic fields here; the parser supplied only infra semantics.
          mergeInfraModule(infraModules, modulesById, {
            id: infraNodeId(delta.kind, relPath),
            kind: delta.kind,
            filePath,
            relativeFilePath: relPath,
            contentHash: fileContentHash,
            resources: delta.resources,
          });
        }
        break;
      }
    }
  }

  return infraModules;
}
