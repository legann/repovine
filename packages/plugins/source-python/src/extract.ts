import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import { asHostPath } from '@repovine/plugin-sdk';
import type { HostPath, SemanticHints, ExportInfo, ImportInfo, ModuleInfo, PendingModule, SemanticModuleDelta } from '@repovine/plugin-sdk';
import type { SourceExtractInput, SourceExtractResult } from '@repovine/plugin-sdk';
import type { PythonExtractContext } from './discover.js';
import { resolvePythonImport } from './resolve-import.js';
import { effectImportsFromPythonImports } from './effect-imports.js';
import { frameworkHintsFromRaw, type RawFrameworkRoute } from './framework-hints.js';

/**
 * Python extraction (Pass 2). Parses a shard of `.py` files with the stdlib `ast` module in a
 * single `python -c` subprocess (file paths arrive on stdin), then maps the JSON result to
 * `ModuleInfo`. Deterministic: `ast` output is stable, and modules are emitted in input order.
 *
 * Scope: top-level `import` / `from` → ImportInfo; top-level `def` / `class` / assignment /
 * `__all__` re-exports → ExportInfo; literal env access + unambiguous effect imports →
 * SemanticHints (envVars / effectImports); FastAPI / Django / DRF web routes →
 * backend API routes (`semanticHints.routes`). See DESIGN.md (source parser architecture). No type inference.
 */

let cachedPyAstScriptPath: string | null | undefined;

/** Resolve the colocated source/package asset on first extraction only. `null` caches a failed
 * probe so a broken installation cannot turn every refresh into repeated synchronous filesystem IO.
 * The subprocess runs the script FILE (`python <path>`): inlining the ~35KB source via `-c` blows
 * the Windows 32767-char CreateProcess command-line limit (spawn ENAMETOOLONG). */
function resolvePyAstScriptPath(): string | undefined {
  if (cachedPyAstScriptPath !== undefined) return cachedPyAstScriptPath ?? undefined;
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'route-ast-script.py');
  try {
    fs.accessSync(scriptPath, fs.constants.R_OK);
    cachedPyAstScriptPath = scriptPath;
    return scriptPath;
  } catch (e) {
    cachedPyAstScriptPath = null;
    console.warn(`  ⚠ Python AST extraction unavailable: could not load ${scriptPath}: ${(e as Error).message}`);
    return undefined;
  }
}

interface RawImport {
  module: string;
  level: number;
  names: string[];
  kind: 'import' | 'from';
}
interface RawExport {
  name: string;
  kind: 'function' | 'class' | 'const';
  line: number;
  endLine: number;
}
interface RawDunderAllEntry {
  name: string;
  line: number;
  endLine: number;
}
interface RawModule {
  filePath: string;
  imports?: RawImport[];
  exports?: RawExport[];
  /** Env var names from literal os.environ[...] / os.environ.get(...) / os.getenv(...) access. */
  envVars?: string[];
  /** Names declared in a top-level `__all__ = [...]` (public re-export contract). */
  dunderAll?: RawDunderAllEntry[];
  framework?: 'fastapi' | 'django' | 'drf' | null;
  routes?: RawFrameworkRoute[];
  error?: string;
}

const PY_AST_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** Safety backstop: SIGKILL a python AST subprocess that runs far longer than any real shard parse,
 * so a pathological hang cannot pin a core forever. Far above normal parse times. */
const PY_AST_TIMEOUT_MS = 10 * 60_000;

/**
 * The part of a spawned child this module touches.
 *
 * Declared structurally rather than as `ChildProcess`, because the tracking helpers below are
 * exported and a node type in their signature puts a `node:child_process` import into this package's
 * published `.d.ts`. The package would then need the ambient node types declared to type-check,
 * which inside a workspace is invisible — npm hoists them — and is a missing dependency for anyone
 * else. What the module actually uses is these four members.
 */
