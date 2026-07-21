import { jest } from '@jest/globals';
import type { SpiedFunction } from 'jest-mock';
import { stripAnsi } from '../../src/cli/ui.js';

export type StdoutWriteSpy = SpiedFunction<typeof process.stdout.write>;

export function spyStdoutWrite(): StdoutWriteSpy {
  return jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
}

export function capturedStdoutText(spy: StdoutWriteSpy): string {
  return spy.mock.calls.map((call) => String(call[0] ?? '')).join('');
}

export function capturedStdoutHuman(spy: StdoutWriteSpy): string {
  return stripAnsi(capturedStdoutText(spy));
}

export function lastStdoutJson<T = unknown>(spy: StdoutWriteSpy): T {
  const calls = spy.mock.calls;
  return JSON.parse(String(calls[calls.length - 1]?.[0] ?? '')) as T;
}
