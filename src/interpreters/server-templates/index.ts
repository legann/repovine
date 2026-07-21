import type { Interpreter } from '../../interpreter/types.js';
import { CODE_STRUCTURE_INTERPRETER_ID } from '../code-structure/index.js';
import { SERVER_TEMPLATES_INTERPRETER_ID, contributeServerTemplates } from './templates.js';

/**
 * Builtin server-templates interpreter: projects `snapshot.templates` as `template` nodes and links
 * render units to them with `renders` edges. Requires code-structure so module/export-symbol nodes
 * already exist when the render edges are drawn.
 */
export const serverTemplatesInterpreter: Interpreter = {
  id: SERVER_TEMPLATES_INTERPRETER_ID,
  sourceAdapterIds: ['python'],
  requiresInterpreters: [CODE_STRUCTURE_INTERPRETER_ID],
  contributeGraph: contributeServerTemplates,
};
