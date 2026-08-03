import { asHostPath } from '@repovine/plugin-sdk';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

// On failure/overflow the child must be SIGKILLed (uncatchable), not sent a plain SIGTERM a Python
// process can ignore — otherwise it survives the reject with the backstop timer already cleared.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { end: (): void => {} });
  exitCode: number | null = null;
  signalCode: string | null = null;
  killSignal: string | undefined;
  kill(sig?: string): boolean { this.killSignal = sig; return true; }
}

describe('runPythonAst subprocess teardown', () => {
  afterEach(() => {
    jest.unstable_unmockModule('node:child_process');
    jest.resetModules();
  });

  it('SIGKILLs the child on failure rather than a catchable SIGTERM', async () => {
    jest.resetModules();
    const fake = new FakeChild();
    jest.unstable_mockModule('node:child_process', () => ({ spawn: () => fake }));
    const { runPythonAst } = await import('../../../../packages/plugins/source-python/src/extract.js');

    const p = runPythonAst('python3', 'script', [asHostPath('/a.py')]);
    fake.emit('error', new Error('boom')); // subprocess failure → fail() teardown path

    await expect(p).rejects.toThrow('boom');
    expect(fake.killSignal).toBe('SIGKILL');
  });
});
