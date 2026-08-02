import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { AgentAssignmentSchema, AgentRunResultSchema } from '../../src/agents/protocol.js';
import { findRepovineRoot } from './core-schema.js';

// Law: the worked example in docs/delivery-protocol.md parses under the live schemas.
//
// The integration guide ships two full JSON literals — an assignment and a result — labelled
// `assignment.json` and `result.json` in prose before each fenced block. Renaming a required schema
// field leaves those literals stale, and nothing noticed: the doc is prose, not a fixture. This
// extracts each labelled block by its label and parses it against the matching schema, so a required
// field renamed in the schema fails the documented literal that no longer carries it.

const DOC = fs.readFileSync(path.join(findRepovineRoot(), 'docs', 'delivery-protocol.md'), 'utf-8');

/** The JSON object inside the ```json block that follows a `<label>` marker in prose. */
function labelledJson(label: string): unknown {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('`' + escaped + '`[^\\n]*\\r?\\n+```json\\r?\\n([\\s\\S]*?)```').exec(DOC);
  if (!match) throw new Error(`docs/delivery-protocol.md has no \`${label}\` json block`);
  return JSON.parse(match[1]);
}

describe('core-laws the delivery-protocol doc example parses under the live schemas', () => {
  it('the `assignment.json` example is a valid AgentAssignment', () => {
    expect(() => AgentAssignmentSchema.parse(labelledJson('assignment.json'))).not.toThrow();
  });

  it('the `result.json` example is a valid AgentRunResult', () => {
    expect(() => AgentRunResultSchema.parse(labelledJson('result.json'))).not.toThrow();
  });
});
