// Side-effect import: the built-in source plugins must be registered before this module asks the
import { stripModuleIdSuffix } from '../plugin-host/source-set.js';

/**
 * Short two-segment label for module and infra-module nodes. Neutral helper shared by the
 * structural and infra-link layers (both previously called the inline copy in stage2/index.ts).
 *
 * The suffix comes off through the registry, so the label reduces a path the same way the module id
 * does and never names a file that is not there: `global.d.ts` labels as `global`, not `global.d`,
 * and a barrel labels as `index` whether it is written `index.ts` or `index.mjs`. A path deeper
 * than two segments keeps its last two behind `…/`, which makes the label a display form — code
 * that needs a path reads `relativeFilePath` from the node instead.
 */
export function shortModuleLabel(relPath: string): string {
  const parts = stripModuleIdSuffix(relPath).split('/');
  if (parts.length <= 2) return parts.join('/');
  return `…/${parts.slice(-2).join('/')}`;
}
