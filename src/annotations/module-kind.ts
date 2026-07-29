/**
 * Heuristic classification of a module into a "kind" so that annotation quality
 * scoring and recommended-field guidance can be type-specific instead of flat.
 *
 * Mapping mirrors the prose tables in the plugin's repovine-annotation-writer
 * agent and annotations skill, but is now data-driven from graph/snapshot.
 */

import type { ModuleInfo, GraphNode } from '../types.js';
import {
  API_HANDLER_PATH_TOKENS,
  hasHttpHandlerSignals,
  isBackendContext,
  isFrontendSurfaceModule,
} from '../analysis/architecture/heuristics.js';
// Side-effect: ensure built-in source plugins are registered so pluginHasUiSurfaces can
// resolve them when this module runs outside a build (MCP/unit-test path). Cheap — registers
import { pluginHasUiSurfaces } from '../plugin-host/source-set.js';

export type ModuleKind =
  | 'types'        // type/interface-only exports — describe shape, not behavior
  | 'ui'           // frontend component, route, page, SFC, JSX-heavy
  | 'api-handler'  // HTTP/SQS/Schedule handler, lambda entrypoint
  | 'adapter'      // adapter/repository/client/integration to external system
  | 'service-mgr'  // service/manager/use-case/processor encapsulating business rules
  | 'infra'        // IaC infraModule (CloudFormation/SAM/k8s/terraform/dockerfile)
  | 'runtime-resource' // graph runtime-resource node (logical infra resource: lambda/queue/...)
  | 'template'     // graph template/rendered-surface artifact
  | 'domain'       // domain aggregator node
  | 'generic';

interface InferInput {
  /** Module info from snapshot. Optional for non-module graph nodes. */
  mod?: ModuleInfo;
  /** Graph node (module/service/domain/etc.). */
  node?: GraphNode;
}

/** Path tokens that strongly imply a particular kind. Order matters within each list. */
const UI_PATH_TOKENS = ['/components/', '/component/', '/pages/', '/page/', '/views/', '/view/', '/screens/', '/screen/', '/widgets/', '/widget/', '/layouts/', '/layout/'];
const ADAPTER_PATH_TOKENS = ['/adapters/', '/adapter/', '/repositories/', '/repository/', '/repos/', '/clients/', '/client/', '/integrations/', '/integration/', '/dao/', '/gateways/', '/gateway/'];
const SERVICE_MGR_PATH_TOKENS = ['/services/', '/service/', '/managers/', '/manager/', '/usecases/', '/use-cases/', '/processors/', '/processor/', '/workflows/', '/workflow/'];

/**
 * Extensions whose files carry a UI component by the ecosystem's own convention: a single-file
 * component, or a module written in the JSX dialects. Declared here because two layers ask the
 * same question — module kind and the architecture heuristics — and each used to spell the set
 * twice.
 *
 * Not derived from plugin capabilities: `uiSurfaces` says the PLUGIN produces frontend surfaces,
 * which is true of every `.ts` file the TypeScript plugin owns. This is the narrower fact that a
 * FILE carries a component because of what it is named.
 */
const SFC_EXTENSIONS_RE = /\.(vue|svelte)$/i;
export const UI_COMPONENT_EXTENSIONS_RE = /\.(tsx|jsx|vue|svelte)$/i;

const UI_NAME_RE = UI_COMPONENT_EXTENSIONS_RE;
const SFC_NAME_RE = SFC_EXTENSIONS_RE;

function pathHasToken(filePath: string, tokens: string[]): boolean {
  const lower = filePath.toLowerCase();
  return tokens.some(t => lower.includes(t));
}

/**
 * Strict "types-only" check: every export is a pure-type shape declaration with
 * no runtime form. This catches a `types.ts` / `index.ts` re-export aggregator
 * style file.
 */
function isTypesOnlyModule(mod: ModuleInfo): boolean {
  if (mod.exports.length === 0) return false;
  for (const e of mod.exports) {
    if (e.kind !== 'type' && e.kind !== 'interface') return false;
  }
  return true;
}

/**
 * Classify a node for annotation purposes. Returns 'generic' when nothing
 * specific can be determined.
 *
 * For non-module graph nodes (domain/service/infra) the kind is fixed by node type.
 */
