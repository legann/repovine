import { emptyGraphDelta } from '../../graph/index.js';
import type { Interpreter } from '../../interpreter/types.js';
import { collectServiceTriggerEntrypoints, INFRA_RUNTIME_LINKS_INTERPRETER_ID } from './entrypoints.js';
import { contributeInfraLink } from './graph.js';

/** Builtin infra-runtime-links interpreter: infra/service graph + runtime links + service-trigger entrypoints. */
export const infraRuntimeLinksInterpreter: Interpreter = {
  id: INFRA_RUNTIME_LINKS_INTERPRETER_ID,
  // Resolves handlers and draws infra edges into the module nodes the `nodes` phase left behind.
  phase: 'links',
  contributeGraph: (ctx) => {
    contributeInfraLink(ctx.graph, ctx.snapshot, ctx.modulesById, ctx.domainsConfig);
    return emptyGraphDelta();
  },
  collectEntrypoints: collectServiceTriggerEntrypoints,
};
