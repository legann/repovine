/**
 * Phase A — annotation grounding: the consistency axis and its building blocks.
 *
 * Consistency is orthogonal to completeness (`score`/`tier`): it only flags filled fields that
 * contradict facts the graph already knows, never empty fields, and must never move score/tier.
 */
import { describe, it, expect } from '@jest/globals';
import { computeAnnotationQuality } from '../../../src/annotations/store.js';
import { detectSideEffectKindsFromHints } from '../../../src/annotations/side-effect-vocab.js';
import { owningModuleId } from '../../../src/graph/node-ids.js';
import type { SemanticHints } from '../../../src/types.js';

describe('computeAnnotationQuality — consistency axis', () => {
  it('flags keyExports drift (declared name not among real exports)', () => {
    const q = computeAnnotationQuality(
      {
        summary: 'A module exporting a couple of helpers for the X domain.',
        keyExports: { realFn: 'does X', ghostFn: 'does Y' },
      },
      { exportCount: 1, lineCount: 40, exportNames: ['realFn'] },
    );
    expect(q.consistency.ok).toBe(false);
    expect(q.consistency.issues).toContainEqual({ field: 'keyExports', kind: 'unknown-name', detail: 'ghostFn' });
    // the real export name must NOT be flagged
    expect(q.consistency.issues.some(i => i.detail === 'realFn')).toBe(false);
  });

  it('flags envDependencies drift (declared env var not detected)', () => {
    const q = computeAnnotationQuality(
      {
        summary: 'Reads configuration from the environment during startup.',
        envDependencies: { REAL_VAR: 'used', GHOST_VAR: 'never set' },
      },
      { exportCount: 1, lineCount: 30, envVars: ['REAL_VAR'] },
    );
    expect(q.consistency.ok).toBe(false);
    expect(q.consistency.issues).toContainEqual({ field: 'envDependencies', kind: 'unknown-name', detail: 'GHOST_VAR' });
  });

  it('flags declared-pure contradicting detected side effects', () => {
    const q = computeAnnotationQuality(
      {
        summary: 'Claims to be pure but the graph detected real effects.',
        sideEffects: [{ kind: 'pure' }],
      },
      { exportCount: 1, lineCount: 30, detectedSideEffectKinds: ['io-write', 'subscribe'] },
    );
    expect(q.consistency.ok).toBe(false);
    expect(q.consistency.issues).toContainEqual({
      field: 'sideEffects',
      kind: 'contradicts-hints',
      detail: 'declared pure; detected io-write,subscribe',
    });
  });

  it('does NOT flag empty fields — that is completeness\'s job, not consistency (no double-count)', () => {
    const q = computeAnnotationQuality(
      { summary: 'A minimal note with no keyExports, env, or side effects filled in.' },
      { exportCount: 3, lineCount: 80, exportNames: ['a', 'b'], envVars: ['FOO'], detectedSideEffectKinds: ['io-read'] },
    );
    // nothing filled → nothing to contradict
    expect(q.consistency.ok).toBe(true);
    expect(q.consistency.issues).toHaveLength(0);
    // completeness still reports the gaps
    expect(q.missingFields).toContain('keyExports');
  });

  it('skips a check when its ground truth is absent (never fabricate)', () => {
    const q = computeAnnotationQuality(
      {
        summary: 'Declares exports but no exportNames ground truth is supplied to the scorer.',
        keyExports: { anything: 'x' },
      },
      { exportCount: 1, lineCount: 20 }, // no exportNames
    );
    expect(q.consistency.ok).toBe(true);
    expect(q.consistency.issues).toHaveLength(0);
  });

  it('skips keyExports drift for a re-export barrel (no captured named exports → ground truth absent)', () => {
    const q = computeAnnotationQuality(
      { summary: 'A feature barrel that re-exports its public surface.', keyExports: { ReExportedA: 'x', ReExportedB: 'y' } },
      { exportCount: 0, lineCount: 5, exportNames: [] }, // stage1 captured no named exports
    );
    expect(q.consistency.ok).toBe(true);
    expect(q.consistency.issues).toHaveLength(0);
  });

  it('skips keyExports drift when only a default export is captured (barrel-with-default)', () => {
    const q = computeAnnotationQuality(
      { summary: 'A barrel whose only captured export is the default re-export.', keyExports: { handlerA: 'x', handlerB: 'y' } },
      { exportCount: 1, lineCount: 5, exportNames: ['default'] },
    );
    expect(q.consistency.ok).toBe(true);
  });

  it('still flags keyExports drift when named exports ARE captured', () => {
    const q = computeAnnotationQuality(
      { summary: 'A module with real named exports plus a default.', keyExports: { realFn: 'x', ghostFn: 'y' } },
      { exportCount: 2, lineCount: 5, exportNames: ['realFn', 'default'] },
    );
    expect(q.consistency.ok).toBe(false);
    expect(q.consistency.issues).toContainEqual({ field: 'keyExports', kind: 'unknown-name', detail: 'ghostFn' });
    expect(q.consistency.issues.some(i => i.detail === 'realFn' || i.detail === 'default')).toBe(false);
  });

  it('consistency does not move score/tier (orthogonality)', () => {
    const content = {
      summary: 'Identical content; only the supplied ground truth differs between the two runs.',
      keyExports: { realFn: 'x' },
    };
    const consistent = computeAnnotationQuality(content, { exportCount: 1, lineCount: 40, exportNames: ['realFn'] });
    const inconsistent = computeAnnotationQuality(content, { exportCount: 1, lineCount: 40, exportNames: ['other'] });

    expect(consistent.consistency.ok).toBe(true);
    expect(inconsistent.consistency.ok).toBe(false);
    // completeness is identical regardless of consistency
    expect(inconsistent.score).toBe(consistent.score);
    expect(inconsistent.tier).toBe(consistent.tier);
  });

  it('always attaches a consistency object to the result shape', () => {
    const q = computeAnnotationQuality(
      { summary: 'Baseline note with no ground truth supplied at all.' },
      { exportCount: 0, lineCount: 10 },
    );
    expect(q.consistency).toEqual({ ok: true, issues: [] });
  });
});

