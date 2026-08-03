// Read-only /ask — agent with repovine MCP + file reads (same stack as /task, no protocol).
import { resolveProvider, isSupportedProvider } from './workers/index.mjs';

/** Telegram sendMessage text limit is 4096; stay under for safety. */
export const TELEGRAM_TEXT_MAX = 4000;

function findTelegramSplitPoint(text, max) {
  const window = text.slice(0, max);
  let idx = window.lastIndexOf('\n\n');
  if (idx >= max * 0.4) return idx + 2;
  idx = window.lastIndexOf('\n');
  if (idx >= max * 0.4) return idx + 1;
  idx = window.lastIndexOf(' ');
  if (idx >= max * 0.3) return idx + 1;
  return max;
}

/** Split long prose into Telegram-sized chunks (prefer paragraph / line / word breaks). */
export function splitForTelegram(text, max = TELEGRAM_TEXT_MAX) {
  const s = String(text ?? '').trim();
  if (!s) return [''];
  if (s.length <= max) return [s];

  const chunks = [];
  let rest = s;
  while (rest.length > 0) {
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }
    const cut = findTelegramSplitPoint(rest, max);
    const piece = rest.slice(0, cut).trimEnd();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut).trimStart();
    if (!rest && !piece) break;
  }
  return chunks.length ? chunks : [''];
}

async function getAskRunner(provider) {
  switch (provider) {
    case 'local':
      return import('./workers/ask-local.mjs');
    case 'claude':
    default:
      return import('./workers/ask-claude.mjs');
  }
}

/**
 * Answer a read-only question using the configured LLM agent (MCP + read tools).
 * @returns {Promise<{ ok: true, text: string, contextSessionId?: string } | { ok: false, reason: string }>}
 */
export async function runAsk(question, repoRoot, provider, opts = {}) {
  const q = String(question ?? '').trim();
  if (!q) return { ok: false, reason: 'empty question' };

  const p = resolveProvider(provider);
  if (!isSupportedProvider(p)) {
    return { ok: false, reason: `unsupported LLM_PROVIDER "${p}" for /ask` };
  }

  const capture = opts.capture ?? {};
  const contextSessionId = opts.contextSessionId || `ctx-ask-${Date.now()}`;
  const runner = await getAskRunner(p);
  const result = await runner.runAsk(q, repoRoot, { ...opts, contextSessionId, capture });
  if (result.ok && capture.sessionId) result.sessionId = capture.sessionId;
  return result;
}
