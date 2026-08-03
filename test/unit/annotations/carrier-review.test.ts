import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  carrierReviewFilePath,
  carrierTargetRiskHash,
  mergeCarrierReviewEntries,
  readCarrierReviewFile,
  readValidSuppressedTargets,
  writeCarrierReviewFile,
} from '../../../src/annotations/carrier-review.js';
import type { AnnotationContent, StoredAnnotation } from '../../../src/types.js';

function ann(nodeId: string, annotation: AnnotationContent): StoredAnnotation {
  return {
    nodeId,
    nodeType: 'module',
    contentHash: `${nodeId}:hash`,
    pass: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    annotation,
    schemaVersion: 1,
  };
}

describe('carrierTargetRiskHash', () => {
  it('hashes only consumer-scoped risk texts, order-independent', () => {
    const a = carrierTargetRiskHash({
      summary: 'S',
      risks: [
        { text: 'beta gate', scope: 'consumer' },
        { text: 'alpha gate', scope: 'consumer' },
        { text: 'ignored local', scope: 'local' },
        'ignored plain',
      ],
    });
    const b = carrierTargetRiskHash({
      summary: 'Different summary',
      risks: [
        { text: 'alpha gate', scope: 'consumer' },
        { text: 'beta gate', scope: 'consumer' },
        { text: 'ignored boundary', scope: 'boundary' },
      ],
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('changes when the consumer risk set changes and handles missing annotations', () => {
    const before = carrierTargetRiskHash({ summary: 'S', risks: [{ text: 'gate', scope: 'consumer' }] });
    const after = carrierTargetRiskHash({ summary: 'S', risks: [{ text: 'reworded gate', scope: 'consumer' }] });
    expect(before).not.toBe(after);
    expect(carrierTargetRiskHash(undefined)).toHaveLength(16);
  });
});

describe('carrier-review file state', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-review-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('round-trips reviewed targets and validates a matching riskHash', () => {
    const annotations = {
      'mod:T': ann('mod:T', { summary: 'Target', risks: [{ text: 'gate', scope: 'consumer' }] }),
    };
    writeCarrierReviewFile(repoRoot, {
      version: 1,
      reviewedTargets: {
        'mod:T': {
          riskHash: carrierTargetRiskHash(annotations['mod:T'].annotation),
          decidedAt: '2026-07-13T00:00:00.000Z',
          reason: 'type/config hub',
        },
      },
    });

    expect(readCarrierReviewFile(repoRoot).reviewedTargets['mod:T']?.reason).toBe('type/config hub');
    expect(readValidSuppressedTargets(repoRoot, annotations)).toEqual(new Set(['mod:T']));
  });

  it('invalidates suppression when the consumer risk set changed after the decision', () => {
    writeCarrierReviewFile(repoRoot, {
      version: 1,
      reviewedTargets: {
        'mod:T': {
          riskHash: carrierTargetRiskHash({ summary: 'Target', risks: [{ text: 'old gate', scope: 'consumer' }] }),
          decidedAt: '2026-07-13T00:00:00.000Z',
        },
      },
    });

    const annotations = {
      'mod:T': ann('mod:T', { summary: 'Target', risks: [{ text: 'new gate', scope: 'consumer' }] }),
    };

    expect(readValidSuppressedTargets(repoRoot, annotations)).toEqual(new Set());
  });

  it('treats a missing, corrupt, or wrong-version file as empty state', () => {
    expect(readCarrierReviewFile(repoRoot).reviewedTargets).toEqual({});

    fs.mkdirSync(path.dirname(carrierReviewFilePath(repoRoot)), { recursive: true });
    fs.writeFileSync(carrierReviewFilePath(repoRoot), '{not json', 'utf-8');
    expect(readCarrierReviewFile(repoRoot).reviewedTargets).toEqual({});

    fs.writeFileSync(carrierReviewFilePath(repoRoot), JSON.stringify({ version: 2, reviewedTargets: { 'mod:T': { riskHash: 'x', decidedAt: 'y' } } }), 'utf-8');
    expect(readCarrierReviewFile(repoRoot).reviewedTargets).toEqual({});
  });

  it('drops malformed entries on read and keeps well-formed ones', () => {
    fs.mkdirSync(path.dirname(carrierReviewFilePath(repoRoot)), { recursive: true });
    fs.writeFileSync(carrierReviewFilePath(repoRoot), JSON.stringify({
      version: 1,
      reviewedTargets: {
        'mod:ok': { riskHash: 'abc', decidedAt: '2026-07-13T00:00:00.000Z' },
        'mod:no-hash': { decidedAt: '2026-07-13T00:00:00.000Z' },
        'mod:not-object': 'nope',
      },
    }), 'utf-8');

    expect(Object.keys(readCarrierReviewFile(repoRoot).reviewedTargets)).toEqual(['mod:ok']);
  });

  it('merges new entries without dropping prior decisions', () => {
    writeCarrierReviewFile(repoRoot, {
      version: 1,
      reviewedTargets: {
        'mod:A': { riskHash: 'aaaa', decidedAt: '2026-07-12T00:00:00.000Z' },
      },
    });

    const merged = mergeCarrierReviewEntries(repoRoot, {
      'mod:B': { riskHash: 'bbbb', decidedAt: '2026-07-13T00:00:00.000Z', reason: 'reviewed' },
    });

    expect(Object.keys(merged.reviewedTargets).sort()).toEqual(['mod:A', 'mod:B']);
    expect(readCarrierReviewFile(repoRoot).reviewedTargets['mod:A']?.riskHash).toBe('aaaa');
  });
});
