import { builtinPluginRuntime } from '../../src/stage1/plugin-loader.js';
import type { DeclarationCatalog } from '../../src/plugins/declaration-catalog.js';

/**
 * The declaration catalog a real build carries: what the bundled plugin packages declare.
 *
 * A synthetic snapshot has no catalog, and a build with no catalog knows nothing about any resource
 * kind — which is the contract, not a gap. A test that hand-builds a snapshot and expects the
 * linking a shipped plugin's declarations produce has to carry those declarations, exactly as
 * Stage 1 does on every build.
 */
export function builtinDeclarationCatalog(): DeclarationCatalog {
  return builtinPluginRuntime().runtime.catalog;
}
