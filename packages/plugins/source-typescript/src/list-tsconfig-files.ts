import ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { walkRepository } from '@repovine/plugin-sdk';
import { TYPESCRIPT_SOURCE_EXTENSIONS } from './extensions.js';

export interface ParsedPackageTsConfig {
  fileNames: string[];
  compilerOptions: ts.CompilerOptions;
}

/** Child configs used only for tests/e2e — not indexed as application source. */
const SKIP_REFERENCE_CONFIG_RE = /\.(?:spec|test|e2e)(?:\.json)?$/i;

/** Entry-only app configs (main/index/polyfills/…) trigger a `src/` walk supplement. */
const ENTRYPOINT_BASENAME_RE = /^(?:main|index|polyfills|server|app)\.(?:[cm]?[jt]sx?)$/i;

const ENTRY_ONLY_FILE_THRESHOLD = 3;

const SOURCE_WALK_EXTENSIONS = new Set(TYPESCRIPT_SOURCE_EXTENSIONS);


function parseConfigAt(absConfigPath: string, configDir: string): ParsedPackageTsConfig {
  const configFile = ts.readConfigFile(absConfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.formatDiagnostic(configFile.error, {
      getCanonicalFileName: f => f,
      getCurrentDirectory: () => configDir,
      getNewLine: () => '\n',
    }));
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir);
  return { fileNames: parsed.fileNames, compilerOptions: parsed.options };
}

function getReferencesFromConfig(config: unknown): Array<{ path: string }> {
  if (!config || typeof config !== 'object') return [];
  const refs = (config as { references?: unknown }).references;
  if (!Array.isArray(refs)) return [];
  return refs.filter(
    (ref): ref is { path: string } =>
      ref != null
      && typeof ref === 'object'
      && typeof (ref as { path?: unknown }).path === 'string',
  );
}

function shouldFollowReference(pkgDir: string, refPath: string): boolean {
  const resolved = path.resolve(pkgDir, refPath);
  const rel = path.relative(pkgDir, resolved);
  if (rel.startsWith('..')) return false;

  const base = path.basename(resolved);
  if (SKIP_REFERENCE_CONFIG_RE.test(base) || SKIP_REFERENCE_CONFIG_RE.test(refPath)) return false;

  if (!base.endsWith('.json')) {
    const nestedTsconfig = path.join(resolved, 'tsconfig.json');
    if (fs.existsSync(nestedTsconfig)) return false;
  }

  return true;
}

function resolveReferencedConfigPath(pkgDir: string, refPath: string): string {
  const resolved = path.resolve(pkgDir, refPath);
  if (resolved.endsWith('.json')) return resolved;
  return path.join(resolved, 'tsconfig.json');
}

function mergeFileNames(target: string[], addition: readonly string[]): void {
  const seen = new Set(target);
  for (const file of addition) {
    if (seen.has(file)) continue;
    seen.add(file);
    target.push(file);
  }
}

function resolveFromReferences(pkgAbsPath: string, rootConfig: unknown): ParsedPackageTsConfig | null {
  const refs = getReferencesFromConfig(rootConfig);
  if (refs.length === 0) return null;

  const merged: ParsedPackageTsConfig = { fileNames: [], compilerOptions: {} };
  let foundAny = false;

  for (const ref of refs) {
    if (!shouldFollowReference(pkgAbsPath, ref.path)) continue;
    const configPath = resolveReferencedConfigPath(pkgAbsPath, ref.path);
    if (!fs.existsSync(configPath)) continue;

    try {
      const refParsed = parseConfigAt(configPath, path.dirname(configPath));
      mergeFileNames(merged.fileNames, refParsed.fileNames);
      if (Object.keys(merged.compilerOptions).length === 0) {
        merged.compilerOptions = refParsed.compilerOptions;
      }
      foundAny = true;
    } catch {
      continue;
    }
  }

  return foundAny ? merged : null;
}

function isEntryOnlyFileList(fileNames: readonly string[]): boolean {
  if (fileNames.length === 0 || fileNames.length > ENTRY_ONLY_FILE_THRESHOLD) return false;
  return fileNames.every(file => ENTRYPOINT_BASENAME_RE.test(path.basename(file)));
}

function walkSourceTree(srcDir: string): string[] {
  const results: string[] = [];
  // Prunes against the source directory it starts at: everything above it already passed the same
  // rule when `findAllTsconfigDirs` accepted the package.
  walkRepository(srcDir, {
    onFile: ({ absPath, name }) => {
      const ext = path.extname(name).toLowerCase();
      if (!SOURCE_WALK_EXTENSIONS.has(ext)) return;
      if (/\.(?:test|spec)\./i.test(name)) return;
      results.push(absPath);
    },
  });
  return results;
}

function supplementEntryOnlySources(pkgAbsPath: string, parsed: ParsedPackageTsConfig): ParsedPackageTsConfig {
  if (!isEntryOnlyFileList(parsed.fileNames)) return parsed;

  const srcDir = path.join(pkgAbsPath, 'src');
  if (!fs.existsSync(srcDir)) return parsed;

  const supplemented = [...parsed.fileNames];
  mergeFileNames(supplemented, walkSourceTree(srcDir));
  return { fileNames: supplemented, compilerOptions: parsed.compilerOptions };
}

/** Parse a package tsconfig and any same-package referenced fragments (app/lib/build configs). */
export function parsePackageTsConfig(pkgAbsPath: string): ParsedPackageTsConfig {
  const tsconfigPath = path.join(pkgAbsPath, 'tsconfig.json');
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.formatDiagnostic(configFile.error, {
      getCanonicalFileName: f => f,
      getCurrentDirectory: () => pkgAbsPath,
      getNewLine: () => '\n',
    }));
  }

  const primary = ts.parseJsonConfigFileContent(configFile.config, ts.sys, pkgAbsPath);
  let result: ParsedPackageTsConfig = {
    fileNames: [...primary.fileNames],
    compilerOptions: primary.options,
  };

  if (result.fileNames.length === 0) {
    const fromRefs = resolveFromReferences(pkgAbsPath, configFile.config);
    if (fromRefs && fromRefs.fileNames.length > 0) {
      result = { fileNames: fromRefs.fileNames, compilerOptions: result.compilerOptions };
    }
  }

  return supplementEntryOnlySources(pkgAbsPath, result);
}

export function listTsConfigSourceFiles(pkgAbsPath: string): string[] {
  return parsePackageTsConfig(pkgAbsPath).fileNames;
}
