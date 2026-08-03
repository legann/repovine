import type { Interpreter } from '../../interpreter/types.js';
import { collectUiRouteEntrypoints, UI_ENTRYPOINTS_INTERPRETER_ID } from './entrypoints.js';

/** Builtin UI entrypoint interpreter (JSX routes, conditional renders, file pages). */
export const uiEntrypointsInterpreter: Interpreter = {
  id: UI_ENTRYPOINTS_INTERPRETER_ID,
  phase: 'links',
  // The two hint slots a UI surface arrives in. Whoever produced them, this reads the same facts.
  requiresSemanticHints: ['routes', 'conditionalRenders'],
  collectEntrypoints: collectUiRouteEntrypoints,
};
