import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_DISPATCHER_FILENAME } from '../../src/cli/dispatcher/index.js';

export type AssetMetricsClient = 'cursor' | 'claude' | 'codex';

export interface AssetFileMetric {
  client: AssetMetricsClient;
  className: string;
  path: string;
  chars: number;
  estimatedTokens: number;
  alwaysOn: boolean;
}

export interface AssetMetricTotals {
  files: number;
  chars: number;
  estimatedTokens: number;
  alwaysOnChars: number;
  alwaysOnEstimatedTokens: number;
}

export interface GeneratedAssetMetrics {
  client: AssetMetricsClient;
  files: AssetFileMetric[];
  totals: AssetMetricTotals;
  byClass: Record<string, AssetMetricTotals>;
  largestFiles: AssetFileMetric[];
  snippetCounts: Record<string, number>;
}

interface AssetClassSpec {
  className: string;
  root: string;
  include: (relativePath: string) => boolean;
  alwaysOn?: (relativePath: string) => boolean;
}

const MANAGED_AGENT_BASENAMES = new Set([
  'repovine-annotation-writer.md',
  'repovine-repo-explorer.md',
  'repovine-architecture-auditor.md',
  'repovine-code-reviewer.md',
  'sample.project-subagent.md',
  '_TEMPLATE.project-subagent.md',
  'repovine-annotation-writer.toml',
  'repovine-repo-explorer.toml',
  'repovine-architecture-auditor.toml',
  'repovine-code-reviewer.toml',
  'sample.project-subagent.toml',
  '_TEMPLATE.project-subagent.toml',
]);

const CURSOR_ALWAYS_ON_RULES = new Set([
  path.join('.cursor', 'rules', 'repovine-policy.mdc'),
  path.join('.cursor', 'rules', 'repovine-subagent-orchestration.mdc'),
]);

const SNIPPET_PATTERNS: Record<string, string[]> = {
  mcpResponseFormat: ['responseFormat: "concise" | "debug"'],
  annotationsMcpOnly: ['Only ever change `repovine.annots.json` through repovine MCP tools'],
  cheapModelGuidance: [
    'Annotating modules and reading source to summarize them is summary-class work',
    'Annotating is summary-class work',
  ],
  unifiedAnnotationQueue: ['`get_annotation_status({ "view": "queue" })` is ONE unified annotation queue'],
  publicMcpTools: ['## Public MCP tools'],
};

function emptyTotals(): AssetMetricTotals {
  return {
    files: 0,
    chars: 0,
    estimatedTokens: 0,
    alwaysOnChars: 0,
    alwaysOnEstimatedTokens: 0,
  };
}

function addToTotals(totals: AssetMetricTotals, file: AssetFileMetric): void {
  totals.files += 1;
  totals.chars += file.chars;
  totals.estimatedTokens += file.estimatedTokens;
  if (file.alwaysOn) {
    totals.alwaysOnChars += file.chars;
    totals.alwaysOnEstimatedTokens += file.estimatedTokens;
  }
}

function walkFiles(absRoot: string): string[] {
  if (!fs.existsSync(absRoot)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  };
  walk(absRoot);
  return out;
}

function fileIfExists(repoRoot: string, relativePath: string): string[] {
  const abs = path.join(repoRoot, relativePath);
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? [abs] : [];
}

function readClassFiles(
  repoRoot: string,
  client: AssetMetricsClient,
  spec: AssetClassSpec,
): AssetFileMetric[] {
  const absRoot = path.join(repoRoot, spec.root);
  return walkFiles(absRoot)
    .map(abs => path.relative(repoRoot, abs))
    .filter(rel => spec.include(rel))
    .sort()
    .map(rel => {
      const content = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      const chars = content.length;
      return {
        client,
        className: spec.className,
        path: rel.split(path.sep).join('/'),
        chars,
        estimatedTokens: Math.ceil(chars / 4),
        alwaysOn: spec.alwaysOn?.(rel) ?? false,
      };
    });
}