export interface TrackedChild {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  once(event: 'exit' | 'close', listener: () => void): unknown;
  /** `SIGKILL` is the only signal this module sends, and naming it keeps the type assignable from
   *  the node one: a wider `string` matches neither direction of the method-parameter check. */
  kill(signal?: 'SIGKILL'): boolean;
}

/** Live python AST subprocesses spawned in THIS thread. They are children of the node process, not
 * of the worker thread, so `Worker.terminate()` alone would orphan them. Tracked so a shutdown /
 * build cancel can kill and reap them via `terminateLivePythonChildren`. */
const livePythonChildren = new Set<TrackedChild>();

/**
 * SIGKILL every live python AST subprocess and wait for it to be reaped. Called from the worker
 * shutdown handler (via the plugin's `terminateInFlight`) before `parentPort.close()`, so the
 * thread's event loop reaps the children instead of leaving zombies. Idempotent; resolves fast when
 * nothing runs. A per-child wait cap keeps shutdown bounded if a reap stalls.
 */
export async function terminateLivePythonChildren(waitMs = 3000): Promise<void> {
  const children = [...livePythonChildren];
  livePythonChildren.clear();
  await Promise.all(children.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    let done = false;
    const finish = (): void => { if (!done) { done = true; resolve(); } };
    child.once('exit', finish);
    const timer = setTimeout(finish, waitMs);
    timer.unref();
    try { child.kill('SIGKILL'); } catch { finish(); }
  })));
}

/** Test-only: register a child so `terminateLivePythonChildren` can be exercised without a real
 * python interpreter, mirroring the tracking `runPythonAst` performs for real subprocesses. */
export function __trackLivePythonChildForTest(child: TrackedChild): void {
  livePythonChildren.add(child);
  child.once('close', () => livePythonChildren.delete(child));
}

/** Backstop timeout for a python AST subprocess; exported for the timer-lifecycle test. */
export const __PY_AST_TIMEOUT_MS_FOR_TEST = PY_AST_TIMEOUT_MS;

/** Run the stdlib-`ast` script in an async subprocess. Non-blocking: inline extraction on the
 * main thread (single-shard repos, MCP refresh) must not freeze the event loop while Python
 * parses a shard. Rejects on spawn failure, non-zero exit, or output overflow. */
export function runPythonAst(pythonBin: string, pyAstScriptPath: string, filePaths: HostPath[]): Promise<Map<HostPath, RawModule>> {
  if (filePaths.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [pyAstScriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // pythonBin is an absolute path; the non-repo cwd is defense in depth — it keeps the OS spawn
      // search and the interpreter's `sys.path[0]` off the analyzed repo.
      cwd: os.tmpdir(),
    });
    // Backstop: SIGKILL a runaway parse. A manual unref'd timer — not spawn's `timeout` option, whose
    // internal timer is ref'd and stays armed for the full timeout after an early spawn failure, holding
    // the event loop open. This one is unref'd (never blocks exit) and cleared on 'close', which fires on
    // both a clean exit and a failed spawn (unlike 'exit').
    const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, PY_AST_TIMEOUT_MS);
    killTimer.unref();
    // Track for shutdown/cancel teardown; drop on close regardless of how the run settled.
    livePythonChildren.add(child);
    child.once('close', () => { clearTimeout(killTimer); livePythonChildren.delete(child); });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      // SIGKILL, not SIGTERM: on overflow/error we clear the backstop timer, so a child that ignores
      // SIGTERM (e.g. mid signal-handler after a 256 MiB overflow) would otherwise survive the reject.
      // SIGKILL cannot be caught; the child stays tracked in livePythonChildren until 'close' reaps it.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(err);
    };
    child.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > PY_AST_MAX_OUTPUT_BYTES) {
        fail(new Error(`python ast output exceeded ${PY_AST_MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').slice(0, 2000);
        reject(new Error(`python exited with code ${code}${stderr ? `: ${stderr}` : ''}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString('utf-8')) as RawModule[];
        const result = new Map<HostPath, RawModule>();
        for (const r of parsed) result.set(asHostPath(r.filePath), r);
        resolve(result);
      } catch (e) {
        reject(e as Error);
      }
    });
    child.stdin.on('error', () => { /* EPIPE when the child dies early; close handler reports it */ });
    child.stdin.end(filePaths.join('\n'));
  });
}

