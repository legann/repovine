import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { findRepovineRoot, makeProject } from './core-schema.js';

// Law: the compliance judge does not know about roles, manifests, or projections.
//
// checkCompliance validates a run result against observable repository state. What a role requires
// (result fields, edit capability) is resolved by the caller and handed in as data —
// `requiredRunResultFields` and `readOnlyManifestName`. If `validation.ts` imported `manifests.ts`
// again, the judge would re-acquire role knowledge and the boundary would rot back to a review
// convention. This reads the import declarations from source and asserts none targets the manifest
// module, so the separation holds by build rather than by discipline.

/** Module specifiers of every import declaration in src/agents/validation.ts. */
function validationImportSpecifiers(): string[] {
  const root = findRepovineRoot();
  const project = makeProject(root);
  const sourceFile = project.addSourceFileAtPath(path.join(root, 'src', 'agents', 'validation.ts'));
  return sourceFile.getImportDeclarations().map((decl) => decl.getModuleSpecifierValue());
}

/** True when a specifier resolves to the manifests module (with or without the `.js` suffix). */
function targetsManifests(specifier: string): boolean {
  const normalized = specifier.replace(/\.js$/, '');
  return normalized === './manifests' || normalized.endsWith('/manifests');
}

describe('core-laws the compliance judge stays role-agnostic', () => {
  it('src/agents/validation.ts imports nothing from manifests.ts', () => {
    const specifiers = validationImportSpecifiers();
    // Non-vacuous: the file has imports, so an empty list means the source did not resolve, not that
    // the check passed.
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter(targetsManifests)).toEqual([]);
  });
});
