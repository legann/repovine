import type { Interpreter } from '../../interpreter/types.js';
import { SERVER_ENTRYPOINTS_INTERPRETER_ID, collectBackendRouteEntrypoints } from './entrypoints.js';

/** Builtin server entrypoint interpreter for normalized TS/Python route hints. */
export const serverEntrypointsInterpreter: Interpreter = {
  id: SERVER_ENTRYPOINTS_INTERPRETER_ID,
  phase: 'links',
  // Any producer's normalized route hints. The interpreter reads the fact, not who published it.
  requiresSemanticHints: ['routes'],
  collectEntrypoints: collectBackendRouteEntrypoints,
};
