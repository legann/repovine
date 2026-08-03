// Child driver for the Telegram live-path test. Runs startTelegram against a
// local Bot API stub, feeds scripted updates, prints observations as JSON, and
// exits — the adapter's poll loop never terminates, so it dies with this
// process instead of hanging the test runner.
//
//   node telegram-live-driver.mjs <repoRoot> <sandbox|attach>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [repoRoot, mode] = process.argv.slice(2);

const sent = [];
let gotFileDownload = false;
const updateQueue = [
  [{ update_id: 1, message: { chat: { id: 1 }, from: { id: 1 }, text: '/reset' } }],
  [{ update_id: 2, message: { chat: { id: 1 }, from: { id: 1 }, text: 'confirm' } }],
  // Regression: /ask bypasses graph intake, but must still lazily re-seed the
  // sandbox that /reset emptied. The unsupported provider makes the ask finish
  // deterministically without launching or spending on a real model.
  [{ update_id: 3, message: { chat: { id: 1 }, from: { id: 1 }, text: '/ask inspect the reset workspace' } }],
  [{ update_id: 4, message: { chat: { id: 1 }, from: { id: 1 }, caption: '/task use the photo', photo: [{ file_id: 'F1' }] } }],
];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = (obj) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    if (req.url.includes('/file/bot')) {
      gotFileDownload = true;
      res.end('JPEGBYTES');
      return;
    }
    if (req.url.endsWith('/getMe')) return reply({ ok: true, result: { username: 'stub' } });
    if (req.url.endsWith('/getUpdates')) return reply({ ok: true, result: updateQueue.shift() ?? [] });
    if (req.url.endsWith('/sendMessage')) {
      sent.push(JSON.parse(body));
      return reply({ ok: true, result: {} });
    }
    if (req.url.endsWith('/getFile')) return reply({ ok: true, result: { file_path: 'photos/p.jpg' } });
    if (req.url.endsWith('/answerCallbackQuery')) return reply({ ok: true });
    return reply({ ok: true, result: [] });
  });
});

server.listen(0, '127.0.0.1', async () => {
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${server.address().port}`;
  const { startTelegram } = await import('../../lib/channels/telegram-adapter.mjs');
  const graph = {
    invoke: async () => ({ mode: 'single', ok: true, result: { status: 'complete' }, replyText: 'done' }),
  };
  startTelegram({
    graph,
    token: 'T',
    allowedIds: ['1'],
    provider: 'unsupported-test-provider',
    repoRoot,
    target: { mode, repoRoot },
  }).catch((e) => {
    console.error(`startTelegram failed: ${e.message}`);
    process.exit(3);
  });

  const deadline = Date.now() + 10_000;
  const settle = setInterval(() => {
    // Done when every scripted update produced its replies (photo task sends the
    // start announcement + the graph reply) or the deadline passes.
    const complete = sent.length >= 6 && gotFileDownload;
    if (!complete && Date.now() < deadline) return;
    clearInterval(settle);
    const attachmentsDir = path.join(repoRoot, '.harness', 'attachments', 'task');
    const attachmentFiles = fs.existsSync(attachmentsDir) ? fs.readdirSync(attachmentsDir) : [];
    console.log(JSON.stringify({
      sent: sent.map((s) => ({ text: s.text, hasKeyboard: Boolean(s.reply_markup) })),
      gotFileDownload,
      attachmentFiles,
      legacyAttachmentsDirExists: fs.existsSync(path.join(repoRoot, '.attachments')),
      rootEntries: fs.readdirSync(repoRoot).sort(),
    }));
    process.exit(0);
  }, 100);
});
