// Handoff loader + orchestrator glue.
//
// Bundled handoff.md is DEMO-OWNED prose (structure guarded by test/handoff-ssot.test.mjs).
// Override with HARNESS_HANDOFF_DIR only — same lib/ pattern as agents/ and rules/.
// Same markdown-first pattern as lib/rules/*.mdc — frontmatter for flags, sections for templates.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toContractStrings } from './claude-agent.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = path.join(HERE, 'handoff');
const CONFIG_NAME = 'handoff.md';

const DEFAULT_CONFIG = {
  requireContractsWhenFilesChanged: true,
  implementerRoles: ['backend', 'infra', 'frontend', 'default'],
  policy: '',
  templates: {
    interSubAgentSection: '## Inter-sub-agent handoff\n\n{{contracts}}\n\n## Prior sub-agents\n\n{{priorPhases}}',
    constraintImplementer: 'Emit summary, filesChanged, and contractsChanged in AgentRunResult.',
    constraintReview: 'You are the review sub-agent. Report blockers; do not edit files.',
  },
  minimalExample: [],
};

const configCache = new Map();

export function handoffSearchDirs() {
  const dirs = [];
  if (process.env.HARNESS_HANDOFF_DIR) dirs.push(process.env.HARNESS_HANDOFF_DIR);
  dirs.push(BUNDLED_DIR);
  return dirs;
}

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text.trimStart() };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === 'requireContractsWhenFilesChanged') meta.requireContractsWhenFilesChanged = val === 'true';
    else if (key === 'implementerRoles') {
      meta.implementerRoles = val ? val.split(',').map((s) => s.trim()).filter(Boolean) : [];
    }
  }
  return { meta, body: text.slice(m[0].length).trimStart() };
}

function parseSections(body) {
  const sections = {};
  const parts = body.split(/^# /m).filter(Boolean);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    if (nl === -1) continue;
    const title = part.slice(0, nl).trim();
    const content = part.slice(nl + 1).trim();
    sections[title] = content;
  }
  return sections;
}

function parseMinimalExample(section) {
  if (!section) return [];
  return section
    .split('\n')
    .map((l) => l.replace(/^-\s*/, '').trim())
    .filter(Boolean);
}

/** Parse handoff.md into a config object. */
export function parseHandoffMarkdown(text) {
  const { meta, body } = parseFrontmatter(text);
  const sections = parseSections(body);
  // Legacy fallback: handoff.md projected before the sub-agents rename titles the
  // section `Template interLeafSection`; accept it until every copy regenerates.
  const LEGACY_SECTION_NAMES = { interSubAgentSection: 'interLeafSection' };
  const template = (name) => sections[`Template ${name}`]
    ?? (LEGACY_SECTION_NAMES[name] ? sections[`Template ${LEGACY_SECTION_NAMES[name]}`] : undefined)
    ?? DEFAULT_CONFIG.templates[name]
    ?? '';

  return {
    ...DEFAULT_CONFIG,
    ...meta,
    policy: sections.Policy ?? '',
    templates: {
      interSubAgentSection: template('interSubAgentSection'),
      constraintImplementer: template('constraintImplementer'),
      constraintReview: template('constraintReview'),
    },
    minimalExample: parseMinimalExample(sections.minimalExample),
  };
}

/** Load handoff.md — first dir in search order wins. */
export function loadHandoffConfig(_repoRoot) {
  const key = handoffSearchDirs().join('|');
  for (const dir of handoffSearchDirs()) {
    const file = path.join(dir, CONFIG_NAME);
    try {
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      const cached = configCache.get(key);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.config;
      const config = parseHandoffMarkdown(fs.readFileSync(file, 'utf-8'));
      configCache.set(key, { mtimeMs: stat.mtimeMs, config });
      return config;
    } catch {
      /* try next dir */
    }
  }
  return DEFAULT_CONFIG;
}

