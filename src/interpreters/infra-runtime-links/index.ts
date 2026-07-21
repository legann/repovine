import { emptyGraphDelta } from '../../graph/index.js';
import type { Interpreter } from '../../interpreter/types.js';
import { CODE_STRUCTURE_INTERPRETER_ID } from '../code-structure/index.js';
import { collectServiceTriggerEntrypoints, INFRA_RUNTIME_LINKS_INTERPRETER_ID } from './entrypoints.js';
import { contributeInfraLink } from './graph.js';

/** Builtin infra-runtime-links interpreter: infra/service graph + runtime links + service-trigger entrypoints. */
export const infraRuntimeLinksInterpreter: Interpreter = {
  id: INFRA_RUNTIME_LINKS_INTERPRETER_ID,
  sourceAdapterIds: '*',
  // Needs code-structure module nodes present before resolving handlers / linking infra edges.
  requiresInterpreters: [CODE_STRUCTURE_INTERPRETER_ID],
  contributeGraph: (ctx) => {
    contributeInfraLink(ctx.graph, ctx.snapshot, ctx.modulesById, ctx.domainsConfig);
    return emptyGraphDelta();
  },
  collectEntrypoints: collectServiceTriggerEntrypoints,
};
