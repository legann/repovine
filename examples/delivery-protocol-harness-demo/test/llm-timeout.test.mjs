import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { askLLM } from '../lib/llm.mjs';

/**
 * Regression: the caller's `timeoutMs` used to be handed to the providers by temporarily
 * overwriting `process.env.PLANNER_TIMEOUT_MS` and restoring it in a `finally`. In an async
 * function `return <promise>` inside try/finally runs the finally as the return completion
 * passes through it — before the returned promise settles. `askLocal` reads its budget
 * synchronously before its first `await`, so it observed the override; `askClaude` suspends at
 * `await import(...)` first, so the restore always won and the caller's budget was silently
 * ignored on the default provider. The budget is now an explicit argument.
 */

function withEnv(vars, fn) {
  const prev = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return (async () => {
    try {
      return await fn();
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  })();
}

test('askLLM: claude path honors the caller timeout, not the env default', async () => {
  // A large env default would keep the run alive for 90s under the old code, because the
  // restore landed before askClaude read the value. A 1ms caller budget must win.
  const result = await withEnv(
    { PLANNER_TIMEOUT_MS: '90000', ANTHROPIC_API_KEY: 'test-key-not-used-before-abort' },
    () => askLLM('plan something', { provider: 'claude', timeoutMs: 1 }),
  );

  assert.equal(result.ok, false, 'a 1ms budget must not produce a successful plan');
  assert.match(
    result.reason,
    /timed out after/,
    `expected the caller budget to abort the run, got: ${result.reason}`,
  );
});

test('llm.mjs: the caller budget never travels through the shared env slot', async () => {
  // The race between concurrent calls with different budgets came from writing one process-wide
  // slot and restoring it. Observing the slot AFTER a call cannot catch that — the old code
  // restored it too. The checkable property is that the write is gone from the source at all.
  const source = await readFile(new URL('../lib/llm.mjs', import.meta.url), 'utf-8');
  const writes = source.match(/process\.env\.PLANNER_TIMEOUT_MS\s*=/g) ?? [];
  const deletes = source.match(/delete\s+process\.env\.PLANNER_TIMEOUT_MS/g) ?? [];

  assert.deepEqual(
    [...writes, ...deletes],
    [],
    'the planner timeout must be threaded as an argument, never assigned to the shared env slot',
  );
  assert.match(source, /PLANNER_TIMEOUT_MS/, 'the env var must still be readable as the default');
});

test('askLLM: an absent caller budget still falls back to the env default', async () => {
  // The env var stays the default source; only the override path changed.
  const result = await withEnv(
    { PLANNER_TIMEOUT_MS: '1', ANTHROPIC_API_KEY: 'test-key-not-used-before-abort' },
    () => askLLM('plan something', { provider: 'claude' }),
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /timed out after/, `expected the env default to apply, got: ${result.reason}`);
});