function toModuleDelta(
  pending: PendingModule,
  raw: RawModule | undefined,
  absPathToId: Map<HostPath, string>,
  packages: SourceExtractInput['packages'],
  repoRoot: HostPath,
): SemanticModuleDelta {
  const imports: ImportInfo[] = [];
  const exports: ExportInfo[] = [];

  if (raw && !raw.error) {
    for (const imp of raw.imports ?? []) {
      const moduleDotted = imp.module ?? '';
      const resolution = resolvePythonImport({
        importingAbsPath: pending.absPath,
        level: imp.level,
        moduleDotted,
        kind: imp.kind,
        absPathToId,
        packages,
        repoRoot,
        importingPackage: pending.pkg,
      });
      const moduleSpecifier =
        imp.kind === 'from' && imp.level > 0
          ? '.'.repeat(imp.level) + moduleDotted
          : moduleDotted;
      const names = imp.kind === 'import' ? (moduleDotted ? [moduleDotted] : []) : (imp.names ?? []);
      imports.push({
        moduleSpecifier,
        resolvedModuleId: resolution.resolvedModuleId,
        importedNames: names,
        isTypeOnly: false,
        isExternal: resolution.isExternal,
      });
    }
    for (const ex of raw.exports ?? []) {
      exports.push({
        name: ex.name,
        kind: ex.kind,
        lineRange: { start: ex.line, end: ex.endLine },
        isDefault: false,
      });
    }
    // `__all__` is the module's declared public API. Names not already captured as top-level
    // defs are re-exports (`from .impl import Foo`) — surface them as exports with kind
    // 'unknown' so annotation keyExports consistency does not false-flag documented re-exports.
    const ownNames = new Set(exports.map(e => e.name));
    for (const entry of raw.dunderAll ?? []) {
      if (ownNames.has(entry.name)) continue;
      ownNames.add(entry.name);
      exports.push({
        name: entry.name,
        kind: 'unknown',
        lineRange: { start: entry.line, end: entry.endLine },
        isDefault: false,
      });
    }
  }

  const envVars = raw && !raw.error ? (raw.envVars ?? []) : [];
  const effectImports = raw && !raw.error ? effectImportsFromPythonImports(imports) : [];
  const frameworkHints =
    raw && !raw.error
      ? frameworkHintsFromRaw({ framework: raw.framework ?? undefined, routes: raw.routes })
      : undefined;
  let semanticHints: SemanticHints | undefined;
  if (envVars.length > 0 || effectImports.length > 0 || frameworkHints) {
    semanticHints = {
      ...(envVars.length > 0 ? { envVars } : {}),
      ...(effectImports.length > 0 ? { effectImports } : {}),
      ...frameworkHints,
    };
  }

  return {
    moduleId: pending.moduleId,
    imports,
    exports,
    ...(semanticHints ? { semanticHints } : {}),
  };
}

/** Invert a projected import specifier back to the resolver inputs. The fresh path encodes a relative
 * `from` import as leading dots plus the dotted tail and any absolute import as the bare dotted name;
 * a module name never carries a leading dot, so counting the leading dots recovers `level` exactly. */
function specifierToResolverInput(moduleSpecifier: string): { level: number; moduleDotted: string } {
  let level = 0;
  while (level < moduleSpecifier.length && moduleSpecifier[level] === '.') level++;
  return { level, moduleDotted: moduleSpecifier.slice(level) };
}

/** Project the semantic subset of a previously-extracted module onto a reuse delta. The file content
 * is unchanged (content-hash hit), so its imports, exports, and hints match a fresh parse. Import
 * resolution depends on the whole module set, which can change between builds (a file added or
 * removed); re-resolve each import against this build's path map so an incremental refresh matches a
 * cold build of the same tree. The engine re-stamps the unchanged mechanical fields when it
 * reassembles the ModuleInfo. */
