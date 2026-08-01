import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { ContextSessionPolicySchema } from '../../src/agents/protocol.js';
import { findRepovineRoot, makeProject } from './core-schema.js';

// Law: the two ContextSessionPolicy shapes share one tuning-field set and differ only by their
// one surface-specific field.
//
// The same name covers two ends of one policy: the wire schema a harness sends (protocol.ts, with
// sessionId) and the internal scorer config (context-quality/types.ts, with assignmentScope, injected
// from assignment.scope). The nine tuning fields must stay identical across both, but nothing tied
// them — a renamed or added tuning field could drift one side while the mapping between them silently
// breaks. This pins each shape to the shared set plus its own field. The interface members are read
// from source with ts-morph because a TypeScript interface has no runtime shape.

const SHARED_TUNING = [
  'required',
  'mode',
  'phase',
  'qualityThreshold',
  'warningThreshold',
  'minAnchors',
  'byteBudget',
  'maxRecoveryAttempts',
  'retain',
] as const;

/** Property names of the ContextSessionPolicy interface in context-quality/types.ts. */
function scorerPolicyKeys(): string[] {
  const root = findRepovineRoot();
  const project = makeProject(root);
  const sourceFile = project.addSourceFileAtPath(path.join(root, 'src', 'context-quality', 'types.ts'));
  const iface = sourceFile.getInterfaceOrThrow('ContextSessionPolicy');
  return iface.getProperties().map((property) => property.getName());
}

describe('core-laws the two ContextSessionPolicy shapes stay aligned', () => {
  it('the protocol wire schema is the shared tuning set plus sessionId', () => {
    expect(Object.keys(ContextSessionPolicySchema.shape).sort()).toEqual(
      [...SHARED_TUNING, 'sessionId'].sort(),
    );
  });

  it('the context-quality scorer policy is the shared tuning set plus assignmentScope', () => {
    expect(scorerPolicyKeys().sort()).toEqual([...SHARED_TUNING, 'assignmentScope'].sort());
  });
});
