import { describe, expect, it } from '@jest/globals';
import { serializeKeyedRecordFile } from '../../../src/fs/keyed-json.js';

describe('serializeKeyedRecordFile', () => {
  it('writes one line per entry with sorted keys (carrier-review shape)', () => {
    const out = serializeKeyedRecordFile({ version: 1 }, 'reviewedTargets', {
      'mod:B': { riskHash: 'bbbb', decidedAt: '2026-01-02T00:00:00.000Z' },
      'mod:A': { riskHash: 'aaaa', decidedAt: '2026-01-01T00:00:00.000Z', reason: 'hub' },
    });
    expect(out).toBe(
      [
        '{',
        '  "version": 1,',
        '  "reviewedTargets": {',
        '    "mod:A": {"riskHash":"aaaa","decidedAt":"2026-01-01T00:00:00.000Z","reason":"hub"},',
        '    "mod:B": {"riskHash":"bbbb","decidedAt":"2026-01-02T00:00:00.000Z"}',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('keeps multiple header scalars and array values on one line (boundary-index shape)', () => {
    const out = serializeKeyedRecordFile(
      { version: 1, builtAt: '2026-06-29T00:00:00.000Z' },
      'entries',
      { 'src/x.ts': [{ nodeId: 'mod:x', label: 'x', risks: ['frozen'] }] },
    );
    expect(out).toBe(
      [
        '{',
        '  "version": 1,',
        '  "builtAt": "2026-06-29T00:00:00.000Z",',
        '  "entries": {',
        '    "src/x.ts": [{"nodeId":"mod:x","label":"x","risks":["frozen"]}]',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('renders an empty map inline and stays JSON.parse round-trippable', () => {
    const out = serializeKeyedRecordFile({ version: 1 }, 'reviewedTargets', {});
    expect(out).toBe('{\n  "version": 1,\n  "reviewedTargets": {}\n}\n');
    expect(JSON.parse(out)).toEqual({ version: 1, reviewedTargets: {} });
  });

  it('ends with exactly one trailing newline', () => {
    const out = serializeKeyedRecordFile({ version: 1 }, 'entries', { a: 1 });
    expect(out.endsWith('}\n')).toBe(true);
    expect(out.endsWith('}\n\n')).toBe(false);
  });

  // Cross-platform: LF-only, byte-identical on every OS. The repo enforces eol=lf
  // (.gitattributes) so these bytes stay stable across platforms; os.EOL would emit CRLF
  // on Windows and break the byte-identical-output contract.
  it('emits LF newlines only, never CRLF', () => {
    const out = serializeKeyedRecordFile({ version: 1, builtAt: 'x' }, 'entries', { b: 1, a: 2 });
    expect(out).not.toContain('\r');
    expect(out.split('\n').length).toBeGreaterThan(4);
  });

  it('orders keys by UTF-16 code unit, independent of locale or insertion order', () => {
    const forward = serializeKeyedRecordFile({ version: 1 }, 'm', { z: 1, a: 2, M: 3 });
    const shuffled = serializeKeyedRecordFile({ version: 1 }, 'm', { M: 3, a: 2, z: 1 });
    expect(forward).toBe(shuffled);
    // 'M' (0x4D) precedes 'a' (0x61): default sort, not a case-folding localeCompare.
    expect(Object.keys(JSON.parse(forward).m)).toEqual(['M', 'a', 'z']);
  });
});
