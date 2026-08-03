/**
 * Parity gate — the registry refactor (flat if-chain → detector registry
 * with `appliesTo`) must be byte-for-byte invisible at the `analyze_architecture`
 * surface.
 *
 * `expected.json` golden suites pin the GRAPH, not detector findings, so they do
 * not cover this. This test runs `runRefactoringReport` with ALL categories
 * (`minConfidence: 0`, `limit: 200`) on representative fixtures and compares the
 * full returned findings list against a committed golden captured from the
 * pre-refactor code. Regenerate with `UPDATE_PARITY_GOLDEN=1 npm test`.
 *
 * Fixtures are chosen to exercise the `appliesTo` regimes and every detector
 * category that actually fires on the corpus (trust-boundary-validation,
 * duplicate-like, annotation-risk, god-module, boundary, low-cohesion):
 *   - react-spa        — all TypeScript frontend (frontend detectors run, no skip)
 *   - basic-python     — all Python (frontend detectors skipped via capability)
 *   - basic-python-web — Python web (richest: trust-boundary + annotation-risk + god-module)
 *   - hybrid-monorepo  — mixed TS + Python (mixed-scope appliesTo)
 *   - sveltekit        — Svelte frontend + routes
 *   - nextjs-app-router — Next.js app router
 *   - sam-lambda-app   — code + SAM infra
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { collectRepositoryFactsAsync } from '../../../../src/stage1/index.js';
import { composeRepositoryGraph } from '../../../../src/stage2/index.js';
import { AnnotationStore } from '../../../../src/annotations/store.js';
import {
  runRefactoringReport,
  REFACTORING_CATEGORIES,
  type RefactoringState,
} from '../../../../src/analysis/architecture/index.js';
import type { ModuleInfo } from '../../../../src/types.js';

const FIXTURES = [
  'react-spa',
  'basic-python',
  'basic-python-web',
  'hybrid-monorepo',
  'sveltekit',
  'nextjs-app-router',
  'sam-lambda-app',
] as const;
const UPDATE = process.env.UPDATE_PARITY_GOLDEN === '1';

function goldenDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'unit', 'analysis', 'architecture', '__parity__'),
    path.resolve(process.cwd(), 'repovine', 'test', 'unit', 'analysis', 'architecture', '__parity__'),
  ];
  return candidates.find(candidate => fs.existsSync(path.dirname(candidate))) ?? candidates[0];
}

const GOLDEN_DIR = goldenDir();

function fixtureRoot(name: string): string {
  const candidates = [
    path.resolve(process.cwd(), 'test', 'fixtures', name),
    path.resolve(process.cwd(), 'repovine', 'test', 'fixtures', name),
  ];
  const root = candidates.find(candidate => fs.existsSync(candidate));
  if (!root) throw new Error(`Could not find fixture ${name}. Tried: ${candidates.join(', ')}`);
  return root;
}

async function buildState(name: string): Promise<RefactoringState> {
  const snapshot = await collectRepositoryFactsAsync(fixtureRoot(name));
  const modulesById = new Map<string, ModuleInfo>();
  for (const m of snapshot.modules) modulesById.set(m.id, m);
  const graph = composeRepositoryGraph(snapshot, modulesById);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detector-registry-parity-'));
  return { graph, modulesById, annotations: AnnotationStore.createSync(tmpDir), snapshot };
}

/**
 * Project the report down to the behaviour-defining fields. The handoff requires
 * `id + category + nodes + confidence` to be identical; we additionally pin
 * severity/impact/title/evidence/suggestion so any drift in detector output is
 * caught, while dropping volatile envelope metadata.
 */
function projectReport(report: Record<string, unknown>): unknown {
  const findings = (report.findings as RefactoringFindingLike[]).map(f => ({
    id: f.id,
    category: f.category,
    confidence: f.confidence,
    severity: f.severity,
    impact: f.impact,
    title: f.title,
    nodes: f.nodes,
    evidence: f.evidence,
    suggestion: f.suggestion,
  }));
  return {
    scope: report.scope,
    totalFindings: report.totalFindings,
    returnedFindings: report.returnedFindings,
    summary: report.summary,
    findings,
  };
}

interface RefactoringFindingLike {
  id: string;
  category: string;
  confidence: number;
  severity: string;
  impact: string;
  title: string;
  nodes: string[];
  evidence: string[];
  suggestion: string;
}

describe('refactoring detector registry — findings parity', () => {
  beforeAll(() => {
    if (UPDATE) fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  });

  for (const fixture of FIXTURES) {
    it(`${fixture}: all-categories report matches golden`, async () => {
      const state = await buildState(fixture);
      const report = runRefactoringReport(state, {
        categories: [...REFACTORING_CATEGORIES],
        minConfidence: 0,
        limit: 200,
      });
      const actual = projectReport(report);
      const goldenPath = path.join(GOLDEN_DIR, `${fixture}.json`);

      if (UPDATE) {
        fs.writeFileSync(goldenPath, `${JSON.stringify(actual, null, 2)}\n`);
        return;
      }

      expect(fs.existsSync(goldenPath)).toBe(true);
      const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
      expect(actual).toEqual(golden);
    });
  }
});
