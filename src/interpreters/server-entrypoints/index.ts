import type { Interpreter } from '../../interpreter/types.js';
import { SERVER_ENTRYPOINTS_INTERPRETER_ID, collectBackendRouteEntrypoints } from './entrypoints.js';

/** Builtin server entrypoint interpreter for normalized TS/Python route hints. */
export const serverEntrypointsInterpreter: Interpreter = {
  id: SERVER_ENTRYPOINTS_INTERPRETER_ID,
  sourceAdapterIds: ['typescript', 'python'],
  requiresSemanticHints: ['routes'],
  collectEntrypoints: collectBackendRouteEntrypoints,
};