function classSpecsForClient(client: AssetMetricsClient): AssetClassSpec[] {
  if (client === 'cursor') {
    return [
      {
        className: 'rules',
        root: path.join('.cursor', 'rules'),
        include: rel => path.basename(rel).startsWith('repovine-') && rel.endsWith('.mdc'),
        alwaysOn: rel => CURSOR_ALWAYS_ON_RULES.has(rel),
      },
      {
        className: 'agents',
        root: path.join('.cursor', 'agents'),
        include: rel => MANAGED_AGENT_BASENAMES.has(path.basename(rel)),
      },
      {
        className: 'hooks',
        root: '.cursor',
        include: rel => rel === path.join('.cursor', 'hooks.json')
          || rel === path.join('.cursor', 'hooks', CLIENT_DISPATCHER_FILENAME),
      },
      {
        className: 'shared-skills',
        root: path.join('.agents', 'skills'),
        include: rel => path.basename(path.dirname(rel)).startsWith('repovine-')
          && path.basename(rel) === 'SKILL.md',
      },
    ];
  }

  if (client === 'claude') {
    return [
      {
        className: 'agents',
        root: path.join('.claude', 'agents'),
        include: rel => MANAGED_AGENT_BASENAMES.has(path.basename(rel)),
      },
      {
        className: 'skills',
        root: path.join('.claude', 'skills'),
        include: rel => path.basename(path.dirname(rel)).startsWith('repovine-')
          && path.basename(rel) === 'SKILL.md',
      },
      {
        className: 'hooks',
        root: '.claude',
        include: rel => rel === path.join('.claude', 'settings.json')
          || rel === path.join('.claude', 'hooks', CLIENT_DISPATCHER_FILENAME),
      },
    ];
  }

  return [
    {
      className: 'agents',
      root: path.join('.codex', 'agents'),
      include: rel => MANAGED_AGENT_BASENAMES.has(path.basename(rel)),
    },
    {
      className: 'hooks-and-config',
      root: '.codex',
      include: rel => rel === path.join('.codex', 'config.toml')
        || rel === path.join('.codex', 'hooks', CLIENT_DISPATCHER_FILENAME),
    },
    {
      className: 'shared-skills',
      root: path.join('.agents', 'skills'),
      include: rel => path.basename(path.dirname(rel)).startsWith('repovine-')
        && path.basename(rel) === 'SKILL.md',
    },
  ];
}

function collectStandaloneInstructionFiles(repoRoot: string, client: AssetMetricsClient): AssetFileMetric[] {
  const files = client === 'claude'
    ? ['AGENTS.md', 'CLAUDE.md']
    : client === 'codex'
      ? ['AGENTS.md']
      : [];
  return files.flatMap(rel => fileIfExists(repoRoot, rel).map(abs => {
    const content = fs.readFileSync(abs, 'utf-8');
    const chars = content.length;
    return {
      client,
      className: 'instructions',
      path: rel,
      chars,
      estimatedTokens: Math.ceil(chars / 4),
      alwaysOn: true,
    };
  }));
}

function countSnippets(files: AssetFileMetric[], repoRoot: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of Object.keys(SNIPPET_PATTERNS)) counts[id] = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(repoRoot, file.path), 'utf-8');
    for (const [id, patterns] of Object.entries(SNIPPET_PATTERNS)) {
      if (patterns.some(pattern => content.includes(pattern))) counts[id] += 1;
    }
  }

  return counts;
}

export function collectGeneratedAssetMetrics(
  repoRoot: string,
  client: AssetMetricsClient,
): GeneratedAssetMetrics {
  const files = [
    ...collectStandaloneInstructionFiles(repoRoot, client),
    ...classSpecsForClient(client).flatMap(spec => readClassFiles(repoRoot, client, spec)),
  ]
    .sort((a, b) => a.path.localeCompare(b.path));

  const totals = emptyTotals();
  const byClass: Record<string, AssetMetricTotals> = {};
  for (const file of files) {
    addToTotals(totals, file);
    byClass[file.className] ??= emptyTotals();
    addToTotals(byClass[file.className], file);
  }

  return {
    client,
    files,
    totals,
    byClass,
    largestFiles: [...files].sort((a, b) => b.chars - a.chars).slice(0, 10),
    snippetCounts: countSnippets(files, repoRoot),
  };
}
