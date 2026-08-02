// Claude worker adapter (LLM_PROVIDER=claude, the default).
//
// The Claude Agent SDK implementation already lives in lib/claude-agent.mjs.
// Re-export it here so the graph's run_sub_agent node only ever talks to
// lib/workers/<provider>.mjs.
//
// Auth: claude-agent.mjs calls resolveAuth('claude') from lib/workers/auth.mjs.
// MCP: launched as a stdio server (mcp__repovine__*) inside the SDK options,
// scoped to repoRoot — see lib/claude-agent.mjs.
export { runAgent } from '../claude-agent.mjs';

export const provider = 'claude';
