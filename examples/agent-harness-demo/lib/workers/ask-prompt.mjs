// Read-only /ask prompt — agent mode with repovine MCP + file reads (like IDE chat).
import { attachmentsBrief } from './prompt.mjs';

export const ASK_POLICY = [
  'READ-ONLY Q&A MODE (agent-harness-demo /ask):',
  '- Answer the user question about the sandbox project under the current working directory.',
  '- Orient with repovine MCP first when useful: search_context, map_context, inspect_node,',
  '  analyze_dependencies, get_config_surface, trace_flow, get_entrypoints.',
  '- Read source files with your read tools when MCP or excerpts are not enough.',
  '- Do NOT create, edit, or delete files. Do NOT call refresh_context or write_annotation.',
  '- Do NOT run npm install/build/test, docker, dev servers, or other shell commands.',
  '- Reply in plain prose in the same language as the question.',
  '- Do NOT emit an Agent Protocol AgentRunResult JSON block — only the answer text.',
].join('\n');

/**
 * @param {string} question
 * @param {{ resuming?: boolean, contextSessionId?: string, attachments?: Array<{path:string,mediaType?:string,caption?:string}> }} [opts]
 */
export function buildAskPrompt(question, { resuming = false, contextSessionId, attachments } = {}) {
  const lines = [
    ASK_POLICY,
    '',
    `Question: ${question}`,
  ];
  if (contextSessionId) {
    lines.push(`contextSessionId (pass on repovine MCP calls): ${contextSessionId}`);
  }
  // A photo attached to this /ask turn: point the agent at the saved file so it opens
  // the image with its Read tool (same path-based delivery as /task; single source).
  const brief = attachmentsBrief({ attachments });
  if (brief) {
    lines.push('', brief);
  }
  if (resuming) {
    lines.push('', '(Continuing the same /ask conversation — answer the question above.)');
  } else {
    lines.push('', 'Investigate with MCP and file reads as needed, then answer.');
  }
  return lines.join('\n');
}
