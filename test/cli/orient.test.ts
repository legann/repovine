import { describe, expect, it } from '@jest/globals';
import { normalizeOrientQuery } from '../../src/cli/orient.js';

describe('normalizeOrientQuery', () => {
  it('strips harness prior-run preamble', () => {
    const raw = [
      '## Prior harness run (compact)',
      'repovine annotations + sandbox code are the durable source of truth.',
      '',
      'Direct chat: typing indicator.',
      'Throttle ~300ms.',
    ].join('\n');
    expect(normalizeOrientQuery(raw)).toBe('Direct chat: typing indicator.\nThrottle ~300ms.');
  });

  it('passes through short user queries', () => {
    expect(normalizeOrientQuery('Direct chat: typing indicator')).toBe('Direct chat: typing indicator');
  });

  it('trims an overly long blob to its last paragraph, with no demo-topic bias', () => {
    const blob = [
      'x'.repeat(850),
      'direct chat typing sse unread badge indicator', // a demo-topic paragraph
      'the actual task paragraph',
    ].join('\n\n');
    // The removed fallback used to prefer the chat-demo paragraph; it must now take the last one.
    expect(normalizeOrientQuery(blob)).toBe('the actual task paragraph');
  });
});
