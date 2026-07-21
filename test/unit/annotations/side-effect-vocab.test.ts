import { describe, it, expect } from '@jest/globals';
import {
  SIDE_EFFECT_KINDS,
  SideEffectSchema,
  hasKind,
  hasKindSubtype,
  hasPersistentEffect,
  hasSubtype,
  isPure,
  serializeSideEffect,
  truncateSideEffect,
} from '../../../src/annotations/side-effect-vocab.js';

describe('SIDE_EFFECT_KINDS', () => {
  it('contains the 11 fundamental kinds', () => {
    expect(SIDE_EFFECT_KINDS).toEqual([
      'io-read', 'io-write',
      'state-local', 'state-global',
      'process', 'concurrency', 'time',
      'subscribe', 'external', 'resource',
      'pure',
    ]);
  });
});

describe('SideEffectSchema', () => {
  it('accepts minimal entry (kind only)', () => {
    expect(SideEffectSchema.safeParse({ kind: 'pure' }).success).toBe(true);
  });

  it('accepts full entry (kind + subtype + description)', () => {
    const r = SideEffectSchema.safeParse({
      kind: 'io-write',
      subtype: 'http',
      description: 'POST /api/users',
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown kind', () => {
    expect(SideEffectSchema.safeParse({ kind: 'mutate-everything' }).success).toBe(false);
  });

  it('rejects missing kind', () => {
    expect(SideEffectSchema.safeParse({ subtype: 'http' }).success).toBe(false);
  });

  it('rejects legacy string format', () => {
    expect(SideEffectSchema.safeParse('writes to db').success).toBe(false);
  });
});

describe('AnnotationContentSchema sideEffects: empty array is rejected', () => {
  // Import here to avoid pulling AnnotationContentSchema as default vocab export.
  it('rejects sideEffects: [] (use [{kind:"pure"}] or omit instead)', async () => {
    const { AnnotationContentSchema } = await import('../../../src/annotations/store.js');
    const result = AnnotationContentSchema.safeParse({
      summary: 'a module that does nothing',
      sideEffects: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/empty|pure/i);
    }
  });

  it('accepts omitted sideEffects', async () => {
    const { AnnotationContentSchema } = await import('../../../src/annotations/store.js');
    expect(AnnotationContentSchema.safeParse({ summary: 'omit ok' }).success).toBe(true);
  });

  it('accepts [{kind:"pure"}] as declared-pure', async () => {
    const { AnnotationContentSchema } = await import('../../../src/annotations/store.js');
    expect(AnnotationContentSchema.safeParse({
      summary: 'declared pure',
      sideEffects: [{ kind: 'pure' }],
    }).success).toBe(true);
  });
});

describe('isPure', () => {
  it('returns false for undefined or empty', () => {
    expect(isPure(undefined)).toBe(false);
    expect(isPure([])).toBe(false);
  });

  it('returns true for a single pure sentinel', () => {
    expect(isPure([{ kind: 'pure' }])).toBe(true);
  });

  it('returns true for pure with description', () => {
    expect(isPure([{ kind: 'pure', description: 'derives totals' }])).toBe(true);
  });

  it('returns false when any non-pure effect is present', () => {
    expect(isPure([{ kind: 'pure' }, { kind: 'io-write' }])).toBe(false);
    expect(isPure([{ kind: 'io-read' }])).toBe(false);
  });
});

describe('hasKind', () => {
  const effects = [
    { kind: 'io-write' as const, subtype: 'http' },
    { kind: 'state-global' as const, description: 'mutates store' },
  ];

  it('matches present kind', () => {
    expect(hasKind(effects, 'io-write')).toBe(true);
    expect(hasKind(effects, 'state-global')).toBe(true);
  });

  it('does not match missing kind', () => {
    expect(hasKind(effects, 'io-read')).toBe(false);
    expect(hasKind(effects, 'pure')).toBe(false);
  });

  it('handles undefined gracefully', () => {
    expect(hasKind(undefined, 'io-write')).toBe(false);
  });
});

describe('hasSubtype', () => {
  const effects = [
    { kind: 'io-write' as const, subtype: 'http' },
    { kind: 'io-read' as const, subtype: 'DB' },
  ];

  it('matches case-insensitively', () => {
    expect(hasSubtype(effects, 'http')).toBe(true);
    expect(hasSubtype(effects, 'HTTP')).toBe(true);
    expect(hasSubtype(effects, 'db')).toBe(true);
  });

  it('does not match missing subtype', () => {
    expect(hasSubtype(effects, 'fs')).toBe(false);
  });
});

describe('hasKindSubtype', () => {
  const effects = [{ kind: 'io-write' as const, subtype: 'http' }];

  it('matches kind+subtype pair', () => {
    expect(hasKindSubtype(effects, 'io-write', 'http')).toBe(true);
  });

  it('matches kind alone when subtype omitted', () => {
    expect(hasKindSubtype(effects, 'io-write')).toBe(true);
  });

  it('does not match wrong subtype', () => {
    expect(hasKindSubtype(effects, 'io-write', 'db')).toBe(false);
  });

  it('does not match wrong kind', () => {
    expect(hasKindSubtype(effects, 'io-read', 'http')).toBe(false);
  });
});

describe('hasPersistentEffect (investigate `effect` source)', () => {
  it('fires on a non-console io-write', () => {
    expect(hasPersistentEffect([{ kind: 'io-write', subtype: 'db' }])).toBe(true);
    expect(hasPersistentEffect([{ kind: 'io-write', subtype: 'fs' }])).toBe(true);
    expect(hasPersistentEffect([{ kind: 'io-write' }])).toBe(true); // no subtype = real write
  });

  it('fires on a state-global mutation', () => {
    expect(hasPersistentEffect([{ kind: 'state-global', description: 'updates store' }])).toBe(true);
  });

  it('does not fire on stdout/stderr writes', () => {
    expect(hasPersistentEffect([{ kind: 'io-write', subtype: 'stdout' }])).toBe(false);
    expect(hasPersistentEffect([{ kind: 'io-write', subtype: 'STDERR' }])).toBe(false);
  });

  it('does not fire on reads, local state, or pure', () => {
    expect(hasPersistentEffect([{ kind: 'io-read', subtype: 'db' }])).toBe(false);
    expect(hasPersistentEffect([{ kind: 'state-local' }])).toBe(false);
    expect(hasPersistentEffect([{ kind: 'pure' }])).toBe(false);
  });

  it('fires when a persistent write coexists with a console write', () => {
    expect(hasPersistentEffect([
      { kind: 'io-write', subtype: 'stdout' },
      { kind: 'io-write', subtype: 'queue' },
    ])).toBe(true);
  });

  it('handles undefined gracefully', () => {
    expect(hasPersistentEffect(undefined)).toBe(false);
    expect(hasPersistentEffect([])).toBe(false);
  });
});

describe('serializeSideEffect', () => {
  it('serializes kind only', () => {
    expect(serializeSideEffect({ kind: 'pure' })).toBe('pure');
  });

  it('serializes kind + subtype', () => {
    expect(serializeSideEffect({ kind: 'io-write', subtype: 'http' })).toBe('io-write: http');
  });

  it('serializes full triple', () => {
    expect(serializeSideEffect({
      kind: 'io-write',
      subtype: 'http',
      description: 'POST /api/users',
    })).toBe('io-write: http: POST /api/users');
  });

  it('omits empty parts', () => {
    expect(serializeSideEffect({ kind: 'state-global', description: 'mutates store' }))
      .toBe('state-global: mutates store');
  });
});

describe('truncateSideEffect', () => {
  it('passes through when description fits', () => {
    const se = { kind: 'io-write' as const, description: 'short' };
    expect(truncateSideEffect(se, 100)).toEqual(se);
  });

  it('truncates long description and appends ellipsis', () => {
    const se = { kind: 'io-write' as const, description: 'x'.repeat(50) };
    const out = truncateSideEffect(se, 10);
    expect(out.description!.length).toBe(10);
    expect(out.description!.endsWith('…')).toBe(true);
  });

  it('preserves kind and subtype when truncating', () => {
    const se = { kind: 'io-write' as const, subtype: 'http', description: 'x'.repeat(50) };
    const out = truncateSideEffect(se, 10);
    expect(out.kind).toBe('io-write');
    expect(out.subtype).toBe('http');
  });

  it('passes through when description is missing', () => {
    const se = { kind: 'pure' as const };
    expect(truncateSideEffect(se, 5)).toEqual(se);
  });
});
