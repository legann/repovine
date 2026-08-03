import { describe, expect, it } from '@jest/globals';
import {
  abortMcpBuilds,
  createShutdownSequence,
  type ShutdownDeps,
} from '../../../src/mcp/shutdown.js';

// The shutdown ORDER is the contract — admission closes, every active build kind aborts (pools
// destroy, worker isolates reap python children) BEFORE the tool-call drain, the inline plugin
// fallback and annotation drain run after, and a hard-exit backstop bounds a hung phase.

interface Recorded {
  events: string[];
  exitCodes: number[];
}

function makeDeps(rec: Recorded, overrides: Partial<ShutdownDeps> = {}): ShutdownDeps {
  return {
    closeAdmission: () => rec.events.push('closeAdmission'),
    abortActiveBuilds: async () => { rec.events.push('abortActiveBuilds'); },
    inFlightToolCalls: () => { rec.events.push('inFlightPoll'); return 0; },
    terminateInlinePluginChildren: async () => { rec.events.push('terminateInline'); },
    drainAnnotations: async () => { rec.events.push('drainAnnotations'); },
    afterFlushHooks: [async () => { rec.events.push('afterFlush'); }],
    closeTransport: async () => { rec.events.push('closeTransport'); },
    exit: code => { rec.events.push(`exit:${code}`); rec.exitCodes.push(code); },
    log: () => undefined,
    logError: msg => rec.events.push(`err:${msg.trim().slice(0, 30)}`),
    deadlineMs: 1_000,
    buildAbortGraceMs: 200,
    cleanupTailMs: 200,
    ...overrides,
  };
}

describe('createShutdownSequence', () => {
  it('runs the phases in order: admission → build aborts → tool drain → inline teardown → annotation drain → hooks → transport → exit', async () => {
    const rec: Recorded = { events: [], exitCodes: [] };
    const shutdown = createShutdownSequence(makeDeps(rec));

    await shutdown('test');

    const order = (name: string): number => rec.events.indexOf(name);
    expect(order('closeAdmission')).toBe(0);
    // Builds abort BEFORE the tool-call drain poll: an aborted refresh unblocks its own tool call,
    // so the drain below can finish; the reverse order deadlocks until the deadline.
    expect(order('abortActiveBuilds')).toBeLessThan(order('inFlightPoll'));
    expect(order('inFlightPoll')).toBeLessThan(order('terminateInline'));
    expect(order('terminateInline')).toBeLessThan(order('drainAnnotations'));
    expect(order('drainAnnotations')).toBeLessThan(order('afterFlush'));
    expect(order('afterFlush')).toBeLessThan(order('closeTransport'));
    expect(rec.exitCodes).toEqual([0]);
  });

  it('waits for in-flight tool calls to finish before draining the store', async () => {
    const rec: Recorded = { events: [], exitCodes: [] };
    let inFlight = 2;
    setTimeout(() => { inFlight = 0; }, 80);
    const shutdown = createShutdownSequence(makeDeps(rec, {
      inFlightToolCalls: () => { rec.events.push(`inFlight:${inFlight}`); return inFlight; },
    }));

    await shutdown('test');

    // The drain loop polled while calls were still in flight, and drainAnnotations ran only after zero.
    expect(rec.events.filter(e => e === 'inFlight:2').length).toBeGreaterThan(0);
    expect(rec.events.indexOf('drainAnnotations')).toBeGreaterThan(rec.events.lastIndexOf('inFlight:2'));
    expect(rec.exitCodes).toEqual([0]);
  });

  it('a hung build abort is bounded by the grace budget — the annotation drain still runs', async () => {
    const rec: Recorded = { events: [], exitCodes: [] };
    const shutdown = createShutdownSequence(makeDeps(rec, {
      abortActiveBuilds: () => new Promise<void>(() => undefined), // never settles
      buildAbortGraceMs: 50,
    }));

    const t0 = Date.now();
    await shutdown('test');

    expect(rec.events).toContain('drainAnnotations'); // reserved grace left room for the drain
    expect(Date.now() - t0).toBeLessThan(900); // did not eat the whole deadline waiting on the abort
    expect(rec.exitCodes).toEqual([0]);
  });

  it('reserves a cleanup tail when both build abort and an in-flight tool call are hung', async () => {
    const rec: Recorded = { events: [], exitCodes: [] };
    const shutdown = createShutdownSequence(makeDeps(rec, {
      abortActiveBuilds: () => new Promise<void>(() => undefined), // never settles
      inFlightToolCalls: () => { rec.events.push('inFlight:1'); return 1; }, // never drains
      deadlineMs: 400,
      buildAbortGraceMs: 50,
      cleanupTailMs: 200,
    }));

    await shutdown('test');

    expect(rec.events).toContain('inFlight:1');
    expect(rec.events.indexOf('drainAnnotations')).toBeLessThan(rec.events.indexOf('exit:0'));
    // The normal terminal exit wins and clears the deadline backstop. Without the reserved tail,
    // the backstop fires first and the sequence later attempts a second exit after draining.
    expect(rec.exitCodes).toEqual([0]);
  });

  it('the hard-exit backstop fires when a phase hangs past the deadline', async () => {
    const rec: Recorded = { events: [], exitCodes: [] };
    const shutdown = createShutdownSequence(makeDeps(rec, {
      drainAnnotations: () => new Promise<void>(() => undefined), // hangs forever
      deadlineMs: 120,
      buildAbortGraceMs: 20,
      cleanupTailMs: 40,
    }));

    void shutdown('test'); // intentionally not awaited — it never resolves
    await new Promise(r => setTimeout(r, 300));

    expect(rec.exitCodes).toEqual([0]); // backstop exit
    expect(rec.events.some(e => e.startsWith('err:'))).toBe(true); // deadline breach logged
  });

  it('is idempotent — a second invocation does not rerun the sequence', async () => {
    const rec: Recorded = { events: [], exitCodes: [] };
    const shutdown = createShutdownSequence(makeDeps(rec));

    await Promise.all([shutdown('first'), shutdown('second')]);

    expect(rec.events.filter(e => e === 'closeAdmission')).toHaveLength(1);
    expect(rec.exitCodes).toEqual([0]);
  });
});

describe('abortMcpBuilds live-owner adapter', () => {
  it('starts startup, ready-runtime refresh, and reloadConfig cancellation independently', async () => {
    const events: string[] = [];
    let releaseStartup: (() => void) | undefined;
    const startup = new Promise<void>(resolve => { releaseStartup = resolve; });
    const aborts = abortMcpBuilds({
      abortStartup: () => { events.push('startup'); return startup; },
      abortRefresh: async () => { events.push('refresh'); },
      abortReloadConfig: async () => { events.push('reloadConfig'); },
      logError: message => events.push(message),
    });

    // The hung startup owner must not serialize/block cancellation of the two ready-runtime owners.
    await Promise.resolve();
    expect(events).toEqual(['startup', 'refresh', 'reloadConfig']);
    releaseStartup!();
    await aborts;
  });

  it('contains one owner failure and still waits for the other owners', async () => {
    const events: string[] = [];
    await abortMcpBuilds({
      abortStartup: async () => { throw new Error('startup failed'); },
      abortRefresh: async () => { events.push('refresh'); },
      abortReloadConfig: async () => { events.push('reloadConfig'); },
      logError: message => events.push(message),
    });

    expect(events).toContain('refresh');
    expect(events).toContain('reloadConfig');
    expect(events.some(event => event.includes('startup build abort error: startup failed'))).toBe(true);
  });
});
