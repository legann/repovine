import { describe, it, expect } from '@jest/globals';
import { createSerializer, createLimiter } from '../../../src/semantic/serialize.js';

describe('createSerializer', () => {
  it('runs tasks one at a time in submission order (max concurrency 1)', async () => {
    const serialize = createSerializer();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const task = (n: number): Promise<number> => serialize(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push(n);
      active--;
      return n;
    });

    const results = await Promise.all([task(1), task(2), task(3)]);

    expect(maxActive).toBe(1); // never two inference calls overlapping
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
  });

  it('a rejecting task surfaces to its caller without stalling the chain', async () => {
    const serialize = createSerializer();
    await expect(serialize(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(serialize(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('createLimiter', () => {
  it('caps concurrency at n and drains the queue as slots free', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let maxActive = 0;
    const run = (): Promise<void> => limit(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
    });

    const results = await Promise.all(Array.from({ length: 6 }, run));

    expect(maxActive).toBe(2); // never more than 2 in flight
    expect(results).toHaveLength(6); // all six eventually ran
  });

  it('a rejecting task frees its slot', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    await expect(limit(async () => 42)).resolves.toBe(42);
  });

  it('a caller cancelled while queued leaves the line immediately, not after admission', async () => {
    const limit = createLimiter(1);
    let releaseHolder = (): void => undefined;
    // Occupy the only slot with a task that will not finish until we let it, so the next call queues.
    const held = limit(() => new Promise<void>(resolve => { releaseHolder = resolve; }));

    const ac = new AbortController();
    let queuedTaskRan = false;
    const queued = limit(async () => { queuedTaskRan = true; }, ac.signal);

    ac.abort(); // still queued behind `held`
    // Rejects promptly on the abort — without waiting for `held` to release the slot.
    await expect(queued).rejects.toThrow();
    expect(queuedTaskRan).toBe(false); // never admitted → its task body never ran

    // The aborted waiter relinquished its place without consuming a slot: the limiter still runs later work.
    releaseHolder();
    await held;
    await expect(limit(async () => 'ok')).resolves.toBe('ok');
  });

  it('an already-aborted signal rejects without running the task', async () => {
    const limit = createLimiter(1);
    const blocker = limit(() => new Promise<void>(() => undefined)); // holds the slot forever
    void blocker;
    const ac = new AbortController();
    ac.abort();
    let ran = false;
    await expect(limit(async () => { ran = true; }, ac.signal)).rejects.toThrow();
    expect(ran).toBe(false);
  });
});
