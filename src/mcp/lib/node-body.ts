import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { RepositoryGraph, ModuleInfo } from '../../types.js';
import { isLexicallyInsideRepo, isPathInsideRepo } from '../../fs/containment.js';
import { createLimiter } from '../../semantic/serialize.js';
import { toPosixPath } from '../../platform/paths.js';
import { delivered, refused, type Outcome } from '../../response/refusal.js';

export const GREP_EXECUTION_TIMEOUT_MS = 5_000;
export const MAX_GREP_LINE_CHARS = 4_096;
export const MAX_GREP_MATCHES = 50;

/** Admission control: cap concurrent regex-scan worker threads. Without it, N simultaneous
 *  inspect_node({ grepBody }) requests each spawn a worker with no bound. Scans are short (5s cap),
 *  so a small pool absorbs bursts; excess requests queue for a free slot. */
const MAX_CONCURRENT_GREP_WORKERS = Math.max(1, Math.min(4, availableParallelism() - 1));
const grepScanLimiter = createLimiter(MAX_CONCURRENT_GREP_WORKERS);

export interface RegexLineScanResult {
  matchIndices: number[];
  totalMatches: number;
  scannedLines: number;
  timedOut: boolean;
  truncatedLineCount: number;
  matchesTruncated: boolean;
}

interface RegexLineScanOptions {
  timeoutMs?: number;
  maxLineChars?: number;
  maxMatches?: number;
  /** Cancel signal for the owning MCP request: aborts terminate the worker and return promptly. */
  signal?: AbortSignal;
}

interface RegexWorkerResult {
  matchIndices: number[];
  totalMatches: number;
  scannedLines: number;
  timedOut: boolean;
}

const REGEX_SCAN_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  (() => {
    const { lines, pattern, timeoutMs, maxMatches } = workerData;
    const regex = new RegExp(pattern, 'i');
    const deadline = Date.now() + timeoutMs;
    const matchIndices = [];
    let totalMatches = 0;
    let scannedLines = 0;
    for (let i = 0; i < lines.length; i++) {
      if (Date.now() >= deadline) {
        parentPort.postMessage({ matchIndices, totalMatches, scannedLines, timedOut: true });
        return;
      }
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        totalMatches++;
        if (matchIndices.length < maxMatches) matchIndices.push(i);
      }
      scannedLines = i + 1;
      if (Date.now() >= deadline) {
        parentPort.postMessage({ matchIndices, totalMatches, scannedLines, timedOut: true });
        return;
      }
    }
    parentPort.postMessage({ matchIndices, totalMatches, scannedLines, timedOut: false });
  })();
