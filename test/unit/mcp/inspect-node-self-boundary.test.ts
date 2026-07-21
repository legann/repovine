import { describe, it, expect } from '@jest/globals';
import { selfBoundaryAttention } from '../../../src/mcp/tools/inspect-node.js';
import type { AnnotationContent } from '../../../src/types.js';

const withRisks = (risks: AnnotationContent['risks']): AnnotationContent => ({
  summary: 'synthetic annotation for the self-boundary attention test',
  risks,
});

describe('selfBoundaryAttention', () => {
  it('hoists the inspected node\'s own boundary risk to a leading attention item', () => {
    const item = selfBoundaryAttention(
      'mod:@backend/src/models/tool',
      withRisks([{ text: 'frozen slug codec; do not add name policy here', scope: 'boundary' }]),
    );
    expect(item).toEqual({
      nodeId: 'mod:@backend/src/models/tool',
      investigate: ['boundary'],
      note: 'off-limits boundary surface — this node',
      next: { tool: 'analyze_dependencies', args: { scope: 'mod:@backend/src/models/tool', mode: 'impact' } },
    });
  });

  it('returns undefined when the node carries only local- or consumer-scoped risks', () => {
    expect(
      selfBoundaryAttention('mod:app/service', withRisks(['a bare local risk', { text: 'importer must verify the gate', scope: 'consumer' }])),
    ).toBeUndefined();
  });

  it('returns undefined when the node has no annotation', () => {
    expect(selfBoundaryAttention('mod:app/service', undefined)).toBeUndefined();
  });
});
