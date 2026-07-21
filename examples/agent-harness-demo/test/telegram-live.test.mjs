// Telegram live path over a stubbed Bot API, run in a CHILD process (the poll
// loop never exits; it dies with the child). Proves the real message path — not
// just the pure helpers: attach /reset refuses without arming the confirmation
// flow, sandbox /reset arms and wipes, and photo attachments land under
// .harness/attachments (never a workspace-root .attachments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ATTACHMENTS_ROOT } from '../lib/channels/telegram-adapter.mjs';
import { makeAttachWorkspace } from './fixtures/attach-workspace.mjs';

const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'telegram-live-driver.mjs');

function runDriver(mode) {
  // Attach gets the Phase 2 workspace shape (pointer + disposable repo with the
  // baseline tag) and starts DIRTY — the /reset flow must restore the baseline.
  let repoRoot;
  let ws = null;
  if (mode === 'attach') {
    ws = makeAttachWorkspace();
    repoRoot = ws.root;
    fs.writeFileSync(path.join(repoRoot, 'keep.txt'), 'agent-dirty\n');
    fs.writeFileSync(path.join(repoRoot, 'junk.txt'), 'x\n');
  } else {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), `tg-live-${mode}-`));
    fs.writeFileSync(path.join(repoRoot, 'repovine.annots.json'), '{"version":1,"annotations":{"mod:x":{}}}\n');
    fs.writeFileSync(path.join(repoRoot, 'keep.txt'), 'k\n');
  }
  const r = spawnSync('node', [DRIVER, repoRoot, mode], { encoding: 'utf-8', timeout: 30_000 });
  assert.equal(r.status, 0, `driver failed (${mode}): ${r.stderr}\n${r.stdout}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  return {
    repoRoot,
    out,
    cleanup: () => (ws ? ws.cleanup() : fs.rmSync(repoRoot, { recursive: true, force: true })),
  };
}

test('attachments root is the harness-internal location in both modes', () => {
  assert.equal(ATTACHMENTS_ROOT, path.join('.harness', 'attachments'));
});

test('attach live path: /reset arms the keyboard, confirm restores the baseline, photo goes to .harness/attachments', () => {
  const { repoRoot, out, cleanup } = runDriver('attach');
  try {
    assert.ok(out.sent.length >= 4, `expected 4 replies, got ${JSON.stringify(out.sent)}`);
    const [resetReply, confirmReply, taskAnnounce] = out.sent;
    // Phase 2: attach arms the same confirmation flow as sandbox, with
    // baseline wording instead of the wipe warning.
    assert.equal(resetReply.hasKeyboard, true, 'attach arms the confirmation keyboard');
    assert.match(resetReply.text, /launch baseline/);
    assert.match(confirmReply.text, /restored to the launch baseline/);
    assert.match(taskAnnounce.text, /attach mode \(worktree\)/, 'task announcement names attach, not sandbox');

    // The confirm actually restored the baseline through the real message path.
    assert.equal(fs.readFileSync(path.join(repoRoot, 'keep.txt'), 'utf8'), 'baseline\n', 'tracked file restored');
    assert.ok(!fs.existsSync(path.join(repoRoot, 'junk.txt')), 'untracked junk cleaned');
    // The photo landed under external harness runtime, not the workspace tree.
    assert.equal(out.gotFileDownload, true);
    assert.ok(out.attachmentFiles.length >= 1, 'photo saved under .harness/attachments/task');
    assert.equal(out.legacyAttachmentsDirExists, false, 'no workspace-root .attachments');
  } finally {
    cleanup();
  }
});

test('sandbox live path: /reset arms the keyboard and the confirm wipes the workspace', () => {
  const { out, cleanup } = runDriver('sandbox');
  try {
    const [resetReply, confirmReply, taskAnnounce] = out.sent;
    assert.equal(resetReply.hasKeyboard, true, 'sandbox arms the confirmation keyboard');
    assert.match(confirmReply.text, /Reset done/);
    assert.match(taskAnnounce.text, /sandbox mode/, 'sandbox announcement wording unchanged');
    assert.ok(!out.rootEntries.includes('keep.txt'), 'confirm actually wiped the workspace');
  } finally {
    cleanup();
  }
});
