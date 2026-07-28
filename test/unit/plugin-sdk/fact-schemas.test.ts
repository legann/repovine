import { describe, expect, it } from '@jest/globals';
import {
  validateSemanticModuleDelta,
  validateSemanticInfraDelta,
} from '@repovine/plugin-sdk';

// Untrusted plugin output is Zod-validated at the boundary. These schemas must accept well-formed
// facts, including semanticHints carrying a slot core does not know yet, and reject
// structurally-broken ones. Known nested slots keep their declared shape.
describe('plugin-sdk fact schemas (untrusted-output boundary)', () => {
  it('accepts a well-formed source module delta with a forward-compatible hint slot', () => {
    const r = validateSemanticModuleDelta({
      moduleId: 'mod:pkg/svc',
      imports: [{ moduleSpecifier: 'os', importedNames: ['getenv'], isTypeOnly: false, isExternal: true }],
      exports: [{ name: 'handler', kind: 'function', lineRange: { start: 1, end: 9 }, isDefault: false }],
      semanticHints: { webFramework: 'fooframework', futureSlot: { x: 1 } },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a module delta missing required fields', () => {
    const r = validateSemanticModuleDelta({ moduleId: 'mod:pkg/svc', imports: 'not-an-array' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.length).toBeGreaterThan(0);
  });

  it('accepts a well-formed infra delta and rejects a malformed one', () => {
    const good = validateSemanticInfraDelta({
      kind: 'foo-infra',
      resources: [
        { id: 'r1', kind: 'queue', provider: 'aws', contentHash: 'abc', attributes: { Name: 'q' } },
      ],
    });
    expect(good.ok).toBe(true);

    const bad = validateSemanticInfraDelta({ kind: 'foo-infra', resources: [{ id: 'r1' }] });
    expect(bad.ok).toBe(false);
  });
});