function renderTemplate(template, vars) {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

function agentContracts(result) {
  return toContractStrings(result?.contractsChanged);
}

function needsContracts(result, config) {
  if (!config.requireContractsWhenFilesChanged) return false;
  return (result?.filesChanged ?? []).length > 0;
}

export function contractHandoffViolations(spec, result, repoRoot) {
  const role = spec?.role;
  const config = loadHandoffConfig(repoRoot);
  if (role === 'review' || !config.implementerRoles.includes(role)) return [];
  if (!needsContracts(result, config)) return [];
  if (agentContracts(result).length > 0) return [];
  const hint = config.minimalExample?.length ? ' See handoff.md § minimalExample.' : '';
  return [`[${role}] Structured handoff missing: populate contractsChanged (what the next sub-agent must know).${hint}`];
}

export function buildInterSubAgentSectionFromTemplate(priorHandoffs, repoRoot, opts = {}) {
  const { templates } = loadHandoffConfig(repoRoot);
  const { baseContracts = [], currentRole, resuming = false } = opts;

  // SINGLE contract ledger for the next sub-agent: planner/parent contracts unioned
  // with every prior sub-agent's contractsChanged. This set is identical to assignment.contracts,
  // so the prompt builders DROP the redundant structured `Contracts:` line whenever
  // this section is present (see userPrompt / buildWorkerPrompt `embedsContracts`).
  const allContracts = [
    ...new Set([
      ...toContractStrings(baseContracts),
      ...priorHandoffs.flatMap((h) => h.contractsChanged ?? []),
    ]),
  ];
  const contractsBlock = allContracts.length
    ? allContracts.map((c) => `- ${c}`).join('\n')
    : '- (no contracts yet from prior sub-agents)';

  // On resume, this role's OWN prior sub-agents are already in its session history; only
  // cross-role siblings are new context worth restating. The ledger above stays
  // complete either way, so dropping same-role narrative loses nothing.
  const visiblePrior = resuming && currentRole
    ? priorHandoffs.filter((h) => h.role !== currentRole)
    : priorHandoffs;

  const priorLines = [];
  for (const h of visiblePrior) {
    priorLines.push(`- [${h.role}] ${h.workSummary || h.summary || '(no summary)'}`);
    if (h.filesChanged?.length) priorLines.push(`    files: ${h.filesChanged.join(', ')}`);
    // contractsChanged intentionally NOT repeated per sub-agent — the deduped ledger
    // above is the single source. The per-sub-agent repeat was the main handoff snowball.
  }
  const priorBlock = priorLines.length
    ? priorLines.join('\n')
    : (resuming ? '- (prior same-role sub-agents are in this session — see conversation)' : '- (none)');

  return renderTemplate(templates.interSubAgentSection, { contracts: contractsBlock, priorPhases: priorBlock });
}

export function interSubAgentConstraintFromTemplate(role, repoRoot) {
  const { templates } = loadHandoffConfig(repoRoot);
  if (role === 'review') return templates.constraintReview;
  return renderTemplate(templates.constraintImplementer, { role });
}

export function loadHandoffPolicy(repoRoot) {
  return loadHandoffConfig(repoRoot).policy;
}

export function isAnnotationOnlySummary(summary = '') {
  const s = String(summary);
  if (!s.trim()) return true;
  const syncHeavy =
    /annotation|tier|validate_annotations|orphan|graph refreshed|detailed tier|write_annotation|annotations clean/i.test(
      s,
    );
  const workSignals =
    /route|api|endpoint|contract|response|docker|scaffold|created|implement|fix|component|express|vite|compose|delivered|files/i.test(
      s,
    );
  return syncHeavy && !workSignals;
}

/** Build the record threaded to the next sub-agent — agent AgentRunResult fields only. */
export function finalizeHandoff(spec, result, ok, _repoRoot) {
  const filesChanged = result?.filesChanged ?? [];
  const contractsChanged = agentContracts(result);

  let workSummary = typeof result?.summary === 'string' ? result.summary : '';
  if (isAnnotationOnlySummary(workSummary)) {
    if (filesChanged.length) workSummary = `Delivered: ${filesChanged.join(', ')}`;
    else if (contractsChanged.length) workSummary = result.summary;
    else workSummary = '(completed — see files/contracts below)';
  }

  return {
    role: spec.role,
    scope: spec.scope,
    ok,
    status: result?.status ?? 'n/a',
    workSummary,
    summary: result?.summary ?? '',
    filesChanged,
    graphNodesTouched: result?.graphNodesTouched ?? [],
    contractsChanged,
    testsRun: result?.testsRun ?? [],
    blockers: result?.blockers ?? [],
  };
}

export function buildInterSubAgentTaskSection(priorHandoffs = [], repoRoot, opts = {}) {
  return buildInterSubAgentSectionFromTemplate(priorHandoffs, repoRoot, opts);
}

export function interSubAgentHandoffConstraint(role, repoRoot) {
  return interSubAgentConstraintFromTemplate(role, repoRoot);
}

export { CONFIG_NAME as HANDOFF_CONFIG_FILE };
