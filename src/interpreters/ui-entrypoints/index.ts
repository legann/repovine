import type { Interpreter } from '../../interpreter/types.js';
import { collectUiRouteEntrypoints, UI_ENTRYPOINTS_INTERPRETER_ID } from './entrypoints.js';

/** Builtin UI entrypoint interpreter (JSX routes, conditional renders, file pages). */
export const uiEntrypointsInterpreter: Interpreter = {
  id: UI_ENTRYPOINTS_INTERPRETER_ID,
  sourceAdapterIds: ['typescript'],
  collectEntrypoints: collectUiRouteEntrypoints,
};
