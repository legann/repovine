/**
 * Every tool call shown in generated agent guidance must remain executable against the live
 * tool schema. This is a correctness oracle, not a markdown snapshot: it parses the actual
 * rendered bodies and rejects unknown arguments as well as invalid enum/value shapes.
 */
import { describe, expect, it } from '@jest/globals';

import { BUILTIN_MANIFESTS } from '../../../src/agents/manifests.js';
import { renderImplementerBrief } from '../../../src/cli/agent-projection.js';
import {
  AGENTS,
  CLAUDE_SHARED_SKILLS,
  CODEX_SHARED_SKILLS,
  COMMANDS,
  CURSOR_RULES,
  CURSOR_SHARED_SKILLS,
  PROJECT_SAMPLE_SUBAGENT_MD,
  PROJECT_SUBAGENT_TEMPLATE_MD,
  renderSkillMarkdown,
} from '../../../src/cli/onboarding-assets.js';
import { AGENTS_MD } from '../../../src/cli/templates.js';
import { toolDefs } from '../../../src/mcp/tool-defs.js';

type ExtractedCall = {
  source: string;
  tool: string;
  rawArgs: string;
  offset: number;
};

const toolByName = new Map(toolDefs.map(definition => [definition.name, definition]));

function renderedGuidance(): Array<{ source: string; content: string }> {
  const assets = [
    ...COMMANDS,
    ...CURSOR_SHARED_SKILLS,
    ...CLAUDE_SHARED_SKILLS,
    ...CODEX_SHARED_SKILLS,
    ...CURSOR_RULES,
    ...AGENTS,
  ];
  const out = assets.flatMap((asset, index) => [
    {
      source: `asset:${asset.name}:${index}:body`,
      content: asset.body,
    },
    {
      source: `asset:${asset.name}:${index}:skill`,
      content: renderSkillMarkdown(asset),
    },
  ]);
  out.push(
    { source: 'project-subagent:sample', content: PROJECT_SAMPLE_SUBAGENT_MD },
    { source: 'project-subagent:template', content: PROJECT_SUBAGENT_TEMPLATE_MD },
    { source: 'agents-md', content: AGENTS_MD },
  );
  for (const manifest of BUILTIN_MANIFESTS) {
    out.push({
      source: `harness-brief:${manifest.role}`,
      content: renderImplementerBrief(manifest),
    });
  }
  return out;
}

function extractCalls(source: string, content: string): ExtractedCall[] {
  const calls: ExtractedCall[] = [];
  const names = [...toolByName.keys()].sort((left, right) => right.length - left.length);
  const pattern = new RegExp(`\\b(${names.join('|')})\\s*\\(`, 'g');
  for (const match of content.matchAll(pattern)) {
    const tool = match[1];
    const open = match.index! + match[0].lastIndexOf('(');
    const close = matchingParen(content, open);
    if (close === -1) {
      throw new Error(`${source}:${lineOf(content, open)} has an unclosed ${tool}(...) example`);
    }
    calls.push({
      source,
      tool,
      rawArgs: content.slice(open + 1, close).trim(),
      offset: open,
    });
    pattern.lastIndex = close + 1;
  }
  return calls;
}

function matchingParen(content: string, open: number): number {
  let depth = 0;
  let quote: '"' | null = null;
  let escaped = false;
  for (let index = open; index < content.length; index++) {
    const char = content[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"') {
      quote = '"';
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return index;
  }
  return -1;
}

function lineOf(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

describe('generated agent tool examples', () => {
  it('parses and validates every rendered tool call against its live schema', () => {
    const failures: string[] = [];
    let callCount = 0;

    for (const rendered of renderedGuidance()) {
      for (const call of extractCalls(rendered.source, rendered.content)) {
        callCount++;
        const location = `${call.source}:${lineOf(rendered.content, call.offset)}`;
        let args: unknown;
        try {
          args = JSON.parse(call.rawArgs);
        } catch (error) {
          failures.push(`${location} ${call.tool}: invalid JSON (${String(error)})`);
          continue;
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          failures.push(`${location} ${call.tool}: arguments must be one JSON object`);
          continue;
        }
        const definition = toolByName.get(call.tool)!;
        const knownArgs = new Set(Object.keys(definition.schema.shape));
        const unknownArgs = Object.keys(args).filter(key => !knownArgs.has(key));
        if (unknownArgs.length > 0) {
          failures.push(`${location} ${call.tool}: unknown argument(s): ${unknownArgs.join(', ')}`);
          continue;
        }
        const parsed = definition.schema.safeParse(args);
        if (!parsed.success) {
          failures.push(
            `${location} ${call.tool}: ${parsed.error.issues.map(issue => (
              `${issue.path.join('.') || '<root>'}: ${issue.message}`
            )).join('; ')}`,
          );
        }
      }
    }

    expect(callCount).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  });
});
