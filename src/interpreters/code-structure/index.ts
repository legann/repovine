import { emptyGraphDelta } from '../../graph/index.js';
import type { Interpreter } from '../../interpreter/types.js';
import { contributeStructural } from './graph.js';

export const CODE_STRUCTURE_INTERPRETER_ID = 'code-structure';

/** Builtin code-structure interpreter: root/packages/modules/import edges/export symbols. */
export const codeStructureInterpreter: Interpreter = {
  id: CODE_STRUCTURE_INTERPRETER_ID,
  // The node set itself: packages, modules, export symbols and import edges between them.
  phase: 'nodes',
  contributeGraph: (ctx) => {
    contributeStructural(ctx.graph, ctx.snapshot);
    return emptyGraphDelta();
  },
};