describe('detectSideEffectKindsFromHints', () => {
  it('returns undefined when hints are absent or carry no behavioral signal', () => {
    expect(detectSideEffectKindsFromHints(undefined)).toBeUndefined();
    expect(detectSideEffectKindsFromHints({})).toBeUndefined();
    // structural-only route declarations are not themselves an effect
    expect(detectSideEffectKindsFromHints({ hasRoutes: true, routes: [{ path: '/x', component: 'X', kind: 'api' }] }))
      .toBeUndefined();
  });

  it('maps detected runtime messaging actions to io-write', () => {
    expect(detectSideEffectKindsFromHints({ runtimeActions: [{ action: 'sqs.sendMessage' }] })).toEqual(['io-write']);
  });

  it('maps ui data access, timers and subscriptions honestly', () => {
    const hints: SemanticHints = {
      ui: {
        dataAccess: [
          { kind: 'fetch', callee: 'fetch' },
          { kind: 'mutation', callee: 'useMutation' },
        ],
        timers: [{ kind: 'interval', callee: 'setInterval' }],
        subscriptions: [{ kind: 'websocket', callee: 'ws' }],
      },
    };
    const kinds = detectSideEffectKindsFromHints(hints);
    expect(kinds).toEqual(expect.arrayContaining(['io-read', 'io-write', 'time', 'subscribe']));
  });

  it('maps plugin-reported effect imports (e.g. Python subprocess/requests) into kinds', () => {
    const hints: SemanticHints = {
      effectImports: [
        { kind: 'concurrency', source: 'subprocess' },
        { kind: 'io-read', source: 'requests' },
        { kind: 'not-a-kind', source: 'mystery' },
        { kind: 'pure', source: 'never-detected' },
      ],
    };
    expect(detectSideEffectKindsFromHints(hints)).toEqual(expect.arrayContaining(['concurrency', 'io-read']));
    expect(detectSideEffectKindsFromHints(hints)).toHaveLength(2);
  });

  it('contradicts a declared-pure annotation when effect imports are detected', () => {
    const q = computeAnnotationQuality(
      { summary: 'Claims to be a pure helper module over its inputs.', sideEffects: [{ kind: 'pure' }] },
      {
        exportCount: 1,
        lineCount: 20,
        exportNames: ['run_job'],
        detectedSideEffectKinds: detectSideEffectKindsFromHints({
          effectImports: [{ kind: 'concurrency', source: 'subprocess' }],
        }),
      },
    );
    expect(q.consistency.ok).toBe(false);
    expect(q.consistency.issues).toEqual([
      expect.objectContaining({ field: 'sideEffects', kind: 'contradicts-hints' }),
    ]);
  });

  it('accepts scope:consumer risk entries without affecting quality scoring', () => {
    const q = computeAnnotationQuality(
      {
        summary: 'Module with a consumer-scoped standing risk.',
        risks: [{ text: 'importers must verify', scope: 'consumer' }],
      },
      { exportCount: 1, lineCount: 40, exportNames: ['fn'] },
    );
    expect(q.score).toBeGreaterThan(0);
    expect(q.consistency.ok).toBe(true);
  });
});

describe('owningModuleId', () => {
  it('maps an export-symbol id to its owning module id', () => {
    expect(owningModuleId('export:repovine/src/annotations/store/computeAnnotationQuality'))
      .toBe('mod:repovine/src/annotations/store');
  });

  it('returns undefined for non-export-symbol ids or ids with no separable export segment', () => {
    expect(owningModuleId('mod:repovine/src/annotations/store')).toBeUndefined();
    expect(owningModuleId('export:foo')).toBeUndefined();
    expect(owningModuleId('domain:annotations')).toBeUndefined();
  });
});