export function inferModuleKind(input: InferInput): ModuleKind {
  const { mod, node } = input;

  // Non-module graph nodes have fixed kinds.
  if (node) {
    if (node.type === 'domain') return 'domain';
    if (node.type === 'runtime-resource') return 'runtime-resource';
    if (node.type === 'template') return 'template';
  }

  // Infra modules are recognized by id prefix. They live in `snapshot.infraModules`
  // (not in `modulesById`), so `mod` will typically be missing — checking the
  // graph node's id is the reliable signal.
  if (mod?.id?.startsWith('infra:') || node?.id?.startsWith('infra:')) return 'infra';

  if (!mod) return 'generic';

  // Pure type declarations win first — they need only summary + keyExports.
  if (isTypesOnlyModule(mod)) return 'types';

  const relPath = mod.pkgRelPath ?? '';
  const hints = mod.semanticHints;
  // Frontend ('ui') classification is restricted to plugins that produce frontend surfaces.
  // Modules from backend-only plugins (Python, …) carry no frontend hints and must never be
  // labeled 'ui' even if a path token coincides. A module with no plugin defaults to true
  // (legacy TS-default), preserved by pluginHasUiSurfaces.
  const hasFrontendSurfaces = pluginHasUiSurfaces(mod.sourcePluginId);

  // Backend / BFF before UI: weak frontend hints (e.g. AI SDK imports) must not become ui.
  if (isBackendContext(mod)) {
    if (hasHttpHandlerSignals(mod) || hints?.ui || hints?.ssr?.useServer) {
      return 'api-handler';
    }
  }

  // UI heuristics: SFC, shared frontend-surface check, or explicit UI path tokens.
  if (hasFrontendSurfaces && SFC_NAME_RE.test(relPath)) return 'ui';
  if (hasFrontendSurfaces && isFrontendSurfaceModule(mod)) return 'ui';
  if (hints?.hasRoutes) {
    // hasRoutes appears both for SPA route declarations and API route files.
    if (pathHasToken(relPath, API_HANDLER_PATH_TOKENS) || hints.routes?.some(r => r.kind === 'api')) {
      return 'api-handler';
    }
    if (hasFrontendSurfaces && hints.ssr?.useClient) return 'ui';
  }
  if (hasFrontendSurfaces && pathHasToken(relPath, UI_PATH_TOKENS) && UI_NAME_RE.test(relPath)) return 'ui';

  // API handler heuristics: lambdas/handlers/routes path, or runtime triggers
  // signaling SQS/HTTP/Schedule entrypoints.
  if (hints?.runtimeActions && hints.runtimeActions.length > 0
      && pathHasToken(relPath, API_HANDLER_PATH_TOKENS)) return 'api-handler';
  if (pathHasToken(relPath, API_HANDLER_PATH_TOKENS)) return 'api-handler';
  if (hasHttpHandlerSignals(mod)) return 'api-handler';

  // Adapter / repository style.
  if (pathHasToken(relPath, ADAPTER_PATH_TOKENS)) return 'adapter';

  // Service / manager style.
  if (pathHasToken(relPath, SERVICE_MGR_PATH_TOKENS)) return 'service-mgr';

  return 'generic';
}

/**
 * Recommended annotation fields for a given module kind.
 * Returns the fields that an agent SHOULD populate to reach a good score
 * for that kind. Backbone is `summary` (always required) plus kind-specific extras.
 */
export function recommendedFieldsForKind(kind: ModuleKind): readonly string[] {
  switch (kind) {
    case 'types':
      return ['summary', 'keyExports'];
    case 'ui':
      return ['summary', 'assumptions', 'sideEffects', 'stateShape'];
    case 'api-handler':
      return ['summary', 'flowDescription', 'sideEffects', 'risks', 'assumptions'];
    case 'adapter':
      return ['summary', 'assumptions', 'sideEffects', 'patterns', 'integrationPoints'];
    case 'service-mgr':
      return ['summary', 'assumptions', 'sideEffects', 'risks', 'invariants'];
    case 'infra':
      return ['summary', 'assumptions', 'sideEffects', 'risks'];
    case 'runtime-resource':
      return ['summary', 'assumptions', 'sideEffects', 'risks'];
    case 'template':
      return ['summary', 'assumptions', 'dataFlow', 'risks'];
    case 'domain':
      return ['summary', 'assumptions', 'invariants', 'integrationPoints', 'extensionPoints'];
    case 'generic':
    default:
      return ['summary', 'keyExports', 'assumptions'];
  }
}
