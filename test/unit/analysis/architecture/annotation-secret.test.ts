import { describe, expect, it } from '@jest/globals';
import {
  containsSecretValue,
  annotationSecretFieldPaths,
} from '../../../../src/analysis/architecture/annotation-secret.js';

// The secret matcher is shared by the annotation-secret-hygiene detector (detectors.ts) and its
// detail view (detail.ts). This pins the single source of truth so the two cannot drift.
describe('annotation-secret shared matcher', () => {
  it('flags literal secret values but treats all-caps names as non-secret', () => {
    expect(containsSecretValue(`sk_live_${'a'.repeat(20)}`)).toBe(true);
    expect(containsSecretValue(`ghp_${'b'.repeat(30)}`)).toBe(true);
    expect(containsSecretValue('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(containsSecretValue(`token=${'c'.repeat(20)}`)).toBe(true);

    expect(containsSecretValue('API_TOKEN')).toBe(false); // a variable NAME, not a value
    expect(containsSecretValue('a short human summary sentence')).toBe(false);
  });

  it('walks nested bodies and returns dotted paths of secret-looking fields only', () => {
    const paths = annotationSecretFieldPaths({
      summary: 'nothing sensitive here',
      risks: [`token=${'d'.repeat(20)}`],
      nested: { key: `ghp_${'e'.repeat(30)}` },
    });
    expect(paths).toContain('annotation.risks[0]');
    expect(paths).toContain('annotation.nested.key');
    expect(paths).not.toContain('annotation.summary');
  });

  it('honors a custom root path label', () => {
    expect(annotationSecretFieldPaths(`sk_test_${'f'.repeat(20)}`, 'note')).toEqual(['note']);
  });
});
