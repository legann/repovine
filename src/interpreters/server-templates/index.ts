import type { Interpreter } from '../../interpreter/types.js';
import { SERVER_TEMPLATES_INTERPRETER_ID, contributeServerTemplates } from './templates.js';

/**
 * Builtin server-templates interpreter: projects `snapshot.templates` as `template` nodes and links
 * render units to them with `renders` edges. Requires code-structure so module/export-symbol nodes
 * already exist when the render edges are drawn.
 */
export const serverTemplatesInterpreter: Interpreter = {
  id: SERVER_TEMPLATES_INTERPRETER_ID,
  // Draws `renders` edges from render units to template nodes, so it reads the finished node set.
  phase: 'links',
  // Runs for whichever producer discovered templates, and not at all when none did.
  requiresSnapshotFacts: ['templates'],
  contributeGraph: contributeServerTemplates,
};
