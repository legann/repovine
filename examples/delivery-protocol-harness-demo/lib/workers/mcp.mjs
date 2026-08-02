// Shared repovine MCP wiring for harness workers and /ask agents.
import { REPOVINE_CLI } from '../repovine.mjs';

/** Claude Agent SDK tool ids for read-only repovine MCP (no graph/annotation writes). */
export const REPOVINE_ASK_MCP_TOOLS = [
  'mcp__repovine__search_context',
  'mcp__repovine__map_context',
  'mcp__repovine__inspect_node',
  'mcp__repovine__analyze_dependencies',
  'mcp__repovine__get_config_surface',
  'mcp__repovine__trace_flow',
  'mcp__repovine__get_entrypoints',
  'mcp__repovine__get_build_status',
  'mcp__repovine__get_annotation_status',
  'mcp__repovine__validate_annotations',
];

/** repovine MCP tool ids that mutate graph/annotation state — denied on the read-only /ask path. */
export const REPOVINE_WRITE_MCP_TOOLS = [
  'mcp__repovine__refresh_context',
  'mcp__repovine__write_annotation',
  'mcp__repovine__merge_annotations',
];

/** Claude Agent SDK tool ids for implementer workers (includes annotation sync). */
export const REPOVINE_WORKER_MCP_TOOLS = [
  ...REPOVINE_ASK_MCP_TOOLS,
  'mcp__repovine__refresh_context',
  'mcp__repovine__write_annotation',
  'mcp__repovine__get_annotation_merge_status',
  'mcp__repovine__merge_annotations',
];

export function repovineMcpEnv(repoRoot, contextSessionId, { inheritProcessEnv = false } = {}) {
  const base = inheritProcessEnv ? { ...process.env } : {};
  return {
    ...base,
    REPOVINE_ROOT: repoRoot,
    ...(contextSessionId ? { REPOVINE_CONTEXT_SESSION_ID: contextSessionId } : {}),
  };
}

export function buildRepovineMcpStdio(repoRoot, contextSessionId, opts) {
  return {
    type: 'stdio',
    command: 'node',
    args: [REPOVINE_CLI],
    env: repovineMcpEnv(repoRoot, contextSessionId, opts),
  };
}
