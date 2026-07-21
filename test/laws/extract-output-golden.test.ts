import { describe, expect, it, beforeAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRepositoryFactsAsync, STAGE1_ANALYSIS_VERSION } from '../../src/stage1/index.js';
import { extractOutputFingerprint } from '../../src/stage1/cache.js';
import type { RepositoryFactsSnapshot } from '../../src/types.js';
import { findFixturesRoot } from './graph-law-helpers.js';

// Golden net over STAGE1_ANALYSIS_VERSION: extractOutputFingerprint changes exactly when stage1
// extract output changes on a fixed corpus, so an extract change that ships without a version bump
// is caught. The fingerprint folds the extracted facts themselves (imports/exports/calls/reExports/
// semanticHints/infra resources/template structure), not just source contentHash, so an extract-logic
// change with byte-identical source still moves it. Fixtures are interpreter-independent (TS + IaC)
// so the golden is stable across CI envs; a Python/hybrid fixture would make it depend on an external
// interpreter.
//
// The committed golden also carries a per-fixture STRUCTURAL SUMMARY (counts of modules/exports/
// imports/... and semanticHint kinds). It is a review aid only: on a fingerprint mismatch the test
// prints the committed-vs-current summary diff so a reviewer distinguishes a benign reshuffle from a
// semantics regression. The fingerprint, not the summary, is the guard.
//
// Regenerate after an intended extract change: `UPDATE_EXTRACT_GOLDEN=1 npm test -- extract-output-golden`.
// If the change alters graph semantics consumers depend on, bump STAGE1_ANALYSIS_VERSION first so
// caches invalidate; if it is cache-compatible, refreshing the golden without a bump is correct.

const FIXTURES = ['basic-typescript', 'sam-lambda-app'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(HERE, 'extract-output-golden.json');
const UPDATE = process.env.UPDATE_EXTRACT_GOLDEN === '1';

interface StructuralSummary {
  modules: number;
  exports: number;
  imports: number;
  calls: number;
  reExports: number;
  infraModules: number;
  infraResources: number;
  templates: number;
  semanticHintKinds: Record<string, number>;
}

interface Golden {
  version: number;
  fingerprints: Record<string, string>;
  summaries?: Record<string, StructuralSummary>;
}

/** Compact, deterministic structural counts for reviewer-facing diffs. Semantics only — never
 * folded into the fingerprint; a divergence here is a hint, the fingerprint is the verdict. */
function summarize(snapshot: RepositoryFactsSnapshot): StructuralSummary {
  let exportsCount = 0;
  let importsCount = 0;
  let callsCount = 0;
  let reExportsCount = 0;
  const hintKinds: Record<string, number> = {};
  const bump = (k: string, n: number) => {
    if (n > 0) hintKinds[k] = (hintKinds[k] ?? 0) + n;
  };
  for (const m of snapshot.modules) {
    exportsCount += m.exports?.length ?? 0;
    importsCount += m.imports?.length ?? 0;
    callsCount += m.calls?.length ?? 0;
    for (const e of m.exports ?? []) callsCount += e.calls?.length ?? 0;
    reExportsCount += m.reExports?.length ?? 0;
    const s = m.semanticHints;
    if (s) {
      bump('routes', s.routes?.length ?? 0);
      bump('envVars', s.envVars?.length ?? 0);
      bump('runtimeActions', s.runtimeActions?.length ?? 0);
      bump('security', s.security?.length ?? 0);
      bump('conditionalRenders', s.conditionalRenders?.length ?? 0);
      bump('effectImports', s.effectImports?.length ?? 0);
      bump('ssr', s.ssr ? 1 : 0);
      bump('ui', s.ui ? 1 : 0);
    }
  }
  let infraResources = 0;
  for (const im of snapshot.infraModules ?? []) infraResources += im.resources?.length ?? 0;
  return {
    modules: snapshot.modules.length,
    exports: exportsCount,
    imports: importsCount,
    calls: callsCount,
    reExports: reExportsCount,
    infraModules: snapshot.infraModules?.length ?? 0,
    infraResources,
    templates: snapshot.templates?.length ?? 0,
    semanticHintKinds: hintKinds,
  };
}

async function analyze(fixture: string): Promise<{ fingerprint: string; summary: StructuralSummary }> {
  const root = path.join(findFixturesRoot(), fixture);
  const origLog = console.log;
  console.log = () => {};
  try {
    const snapshot = await collectRepositoryFactsAsync(root);
    return { fingerprint: extractOutputFingerprint(snapshot), summary: summarize(snapshot) };
  } finally {
    console.log = origLog;
  }
}

describe('core-laws extract-output golden (G-extract)', () => {
  const computed: Record<string, string> = {};
  const summaries: Record<string, StructuralSummary> = {};
  beforeAll(async () => {
    for (const f of FIXTURES) {
      const { fingerprint, summary } = await analyze(f);
      computed[f] = fingerprint;
      summaries[f] = summary;
    }
  });

  if (UPDATE) {
    it('regenerates the committed golden', () => {
      let prior: Golden | undefined;
      try {
        prior = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
      } catch {
        prior = undefined;
      }
      if (prior && prior.version === STAGE1_ANALYSIS_VERSION) {
        for (const f of FIXTURES) {
          if (prior.fingerprints[f] && prior.fingerprints[f] !== computed[f]) {
            console.warn(
              `\n⚠ extract output changed for "${f}" while STAGE1_ANALYSIS_VERSION is still ${STAGE1_ANALYSIS_VERSION}.\n` +
                `  If this alters graph semantics consumers depend on, bump STAGE1_ANALYSIS_VERSION so caches invalidate.\n` +
                `  If it is cache-compatible, refreshing the golden without a bump is correct.\n`,
            );
          }
        }
      }
      const next: Golden = {
        version: STAGE1_ANALYSIS_VERSION,
        fingerprints: { ...computed },
        summaries: { ...summaries },
      };
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(next, null, 2) + '\n');
      expect(fs.existsSync(GOLDEN_PATH)).toBe(true);
    });
  } else {
    it('extract output matches the committed golden', () => {
      const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
      for (const f of FIXTURES) {
        if (computed[f] !== golden.fingerprints[f]) {
          const committed = golden.summaries?.[f];
          const current = summaries[f];
          const diff = committed
            ? `\nStructural summary diff (committed → current):\n${JSON.stringify(committed, null, 2)}\n→\n${JSON.stringify(current, null, 2)}\n`
            : `\nCurrent structural summary:\n${JSON.stringify(current, null, 2)}\n`;
          throw new Error(
            `Stage-1 extract output for "${f}" changed (golden ${golden.fingerprints[f]} != ${computed[f]}).${diff}` +
              `If intended: run \`UPDATE_EXTRACT_GOLDEN=1 npm test -- extract-output-golden\`. First decide —\n` +
              `bump STAGE1_ANALYSIS_VERSION when the change alters graph semantics consumers rely on (invalidates caches),\n` +
              `or refresh the golden without a bump when the change is cache-compatible.`,
          );
        }
      }
    });

    it('golden version matches STAGE1_ANALYSIS_VERSION', () => {
      const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
      expect(golden.version).toBe(STAGE1_ANALYSIS_VERSION);
    });

    it('golden carries a structural summary for every fixture', () => {
      const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
      for (const f of FIXTURES) {
        expect(golden.summaries?.[f]).toBeDefined();
      }
    });
  }
});
