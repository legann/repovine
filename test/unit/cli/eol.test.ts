import { describe, it, expect } from '@jest/globals';
import { detectEol, isUniformEol, normalizeEol, applyEol } from '../../../src/cli/eol.js';

describe('detectEol', () => {
  it('returns \\n for LF-only content', () => {
    expect(detectEol('a\nb\nc\n')).toBe('\n');
  });

  it('returns \\r\\n for CRLF-only content', () => {
    expect(detectEol('a\r\nb\r\nc\r\n')).toBe('\r\n');
  });

  it('returns the majority EOL of mixed content', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(detectEol('a\nb\nc\r\n')).toBe('\n');
  });

  it('defaults to \\n for empty or newline-free content', () => {
    expect(detectEol('')).toBe('\n');
    expect(detectEol('no newline')).toBe('\n');
  });

  it('treats an even split as LF', () => {
    expect(detectEol('a\r\nb\n')).toBe('\n');
  });
});

describe('isUniformEol', () => {
  it('is true for LF-only content', () => {
    expect(isUniformEol('a\nb\nc\n')).toBe(true);
  });

  it('is true for CRLF-only content', () => {
    expect(isUniformEol('a\r\nb\r\nc\r\n')).toBe(true);
  });

  it('is false for mixed content', () => {
    expect(isUniformEol('a\r\nb\nc\r\n')).toBe(false);
    expect(isUniformEol('a\nb\r\n')).toBe(false);
  });

  it('is true for empty content', () => {
    expect(isUniformEol('')).toBe(true);
  });

  it('is true for newline-free content', () => {
    expect(isUniformEol('no newline')).toBe(true);
  });
});

describe('normalizeEol', () => {
  it('converts CRLF to LF', () => {
    expect(normalizeEol('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('leaves LF content unchanged', () => {
    expect(normalizeEol('a\nb\n')).toBe('a\nb\n');
  });
});

describe('applyEol', () => {
  it('is identity on LF input with \\n', () => {
    expect(applyEol('a\nb\n', '\n')).toBe('a\nb\n');
  });

  it('converts LF to CRLF', () => {
    expect(applyEol('a\nb\n', '\r\n')).toBe('a\r\nb\r\n');
  });

  it('normalizes first, so CRLF input never double-converts', () => {
    expect(applyEol('a\r\nb\r\n', '\r\n')).toBe('a\r\nb\r\n');
    expect(applyEol('a\r\nb\r\n', '\n')).toBe('a\nb\n');
  });

  it('round-trips mixed input to a single EOL', () => {
    expect(applyEol('a\r\nb\nc\r\n', '\r\n')).toBe('a\r\nb\r\nc\r\n');
  });
});
