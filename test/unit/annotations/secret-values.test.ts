import { describe, expect, it } from '@jest/globals';
import {
  containsSecretValue,
  annotationSecretFieldPaths,
} from '../../../src/annotations/secret-values.js';

// The secret matcher is shared by the write path (mcp/lib/annotations.ts), the
// annotation-secret-hygiene detector (detectors.ts) and its detail view (detail.ts). This pins the
// single source of truth so the three cannot drift.
describe('annotation secret matcher', () => {
  it('flags literal secret values but treats all-caps names as non-secret', () => {
    expect(containsSecretValue(`sk_live_${'a'.repeat(20)}`)).toBe(true);
    expect(containsSecretValue(`ghp_${'b'.repeat(30)}`)).toBe(true);
    expect(containsSecretValue('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(containsSecretValue(`token=${'c'.repeat(20)}`)).toBe(true);

    expect(containsSecretValue('API_TOKEN')).toBe(false); // a variable NAME, not a value
    expect(containsSecretValue('a short human summary sentence')).toBe(false);
  });

  // An AWS access key id is upper-case letters and digits, which is exactly what the env-var-name
  // exemption describes. Consulting the exemption first let every such key through, and the write
  // path stored it: the credential dictionary decides before the exemption is reached.
  it('decides provider credentials before the env-var-name exemption', () => {
    expect(containsSecretValue('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(containsSecretValue('AWS_ACCESS_KEY_ID')).toBe(false);
    expect(annotationSecretFieldPaths({ envDependencies: { AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE' } }))
      .toEqual(['annotation.envDependencies.AWS_ACCESS_KEY_ID']);
  });

  // The write path refused an eight-character assignment while the detector required sixteen, so a
  // value the writer rejected stayed unreported once it was in the file by another route.
  it('uses one assignment length for every surface', () => {
    expect(containsSecretValue(`token=${'c'.repeat(8)}`)).toBe(true);
    expect(containsSecretValue('token=short')).toBe(false);
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
