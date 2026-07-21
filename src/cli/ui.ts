/**
 * Minimal ANSI styling for repovine CLI and build-pipeline output.
 * Respects NO_COLOR, FORCE_COLOR, and stream TTY (plain text in pipes/CI).
 *
 * Human onboarding (init/clear/build summary) → stdout via logCli / cli.*
 * Graph build progress (stages, packages)       → stderr via logPipeline / pipe.*
 * MCP stdio quiet mode                        → setPipelineLogSink('silent')
 */

const SGR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const;

export type PipelineLogSink = 'stdout' | 'stderr' | 'silent';

let pipelineLogSink: PipelineLogSink = 'stderr';
/** When true, `\r` in-place progress even if stderr is piped (Cursor MCP host). */
let progressInPlaceOverride: boolean | undefined;

/** Control where build-pipeline chatter goes (stderr for CLI; silent for quiet MCP stdio). */
export function setPipelineLogSink(sink: PipelineLogSink): void {
  pipelineLogSink = sink;
}

/** Force in-place `\r` progress when stderr is not a TTY (e.g. MCP stdio subprocess). */
export function setProgressInPlace(enabled: boolean): void {
  progressInPlaceOverride = enabled;
}

export function getPipelineLogSink(): PipelineLogSink {
  return pipelineLogSink;
}

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  const force = process.env.FORCE_COLOR;
  if (force === '0' || force === 'false') return false;
  if (force === '1' || force === '2' || force === '3' || force === 'true') return true;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    return false;
  }
  return stream.isTTY === true;
}

/** Remove ANSI SGR sequences — use in tests that assert on styled CLI output. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

/** Pad to visible terminal width (ANSI codes do not occupy columns). */
function padProgressLine(line: string, minWidth: number): string {
  const vis = visibleLength(line);
  const width = Math.max(minWidth, vis);
  return vis >= width ? line : line + ' '.repeat(width - vis);
}

const MAX_PROGRESS_PKG_LABEL = 40;

function truncateProgressLabel(label: string, max = MAX_PROGRESS_PKG_LABEL): string {
  const plain = stripAnsi(label);
  if (plain.length <= max) return label;
  return `${plain.slice(0, Math.max(1, max - 1))}…`;
}

function terminalWidth(stream: NodeJS.WriteStream): number {
  const cols = stream.columns ?? Number(process.env.COLUMNS);
  if (Number.isFinite(cols) && cols > 0) return cols;
  return 120;
}

function clipProgressLine(line: string, stream: NodeJS.WriteStream): string {
  const max = terminalWidth(stream);
  const plain = stripAnsi(line);
  if (plain.length <= max) return line;
  return `${plain.slice(0, Math.max(1, max - 1))}…`;
}

function shouldProgressInPlace(stream: NodeJS.WriteStream): boolean {
  if (progressInPlaceOverride === true) return true;
  if (progressInPlaceOverride === false) return false;
  return stream.isTTY === true;
}

function paintFor(stream: NodeJS.WriteStream, text: string, ...codes: string[]): string {
  if (!colorEnabled(stream)) return text;
  return `${codes.join('')}${text}${SGR.reset}`;
}

function makeStyle(stream: NodeJS.WriteStream) {
  return {
    bold: (text: string) => paintFor(stream, text, SGR.bold),
    dim: (text: string) => paintFor(stream, text, SGR.dim),
    accent: (text: string) => paintFor(stream, text, SGR.cyan),
    success: (text: string) => paintFor(stream, text, SGR.green),
    warn: (text: string) => paintFor(stream, text, SGR.yellow),
    error: (text: string) => paintFor(stream, text, SGR.red),
  };
}

/** Styles for human-facing onboarding output on stdout. */
export const cli = makeStyle(process.stdout);

/** Styles for build-pipeline progress on stderr. */
const pipe = makeStyle(process.stderr);

