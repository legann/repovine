// Telegram reset decision (Phase 2): both target modes arm the confirmation
// flow — attach reset restores the launch baseline instead of wiping. The
// policy-driven refusal branch stays for any future resetAllowed:false policy.
// Live message-path behavior is covered by test/telegram-live.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { telegramResetPlan } from '../lib/channels/telegram-adapter.mjs';
import { targetPolicy } from '../lib/target-repo.mjs';

test('telegramResetPlan: sandbox and attach both arm the confirmation flow', () => {
  assert.deepEqual(telegramResetPlan(targetPolicy('sandbox')), { action: 'confirm' });
  assert.deepEqual(telegramResetPlan(targetPolicy('attach')), { action: 'confirm' });
});

test('telegramResetPlan: a resetAllowed:false policy refuses deterministically', () => {
  const plan = telegramResetPlan({ resetAllowed: false });
  assert.equal(plan.action, 'refuse');
  assert.match(plan.reply, /host/);
});
