import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRoleSetting,
  resolveClaudeRole,
  subAgentModelRole,
} from '../lib/model-role.mjs';

test('parseRoleSetting: model:effort pair', () => {
  assert.deepEqual(parseRoleSetting('opus:high'), { model: 'opus', effort: 'high' });
  assert.deepEqual(parseRoleSetting('sonnet:medium'), { model: 'sonnet', effort: 'medium' });
});

test('parseRoleSetting: effort-only token', () => {
  assert.deepEqual(parseRoleSetting('low'), { effort: 'low' });
  assert.deepEqual(parseRoleSetting('xhigh'), { effort: 'xhigh' });
});

test('parseRoleSetting: model-only token', () => {
  assert.deepEqual(parseRoleSetting('haiku'), { model: 'haiku' });
});

test('resolveClaudeRole: role defaults', () => {
  assert.deepEqual(resolveClaudeRole('planner'), { model: 'opus', effort: 'high' });
  assert.deepEqual(resolveClaudeRole('implementer'), { model: 'sonnet', effort: 'medium' });
  // Floor is sonnet for every role — haiku under-delivered detailed-tier annotations on the ask subAgents.
  assert.deepEqual(resolveClaudeRole('verify'), { model: 'sonnet', effort: 'low' });
  assert.deepEqual(resolveClaudeRole('ask'), { model: 'sonnet', effort: 'low' });
});

test('resolveClaudeRole: env override', (t) => {
  const prev = process.env.IMPLEMENTER_REASONING;
  process.env.IMPLEMENTER_REASONING = 'opus:max';
  t.after(() => {
    if (prev === undefined) delete process.env.IMPLEMENTER_REASONING;
    else process.env.IMPLEMENTER_REASONING = prev;
  });
  assert.deepEqual(resolveClaudeRole('implementer'), { model: 'opus', effort: 'max' });
});

test('subAgentModelRole: review subAgent maps to verify', () => {
  assert.equal(subAgentModelRole('review'), 'verify');
  assert.equal(subAgentModelRole('backend'), 'implementer');
});

test('subAgentModelRole: graph utility subAgents use ask defaults', () => {
  assert.equal(subAgentModelRole('repo-explorer'), 'ask');
  assert.equal(subAgentModelRole('annotation-writer'), 'ask');
});
