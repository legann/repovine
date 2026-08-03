import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compactHistory, estimateHistoryChars } from '../lib/workers/local.mjs';

// A native tool round: assistant(tool_calls) + its tool result. Used to verify the
// guard never orphans a tool message from the assistant that requested it.
function round(id, contentChars) {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'x' }) } }],
    },
    { role: 'tool', tool_call_id: id, name: 'read_file', content: 'X'.repeat(contentChars) },
  ];
}

function baseHistory(rounds) {
  return [
    { role: 'system', content: 'SYSTEM PROMPT' },
    { role: 'user', content: 'ORIGINAL TASK' },
    ...rounds.flat(),
  ];
}

// Every kept tool message must be preceded by an assistant message carrying its id.
function assertNoOrphanToolMessages(messages) {
  const seen = new Set();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) seen.add(tc.id);
    if (m.role === 'tool') assert.ok(seen.has(m.tool_call_id), `orphan tool message ${m.tool_call_id}`);
  }
}

test('estimateHistoryChars counts content and tool_call arguments', () => {
  const msgs = [
    { role: 'user', content: 'abcde' }, // 5 + 16
    {
      role: 'assistant',
      content: 'xy', // 2 + 16
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"z"}' } }], // 9 + 12
    },
  ];
  // 5+16 + 2+16 + 9(name) + 12(args) = 60
  assert.equal(estimateHistoryChars(msgs), 60);
});

test('compactHistory: no-op when history fits under budget', () => {
  const messages = baseHistory([round('t1', 40)]);
  const before = messages.slice();
  const res = compactHistory(messages, { budgetTokens: 100000, tokensPerChar: 0.25 });
  assert.equal(res.dropped, 0);
  assert.ok(res.fits);
  assert.deepEqual(messages, before);
});

test('compactHistory: disabled (budget 0) is a no-op', () => {
  const messages = baseHistory([round('t1', 4000), round('t2', 4000)]);
  const len = messages.length;
  const res = compactHistory(messages, { budgetTokens: 0, tokensPerChar: 0.25 });
  assert.equal(res.dropped, 0);
  assert.equal(messages.length, len);
});

test('compactHistory: evicts oldest rounds, pins system+task, keeps newest round', () => {
  const messages = baseHistory([round('t1', 4000), round('t2', 4000), round('t3', 4000)]);
  const res = compactHistory(messages, { budgetTokens: 300, tokensPerChar: 0.25 });

  assert.ok(res.dropped >= 1, 'should drop at least one old round');
  // Pinned head intact.
  assert.equal(messages[0].content, 'SYSTEM PROMPT');
  assert.equal(messages[1].content, 'ORIGINAL TASK');
  // Exactly one elision note, placed right after the pinned head.
  const notes = messages.filter((m) => typeof m.content === 'string' && m.content.startsWith('[context compacted:'));
  assert.equal(notes.length, 1);
  assert.equal(messages[2], notes[0]);
  // Newest round survives; oldest is gone.
  assert.ok(messages.some((m) => m.tool_call_id === 't3'), 'newest tool result kept');
  assert.ok(!messages.some((m) => m.tool_call_id === 't1'), 'oldest tool result dropped');
  // Structural validity preserved.
  assertNoOrphanToolMessages(messages);
});

test('compactHistory: repeated compaction does not accumulate elision notes', () => {
  const messages = baseHistory([round('t1', 4000), round('t2', 4000), round('t3', 4000)]);
  compactHistory(messages, { budgetTokens: 300, tokensPerChar: 0.25 });
  // Simulate more turns then compact again.
  messages.push(...round('t4', 4000), ...round('t5', 4000));
  compactHistory(messages, { budgetTokens: 300, tokensPerChar: 0.25 });
  const notes = messages.filter((m) => typeof m.content === 'string' && m.content.startsWith('[context compacted:'));
  assert.equal(notes.length, 1, 'stale note evicted, single fresh note remains');
  assertNoOrphanToolMessages(messages);
});
