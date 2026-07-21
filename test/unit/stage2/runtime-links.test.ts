import { resolveArtifactRoot } from '../../../src/stage2/runtime-links.js';

describe('resolveArtifactRoot', () => {
  it('resolves Terraform filename relative to template directory', () => {
    const root = resolveArtifactRoot(
      { filename: '../dist/users.zip' },
      'infrastructure/main.tf',
    );
    expect(root?.replace(/\\/g, '/')).toBe('dist');
  });

  it('resolves SAM CodeUri', () => {
    const root = resolveArtifactRoot({ codeUri: 'apps/api/src' }, 'infra/template.yaml');
    expect(root).toBe('apps/api/src');
  });

  it("resolves CodeUri '.' to the template directory", () => {
    const root = resolveArtifactRoot({ codeUri: '.' }, 'infra/template.yaml');
    expect(root).toBe('infra');
  });

  it("returns undefined for CodeUri '.' with no template path", () => {
    const root = resolveArtifactRoot({ codeUri: '.' });
    expect(root).toBeUndefined();
  });

  it("resolves a './' relative CodeUri against the template directory", () => {
    const root = resolveArtifactRoot({ codeUri: './src' }, 'infra/template.yaml');
    expect(root).toBe('infra/src');
  });

  it("resolves a '../' relative CodeUri against the template directory", () => {
    const root = resolveArtifactRoot({ codeUri: '../shared/fn' }, 'infra/nested/template.yaml');
    expect(root).toBe('infra/shared/fn');
  });
});