function reuseDelta(
  pending: PendingModule,
  prev: ModuleInfo,
  absPathToId: Map<HostPath, string>,
  packages: SourceExtractInput['packages'],
  repoRoot: HostPath,
): SemanticModuleDelta {
  const imports = prev.imports.map(imp => {
    const { level, moduleDotted } = specifierToResolverInput(imp.moduleSpecifier);
    // resolvePythonImport resolves by level/moduleDotted/packages; `kind` does not affect the id.
    const res = resolvePythonImport({
      importingAbsPath: pending.absPath,
      level,
      moduleDotted,
      kind: 'from',
      absPathToId,
      packages,
      repoRoot,
      importingPackage: pending.pkg,
    });
    return { ...imp, resolvedModuleId: res.resolvedModuleId, isExternal: res.isExternal };
  });
  return {
    moduleId: pending.moduleId,
    imports,
    exports: prev.exports,
    ...(prev.semanticHints ? { semanticHints: prev.semanticHints } : {}),
  };
}

export async function extractPython(input: SourceExtractInput): Promise<SourceExtractResult> {
  const { pendingModules, prevByAbsPath, absPathToId, packages, repoRoot, sourceByModuleId } = input;
  const ctx = input.extractContext as PythonExtractContext | undefined;
  const pythonBin = ctx?.pythonBin;
  if (!pythonBin) return { deltas: [], reused: 0, rescanned: 0 };

  interface Resolved {
    pending: PendingModule;
    cached?: SemanticModuleDelta;
    needsParse: boolean;
  }

  // Reuse decisions key off the engine-provided fingerprint (engine owns file IO + hashing).
  // A pending module the engine could not read has no `sourceByModuleId` entry and is
  // skipped — it emits no delta and drops out deterministically.
  const resolved: Resolved[] = pendingModules.map(pending => {
    const src = sourceByModuleId.get(pending.moduleId);
    if (!src) return { pending, needsParse: false };
    const prev = prevByAbsPath.get(pending.absPath);
    if (prev && prev.id === pending.moduleId && prev.contentHash === src.contentHash) {
      return { pending, cached: reuseDelta(pending, prev, absPathToId, packages, repoRoot), needsParse: false };
    }
    return { pending, needsParse: true };
  });

  let rawByPath = new Map<HostPath, RawModule>();
  let subprocessFailed = false;
  const toParse = resolved.filter(r => r.needsParse);
  if (toParse.length > 0) {
    const pyAstScriptPath = resolvePyAstScriptPath();
    if (!pyAstScriptPath) return { deltas: [], reused: 0, rescanned: 0 };
    try {
      rawByPath = await runPythonAst(pythonBin, pyAstScriptPath, toParse.map(r => r.pending.absPath));
    } catch (e) {
      // A failed subprocess must not crash the build: emit modules with empty imports/exports.
      subprocessFailed = true;
      console.warn(`  ⚠ Python AST extraction failed: ${(e as Error).message}`);
    }
  }

  const deltas: SemanticModuleDelta[] = [];
  let reused = 0;
  let rescanned = 0;
  for (const r of resolved) {
    if (r.cached) {
      deltas.push(r.cached);
      reused++;
      continue;
    }
    if (!r.needsParse) continue;
    const delta = toModuleDelta(r.pending, rawByPath.get(r.pending.absPath), absPathToId, packages, repoRoot);
    // On a subprocess-level failure (transient: interpreter killed, OOM, PATH change) the empty
    // imports/exports must NOT be cached under the real content hash — a later incremental run
    // would reuse the poisoned modules forever. Marking the delta `transient` makes the engine
    // stamp an empty hash that never matches, forcing a re-parse. Per-file `ast` errors
    // (raw.error) are deterministic, so they keep the real hash (not marked transient).
    if (subprocessFailed) delta.transient = true;
    deltas.push(delta);
    rescanned++;
  }
  return { deltas, reused, rescanned };
}
