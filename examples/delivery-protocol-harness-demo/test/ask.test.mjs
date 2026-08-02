import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitForTelegram, TELEGRAM_TEXT_MAX } from '../lib/ask.mjs';

test('splitForTelegram: short text stays one chunk', () => {
  assert.deepEqual(splitForTelegram('hello'), ['hello']);
});

test('splitForTelegram: empty text is one empty chunk', () => {
  assert.deepEqual(splitForTelegram(''), ['']);
});

test('splitForTelegram: long text becomes multiple chunks under max', () => {
  const para = 'word '.repeat(200).trim();
  const text = `${para}\n\n${para}\n\n${para}`;
  const parts = splitForTelegram(text, 500);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 500, `chunk too long: ${part.length}`);
  }
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  assert.equal(norm(parts.join(' ')), norm(text));
});

test('splitForTelegram: prefers paragraph breaks', () => {
  const a = 'A'.repeat(100);
  const b = 'B'.repeat(100);
  const text = `${a}\n\n${b}`;
  const parts = splitForTelegram(text, 120);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], a);
  assert.equal(parts[1], b);
});

test('splitForTelegram: default max matches TELEGRAM_TEXT_MAX', () => {
  const text = 'x'.repeat(TELEGRAM_TEXT_MAX + 1);
  const parts = splitForTelegram(text);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= TELEGRAM_TEXT_MAX));
});
