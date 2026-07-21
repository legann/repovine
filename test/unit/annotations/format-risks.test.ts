import { describe, expect, it } from '@jest/globals';
import {
  AnnotationContentSchema,
  consumerRiskMarkingHints,
  hasBoundaryScopedRisk,
  hasConsumerScopedRisk,
  normalizeRisks,
  riskEntryTexts,
} from '../../../src/annotations/format.js';
import { StoredAnnotationSchema } from '../../../src/annotations/format.js';

describe('normalizeRisks', () => {
  it('normalizes plain strings to local scope', () => {
    expect(normalizeRisks(['a', 'b'])).toEqual([
      { text: 'a', scope: 'local' },
      { text: 'b', scope: 'local' },
    ]);
  });

  it('preserves consumer scope on object entries', () => {
    expect(normalizeRisks([
      { text: 'importers must verify', scope: 'consumer' },
      { text: 'local only' },
      'legacy string',
    ])).toEqual([
      { text: 'importers must verify', scope: 'consumer' },
      { text: 'local only', scope: 'local' },
      { text: 'legacy string', scope: 'local' },
    ]);
  });

  it('detects consumer-scoped risks', () => {
    expect(hasConsumerScopedRisk({ summary: 'x', risks: ['local'] })).toBe(false);
    expect(hasConsumerScopedRisk({
      summary: 'x',
      risks: [{ text: 'verify at consumer', scope: 'consumer' }],
    })).toBe(true);
  });

  it('accepts consumer scope in annotation schema', () => {
    const parsed = AnnotationContentSchema.parse({
      summary: 'Test module',
      risks: [{ text: 'consumer must check', scope: 'consumer' }],
    });
    expect(parsed.risks).toEqual([{ text: 'consumer must check', scope: 'consumer' }]);
    expect(riskEntryTexts(parsed.risks)).toEqual(['consumer must check']);
  });
});

describe('boundary-scoped risk (investigate `boundary` source)', () => {
  it('preserves boundary scope through normalizeRisks', () => {
    expect(normalizeRisks([
      { text: 'published contract — do not edit', scope: 'boundary' },
      { text: 'importers must verify', scope: 'consumer' },
      'legacy string',
    ])).toEqual([
      { text: 'published contract — do not edit', scope: 'boundary' },
      { text: 'importers must verify', scope: 'consumer' },
      { text: 'legacy string', scope: 'local' },
    ]);
  });

  it('detects boundary-scoped risks; consumer detector is unaffected', () => {
    const content = { summary: 'x', risks: [{ text: 'off-limits surface', scope: 'boundary' as const }] };
    expect(hasBoundaryScopedRisk(content)).toBe(true);
    expect(hasConsumerScopedRisk(content)).toBe(false);
    expect(hasBoundaryScopedRisk({ summary: 'x', risks: [{ text: 'verify', scope: 'consumer' }] })).toBe(false);
    expect(hasBoundaryScopedRisk({ summary: 'x', risks: ['plain'] })).toBe(false);
  });

  it('round-trips scope:boundary through AnnotationContentSchema and StoredAnnotationSchema', () => {
    const parsed = AnnotationContentSchema.parse({
      summary: 'Frozen migration',
      risks: [{ text: 'frozen — do not edit in place', scope: 'boundary' }],
    });
    expect(parsed.risks).toEqual([{ text: 'frozen — do not edit in place', scope: 'boundary' }]);

    const stored = StoredAnnotationSchema.safeParse({
      nodeId: 'mod:x',
      nodeType: 'module',
      contentHash: 'h',
      pass: 1,
      updatedAt: '2024-01-01',
      annotation: parsed,
    });
    expect(stored.success).toBe(true);
  });
});

describe('consumerRiskMarkingHints (marking-bar)', () => {
  it('flags consumer risks that read as bare facts (no importer obligation)', () => {
    expect(consumerRiskMarkingHints({
      summary: 'x',
      risks: [{ text: 'token expires after one hour', scope: 'consumer' }],
    })).toEqual(['token expires after one hour']);
  });

  it('passes consumer risks that state the importer obligation', () => {
    expect(consumerRiskMarkingHints({
      summary: 'x',
      risks: [{ text: 'importer must verify the gate locally', scope: 'consumer' }],
    })).toEqual([]);
  });

  it('ignores local-scoped risks', () => {
    expect(consumerRiskMarkingHints({
      summary: 'x',
      risks: ['bare local fact', { text: 'another bare fact' }],
    })).toEqual([]);
  });
});
