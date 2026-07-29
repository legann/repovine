import type { Interpreter } from '../interpreter/types.js';
import { codeStructureInterpreter } from './code-structure/index.js';
import { infraRuntimeLinksInterpreter } from './infra-runtime-links/index.js';
import { serverEntrypointsInterpreter } from './server-entrypoints/index.js';
import { serverTemplatesInterpreter } from './server-templates/index.js';
import { uiEntrypointsInterpreter } from './ui-entrypoints/index.js';

/**
 * Built-in semantic interpreters ship here. The composer applies them in declared phase order — the
 * node set first, then everything that links into it — so this list carries no ordering meaning of
 * its own. Entrypoint replay order is driven by the MCP shell, not by this list.
 */
export const INTERNAL_INTERPRETERS: Interpreter[] = [
  codeStructureInterpreter,
  infraRuntimeLinksInterpreter,
  serverEntrypointsInterpreter,
  serverTemplatesInterpreter,
  uiEntrypointsInterpreter,
];