`;

export interface NodeBodyResult {
  lines: string[];
  lineStart: number;
  filePath: string;
}

export async function readNodeBody(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  repoRoot: string,
  nodeId: string,
  nodeType: string,
  lineRange?: { start: number; end: number },
): Promise<Outcome<NodeBodyResult>> {
  if (nodeType === 'export-symbol' && lineRange) {
    const parentEdge = (graph.inEdges.get(nodeId) ?? []).find(e => e.kind === 'contains');
    const parentMod = parentEdge ? modulesById.get(parentEdge.from) : undefined;
    if (!parentMod) return refused('not-found', 'body-parent-missing', `Parent module not found for export-symbol: ${nodeId}`, { nodeId });
    if (!isPathInsideRepo(repoRoot, parentMod.absPath)) {
      return refused('rejected-by-policy', 'body-outside-workspace', `Refusing to read source outside repo root: ${displayPath(repoRoot, parentMod.absPath)}`, { path: refusalPath(repoRoot, parentMod.absPath) });
    }
    try {
      const raw = await fsPromises.readFile(parentMod.absPath, 'utf-8');
      const allLines = raw.split('\n');
      const lineStart = Math.max(0, lineRange.start - 1);
      const lineEnd = Math.min(allLines.length, lineRange.end);
      return delivered({ lines: allLines.slice(lineStart, lineEnd), lineStart, filePath: parentMod.absPath });
    } catch (e) {
      return refused('unreadable', 'body-unreadable', `Could not read file: ${displayPath(repoRoot, parentMod.absPath)} — ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, { path: refusalPath(repoRoot, parentMod.absPath) });
    }
  }

  if (nodeType === 'module') {
    const mod = modulesById.get(nodeId);
    const filePath = mod?.absPath
      ?? (graph.nodes.get(nodeId)?.data as { absPath?: string } | undefined)?.absPath;
    if (!filePath) return refused('not-found', 'body-module-missing', `Module file info not found: ${nodeId}`, { nodeId });
    if (!isPathInsideRepo(repoRoot, filePath)) {
      return refused('rejected-by-policy', 'body-outside-workspace', `Refusing to read source outside repo root: ${displayPath(repoRoot, filePath)}`, { path: refusalPath(repoRoot, filePath) });
    }
    try {
      const raw = await fsPromises.readFile(filePath, 'utf-8');
      return delivered({ lines: raw.split('\n'), lineStart: 0, filePath });
    } catch (e) {
      return refused('unreadable', 'body-unreadable', `Could not read file: ${displayPath(repoRoot, filePath)} — ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, { path: refusalPath(repoRoot, filePath) });
    }
  }

  return refused('unsupported', 'body-unsupported-node', `Unsupported node type for body: ${nodeType}`, { nodeType });
}

/**
 * Repo-relative label for messages, or `[outside-repo]`. Lexical: it names the path a caller
 * asked about, so a refused symlink still reports the in-repo file to remove. The read guard is
 * `isPathInsideRepo`.
 */
/**
 * The same path a refusal's sentence shows, POSIX-normalized for the machine-readable slot.
 *
 * The sentence is read by a person and keeps the host's separators; `details` is read by a program
 * and must answer the same on every platform, the way every other repo-relative value the engine
 * publishes does. Two producers of one field with two spellings is a reader that works until it
 * meets the other one.
 */
export function refusalPath(repoRoot: string, filePath: string): string {
  return toPosixPath(displayPath(repoRoot, filePath));
}

export function displayPath(repoRoot: string, filePath: string): string {
  const root = path.resolve(repoRoot);
  if (!isLexicallyInsideRepo(root, filePath)) return '[outside-repo]';
  return path.relative(root, path.resolve(root, filePath)) || '.';
}

function hasRiskyRepeatedGroup(pattern: string): boolean {
  const groups: Array<{ hasAlternation: boolean; hasQuantifier: boolean }> = [];
  let inCharacterClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === '[') {
      inCharacterClass = true;
      continue;
    }
    if (char === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (char === '(') {
      groups.push({ hasAlternation: false, hasQuantifier: false });
      continue;
    }
    const current = groups.at(-1);
    if (!current) continue;
    if (char === '|') {
      current.hasAlternation = true;
      continue;
    }
    if (char === '+' || char === '*' || (char === '?' && pattern[i - 1] !== '(') || char === '{') {
      current.hasQuantifier = true;
      continue;
    }
    if (char !== ')') continue;

    const group = groups.pop()!;
    const next = pattern[i + 1];
    let repeated = next === '+' || next === '*';
    if (next === '{') {
      const close = pattern.indexOf('}', i + 2);
      const quantifier = close === -1 ? '' : pattern.slice(i + 2, close);
      repeated = /^\d+,$/.test(quantifier);
    }
    if (repeated && (group.hasAlternation || group.hasQuantifier)) return true;
    const parent = groups.at(-1);
    if (parent) {
      parent.hasAlternation ||= group.hasAlternation;
      parent.hasQuantifier ||= group.hasQuantifier || repeated;
    }
  }
  return false;
}

export function isUnsafeRegexPattern(pattern: string): boolean {
  return hasRiskyRepeatedGroup(pattern) || /(\.\*){2,}|(\.\+){2,}/.test(pattern);
}

/**
 * Execute agent-supplied regexes away from the MCP event loop. The parent deadline terminates a
 * worker stuck inside one `RegExp.test`; per-line checks bound normal multi-line scans. Every line
 * is capped before structured cloning so minified/generated single lines cannot amplify work.
 */
export async function scanLinesWithRegex(
  lines: string[],
  pattern: string,
  options: RegexLineScanOptions = {},
): Promise<RegexLineScanResult> {
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? GREP_EXECUTION_TIMEOUT_MS));
  const maxLineChars = Math.max(1, Math.floor(options.maxLineChars ?? MAX_GREP_LINE_CHARS));
  const maxMatches = Math.max(1, Math.floor(options.maxMatches ?? MAX_GREP_MATCHES));
  let truncatedLineCount = 0;
  const boundedLines = lines.map(line => {
    if (line.length <= maxLineChars) return line;
    truncatedLineCount++;
    return line.slice(0, maxLineChars);
  });

  const cancelledResult = (): RegexLineScanResult =>
    ({ matchIndices: [], totalMatches: 0, scannedLines: 0, timedOut: true, truncatedLineCount, matchesTruncated: false });
  // Already cancelled: return without queuing for or spawning a worker.
  if (options.signal?.aborted) return cancelledResult();
  try {
    return await grepScanLimiter(() => new Promise<RegexLineScanResult>((resolve, reject) => {
    // Admitted after possibly queuing behind the limiter: if the request was cancelled while we waited,
    // skip spawning a worker at all.
    if (options.signal?.aborted) { resolve(cancelledResult()); return; }
    const worker = new Worker(REGEX_SCAN_WORKER_SOURCE, {
      eval: true,
      workerData: { lines: boundedLines, pattern, timeoutMs, maxMatches },
    });
    let settled = false;
    // Detach the abort listener on any settle so a successful scan does not leave it attached to the
    // (request-scoped) signal until GC.
    let detachAbort = (): void => {};

    const stop = (): Promise<number> => worker.terminate().catch(() => -1);
    const finish = (result: RegexWorkerResult): void => {
      if (settled) return;
      settled = true;
      detachAbort();
      clearTimeout(timer);
      void stop().then(() => resolve({
        ...result,
        truncatedLineCount,
        matchesTruncated: result.totalMatches > result.matchIndices.length,
      }));
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      detachAbort();
      clearTimeout(timer);
      void stop().then(() => reject(error));
    };

    worker.once('message', (result: RegexWorkerResult) => finish(result));
    worker.once('error', fail);
    worker.once('exit', code => {
      if (!settled) fail(new Error(`Regex worker exited before returning a result (code ${code})`));
    });
    const timer = setTimeout(() => finish({
      matchIndices: [],
      totalMatches: 0,
      scannedLines: 0,
      timedOut: true,
    }), timeoutMs);
    // Client cancelled the request: terminate the worker and return promptly rather than scanning.
    const onAbort = (): void => finish({ matchIndices: [], totalMatches: 0, scannedLines: 0, timedOut: true });
    const sig = options.signal;
    if (sig?.aborted) onAbort();
    else if (sig) {
      sig.addEventListener('abort', onAbort, { once: true });
      detachAbort = (): void => sig.removeEventListener('abort', onAbort);
    }
    }), options.signal);
  } catch (err) {
    // The limiter rejects a request cancelled while still queued (it left the line without admission).
    // That is a cancel, not a scan failure — keep the contract "resolves on cancel" by returning empty.
    if (options.signal?.aborted) return cancelledResult();
    throw err;
  }
}

export function redactSecretLikeText(text: string): string {
  return text
    .replace(/\b(sk_(?:live|test)_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED_SECRET]')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1\n[REDACTED_SECRET]\n$2')
    .replace(/\b((?:secret|token|password|api[_ -]?key|client[_ -]?secret)\s*[:=]\s*['"]?)[A-Za-z0-9_./+=-]{12,}/ig, '$1[REDACTED_SECRET]');
}
