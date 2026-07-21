import type { Interpreter } from '../interpreter/types.js';
import { codeStructureInterpreter } from './code-structure/index.js';
import { infraRuntimeLinksInterpreter } from './infra-runtime-links/index.js';
import { serverEntrypointsInterpreter } from './server-entrypoints/index.js';
import { serverTemplatesInterpreter } from './server-templates/index.js';
import { uiEntrypointsInterpreter } from './ui-entrypoints/index.js';

/**
 * Built-in semantic interpreters ship here. Keep this list in stable order; the interpreter composer will
 * topo-sort explicit requiresInterpreters[] edges within this deterministic base order. code-structure builds the
 * base graph first; infra-runtime-links requires it. Entrypoint replay order is driven by the MCP shell,
 * not by this list.
 */
export const INTERNAL_INTERPRETERS: Interpreter[] = [
  codeStructureInterpreter,
  infraRuntimeLinksInterpreter,
  serverEntrypointsInterpreter,
  serverTemplatesInterpreter,
  uiEntrypointsInterpreter,
];
