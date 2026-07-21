import { emptyGraphDelta } from '../../graph/index.js';
import type { Interpreter } from '../../interpreter/types.js';
import { contributeStructural } from './graph.js';

export const CODE_STRUCTURE_INTERPRETER_ID = 'code-structure';

/** Builtin code-structure interpreter: root/packages/modules/import edges/export symbols. */
export const codeStructureInterpreter: Interpreter = {
  id: CODE_STRUCTURE_INTERPRETER_ID,
  sourceAdapterIds: '*',
  contributeGraph: (ctx) => {
    contributeStructural(ctx.graph, ctx.snapshot);
    return emptyGraphDelta();
  },
};
