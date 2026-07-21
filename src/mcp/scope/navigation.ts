import type { ResolvedScope } from './resolve.js';
import type { Navigation, NavigationItem } from '../response/envelope.js';
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAP_LIMIT,
  DEFAULT_SEARCH_LIMIT,
} from '../response/pagination.js';

function emptyNavigation(): Navigation {
  return { deeper: [], sideways: [], up: [], cross_layer: [], validate: [] };
}

function nav(tool: string, args: Record<string, unknown>, reason: string): NavigationItem {
  return { tool, args, reason };
}

export function scopeNavigation(scope: ResolvedScope): Navigation {
  const n = emptyNavigation();
  if (scope.kind !== 'all') {
    n.up.push(nav('map_context', { scope: 'all', view: 'summary' }, 'Return to the repository-level map.'));
  }
  if (scope.kind === 'package') {
    n.sideways.push(nav('get_entrypoints', { scope: scope.resolvedScope, limit: DEFAULT_LIST_LIMIT }, 'Find execution starts in this area.'));
    n.sideways.push(nav('analyze_dependencies', { scope: scope.resolvedScope }, 'Check import/export coupling and package boundaries.'));
    n.cross_layer.push(nav('trace_flow', { scope: scope.resolvedScope }, 'Follow runtime/data flow for this area.'));
    n.validate.push(nav('get_annotation_status', { scope: scope.resolvedScope, view: 'coverage' }, 'Check whether annotations are fresh enough to trust.'));
  }
  if (scope.kind === 'domain') {
    const label = scope.domainId?.replace(/^domain:/, '') ?? scope.raw.replace(/^domain:/, '');
    n.deeper.push(nav('map_context', { scope: scope.resolvedScope, view: 'modules', limit: DEFAULT_MAP_LIMIT }, 'List modules tagged with this semantic/path domain.'));
    n.sideways.push(nav('search_context', { query: `${label} handler route lambda`, limit: DEFAULT_SEARCH_LIMIT }, 'Look for runtime anchors related to this domain instead of tracing the domain tag directly.'));
    n.sideways.push(nav('analyze_dependencies', { scope: scope.resolvedScope, mode: 'import-map' }, 'Check imports for modules tagged with this domain.'));
    n.validate.push(nav('get_annotation_status', { scope: scope.resolvedScope, view: 'coverage' }, 'Check whether annotations are fresh enough to trust.'));
  }
  if (scope.nodeId && (scope.kind === 'module' || scope.kind === 'export-symbol')) {
    n.sideways.push(nav('analyze_dependencies', { scope: scope.nodeId, mode: 'impact', depth: 3 }, 'Check consumers before changing this node.'));
    n.sideways.push(nav('get_config_surface', { scope: scope.nodeId }, 'Check hidden config/resource bindings for this node.'));
  }
  return n;
}