export function logCli(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function logCliError(line: string): void {
  process.stderr.write(`${cli.error(line)}\n`);
}

export function logPipeline(line: string): void {
  if (pipelineLogSink === 'silent') return;
  logPipelineProgressEnd();
  const stream = pipelineLogSink === 'stderr' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

let pipelineProgressActive = false;
let pipelineProgressWidth = 0;

/** In-place progress on TTY stderr (or piped MCP logs when forced); newline fallback in CI/pipes. */
export function logPipelineProgress(line: string): void {
  if (pipelineLogSink === 'silent') return;
  const stream = pipelineLogSink === 'stderr' ? process.stderr : process.stdout;
  if (shouldProgressInPlace(stream)) {
    const clipped = clipProgressLine(line, stream);
    const padded = padProgressLine(clipped, pipelineProgressWidth);
    pipelineProgressWidth = visibleLength(padded);
    stream.write(`\r${padded}\x1b[K`);
    pipelineProgressActive = true;
    return;
  }
  logPipeline(line);
}

/** Finish an in-place progress line before normal pipeline logs resume. */
export function logPipelineProgressEnd(): void {
  if (!pipelineProgressActive || pipelineLogSink === 'silent') return;
  const stream = pipelineLogSink === 'stderr' ? process.stderr : process.stdout;
  if (shouldProgressInPlace(stream)) stream.write('\n');
  pipelineProgressActive = false;
  pipelineProgressWidth = 0;
}

export function logPipelineWarn(line: string): void {
  if (pipelineLogSink === 'silent') return;
  logPipelineProgressEnd();
  const stream = pipelineLogSink === 'stderr' ? process.stderr : process.stdout;
  stream.write(`${pipe.warn(line)}\n`);
}

export type FileResultTone =
  | 'created'
  | 'merged'
  | 'overwritten'
  | 'removed'
  | 'updated'
  | 'skipped'
  | 'error'
  | 'would-remove'
  | 'would-update'
  | 'neutral';

const FILE_MARKERS: Record<FileResultTone, { glyph: string; paintGlyph: (g: string) => string }> = {
  created: { glyph: '✓', paintGlyph: cli.success },
  merged: { glyph: '↳', paintGlyph: cli.accent },
  overwritten: { glyph: '!', paintGlyph: cli.warn },
  removed: { glyph: '−', paintGlyph: cli.warn },
  updated: { glyph: '↳', paintGlyph: cli.accent },
  skipped: { glyph: '○', paintGlyph: cli.dim },
  error: { glyph: '✗', paintGlyph: cli.error },
  'would-remove': { glyph: '−', paintGlyph: cli.warn },
  'would-update': { glyph: '~', paintGlyph: cli.accent },
  neutral: { glyph: '·', paintGlyph: (g) => g },
};

const GROUP_LABEL_STYLE: Partial<Record<FileResultTone, (text: string) => string>> = {
  created: cli.success,
  merged: cli.accent,
  overwritten: cli.warn,
  removed: cli.warn,
  updated: cli.accent,
  skipped: cli.dim,
  error: cli.error,
  'would-remove': cli.warn,
  'would-update': cli.accent,
};

export function formatGroupLabel(label: string, tone: FileResultTone): string {
  const style = GROUP_LABEL_STYLE[tone];
  return style ? style(label) : label;
}

export function formatFileLine(
  tone: FileResultTone,
  relativePath: string,
  extras?: { backup?: string; note?: string; noteSeparator?: string },
): string {
  const { glyph, paintGlyph } = FILE_MARKERS[tone];
  const mark = paintGlyph(glyph);
  const pathText = tone === 'skipped' ? cli.dim(relativePath) : relativePath;
  let suffix = '';
  if (extras?.backup) {
    suffix += cli.dim(` (backup: ${extras.backup})`);
  }
  if (extras?.note) {
    const sep = extras.noteSeparator ?? ' — ';
    suffix += cli.dim(`${sep}${extras.note}`);
  }
  return `  ${mark} ${pathText}${suffix}`;
}

/** Color MCP preflight lines from merge-config without changing their plain-text shape. */
export function styleMcpPreflight(line: string): string {
  if (!colorEnabled(process.stdout)) return line;
  const match = line.match(/^(\s*)(Cursor|Claude|Codex)\s+\(([^)]+)\):\s*(.+)$/);
  if (!match) return line;

  const [, indent, client, file, rest] = match;
  const arrow = '→';
  const arrowIdx = rest.indexOf(arrow);
  if (arrowIdx === -1) {
    return `${indent}${cli.bold(client)} (${cli.dim(file)}): ${rest}`;
  }

  const state = rest.slice(0, arrowIdx).trimEnd();
  const afterArrow = rest.slice(arrowIdx + arrow.length).trim();
  const reasonMatch = afterArrow.match(/^(\S+(?:-\S+)*)(?:\s+\((.+)\))?$/);

  if (!reasonMatch) {
    return `${indent}${cli.bold(client)} (${cli.dim(file)}): ${state} ${arrow} ${cli.accent(afterArrow)}`;
  }

  const [, plan, reason] = reasonMatch;
  const reasonPart = reason ? ` ${cli.dim(`(${reason})`)}` : '';
  return `${indent}${cli.bold(client)} (${cli.dim(file)}): ${state} ${arrow} ${cli.accent(plan)}${reasonPart}`;
}

/** Highlight slash commands, @agents, and repovine-* skill names in next-step prose. */
export function styleNextStepLine(text: string): string {
  if (!colorEnabled(process.stdout)) return text;
  return text.replace(
    /(\/[\w-]+|@[\w-]+|repovine-[\w-]+(?: skill)?|`[^`]+`)/g,
    (token) => cli.accent(token),
  );
}

export function formatCliBanner(primary: string, detail?: string): string {
  return detail ? `${primary}\n${cli.dim(detail)}` : primary;
}

export function formatSetupTitle(target: string, detail?: string): string {
  const primary = `${cli.bold('Setting up repovine client scaffold for:')} ${cli.accent(target)}`;
  return formatCliBanner(primary, detail);
}

export function formatWorkspaceSupportLines(message: string): string[] {
  return message.split('\n').map((line) => formatPipelineDetail(line));
}

export function formatBuildSummary(stats: {
  seconds: string;
  modules: number;
  graphNodes: number;
  annotations: number;
}): string[] {
  return [
    '',
    cli.success(`Build complete in ${stats.seconds}s.`),
    `  ${cli.dim('Modules:')}     ${stats.modules}`,
    `  ${cli.dim('Graph nodes:')} ${stats.graphNodes}`,
    `  ${cli.dim('Annotations:')} ${stats.annotations}`,
    '',
    cli.dim('Snapshot cache saved. Next MCP startup will be near-instant.'),
  ];
}

/** "Stage N: Title..." headings for graph build pipeline output. */
export function formatPipelineStage(label: string): string {
  const match = label.match(/^(Stage \d+:)\s*(.+)$/);
  if (!match) return pipe.bold(label);
  return `${pipe.bold(match[1])} ${pipe.accent(match[2])}`;
}

/** "  Stage N DONE in Xs — details" completion lines. */
export function formatPipelineStageDone(line: string): string {
  const match = line.match(/^(\s*)(Stage \d+ DONE in [\d.]+s —)\s*(.+)$/);
  if (!match) return pipe.success(line.trimStart());
  return `${match[1]}${pipe.success(match[2])} ${match[3]}`;
}

/** Indented pipeline detail; highlights integers when color is enabled. */
export function formatPipelineDetail(message: string): string {
  if (!colorEnabled(process.stderr)) return message;
  return message.replace(/\b(\d+)\b/g, (digits) => pipe.accent(digits));
}

const PIPELINE_PROGRESS_BAR_WIDTH = 24;

function pipelineProgressBar(done: number, total: number): { bar: string; pct: number; filled: number } {
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  const filled = total > 0 ? Math.round((done / total) * PIPELINE_PROGRESS_BAR_WIDTH) : PIPELINE_PROGRESS_BAR_WIDTH;
  const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, PIPELINE_PROGRESS_BAR_WIDTH - filled))}`;
  return { bar, pct, filled };
}

/** Per-package extraction progress during Stage 1 (in-place TTY bar + current package). */
export function formatPackageProgressLine(
  done: number,
  total: number,
  pkgName: string,
  pkgModules: number,
  elapsedTotalMs: number,
  rssMbValue: number,
  extra?: string,
): string {
  const { bar, pct, filled } = pipelineProgressBar(done, total);
  const pad = String(total).length;
  const idx = String(done).padStart(pad, ' ');
  const elapsedSec = elapsedTotalMs / 1000;
  const etaSec = done > 0 ? Math.round((elapsedSec / done) * (total - done)) : 0;
  const name = truncateProgressLabel(pkgName);

  if (!colorEnabled(process.stderr)) {
    const head = `  [${idx}/${total}] extracting packages  ${bar}  ${pct}%  ${name}`;
    const body = `  ${pkgModules}mod  rss=${rssMbValue}MB  t=${formatDurationClock(elapsedSec)}  eta~${formatDurationClock(etaSec)}`;
    return extra ? `${head}${body}  ${extra}` : `${head}${body}`;
  }

  const counter = pipe.dim(`[${idx}/${total}]`);
  const label = pipe.bold('extracting packages');
  const barStyled = `${pipe.accent('█'.repeat(filled))}${pipe.dim('░'.repeat(Math.max(0, PIPELINE_PROGRESS_BAR_WIDTH - filled)))}`;
  const nameStyled = pipe.bold(name);
  const mods = `${pipe.accent(String(pkgModules))}${pipe.dim('mod')}`;
  const timing = pipe.dim(`rss=${rssMbValue}MB  t=${formatDurationClock(elapsedSec)}  eta~${formatDurationClock(etaSec)}`);
  const tail = extra ? `  ${pipe.dim(extra)}` : '';
  return `  ${counter} ${label}  ${barStyled}  ${pipe.accent(String(pct))}%  ${nameStyled}  ${mods}  ${timing}${tail}`;
}

const SEMANTIC_EMBED_BAR_WIDTH = PIPELINE_PROGRESS_BAR_WIDTH;

function formatDurationClock(totalSec: number): string {
  const secs = Math.max(0, Math.round(totalSec));
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** ASCII progress bar + counter for semantic search embedding batches during stage 3. */
export function formatSemanticEmbedProgressLine(
  done: number,
  total: number,
  elapsedTotalMs: number,
): string {
  const { bar, pct, filled } = pipelineProgressBar(done, total);
  const pad = String(total).length;
  const idx = String(done).padStart(pad, ' ');
  const elapsedSec = elapsedTotalMs / 1000;
  const etaSec = done > 0 ? Math.round((elapsedSec / done) * (total - done)) : 0;

  if (!colorEnabled(process.stderr)) {
    return `  [${idx}/${total}] semantic search embeddings  ${bar}  ${pct}%  t=${formatDurationClock(elapsedSec)}  eta~${formatDurationClock(etaSec)}`;
  }

  const counter = pipe.dim(`[${idx}/${total}]`);
  const label = pipe.bold('semantic search embeddings');
  const barStyled = `${pipe.accent('█'.repeat(filled))}${pipe.dim('░'.repeat(Math.max(0, SEMANTIC_EMBED_BAR_WIDTH - filled)))}`;
  const timing = pipe.dim(`t=${formatDurationClock(elapsedSec)}  eta~${formatDurationClock(etaSec)}`);
  return `  ${counter} ${label}  ${barStyled}  ${pipe.accent(String(pct))}%  ${timing}`;
}

export function formatPipelineMuted(message: string): string {
  return pipe.dim(message);
}

/** Annotation store load line and similar short status messages. */
export function formatPipelineStatus(message: string): string {
  if (!colorEnabled(process.stderr)) return message;
  const loaded = message.match(/^(\s*Annotations loaded: )(\d+)( nodes.*)$/);
  if (loaded) {
    return `${loaded[1]}${pipe.accent(loaded[2])}${loaded[3]}`;
  }
  return formatPipelineDetail(message);
}
