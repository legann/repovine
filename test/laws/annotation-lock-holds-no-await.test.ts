import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import ts from 'typescript';
import {
  AnnotationLockAsyncTransactionError,
  LOCK_MAX_WAIT_MS,
  LOCK_STALE_MS,
  lockPathForAnnotationFile,
  withAnnotationFileLockAsync,
  withAnnotationFileLockSync,
} from '../../src/annotations/file-lock.js';
import { repoRoot, sourceFiles } from './graph-law-helpers.js';

/**
 * Law: a locked annotation transaction never suspends.
 *
 * The annotation lock is a file, which makes it a *cross-process* mechanism. Inside one process it
 * offers none of what a mutex would: there is no queue, no fairness, and the staleness takeover is
 * structurally unable to fire — the pid in the lock file is this process's own, and it is alive. The
 * only outcome of same-process contention is the wait deadline.
 *
 * So the holder must never be suspendable. It used to be: both transactions held the lock across an
 * `await` (`writeFileAtomic`, `readFile`). While a holder is parked, nothing in this process can
 * release its lock, so anything that blocks or starves the event loop turns a millisecond of disk IO
 * into a lock held past the deadline — which is how this surfaced, as an intermittent 15s timeout in
 * `context-refresh` under a loaded run.
 *
 * Acquisition stays async — a waiter must yield rather than block — but each *attempt* is one
 * synchronous `writeFileSync`. That half is a correctness fix, not a latency one: an acquirer that
 * was starved between the open and the write left the lock file existing and empty, and an empty file
 * names no owner, so the reclaim path read it as a dead owner and stole a held lock.
 */

const LOCK_HELPERS = new Set(['withAnnotationFileLockSync', 'withAnnotationFileLockAsync']);

interface Offender {
  readonly where: string;
  readonly detail: string;
}

/**
 * Every call to a lock helper whose transaction argument can suspend.
 *
 * Read through the parser rather than by text: what matters is whether the callback is `async` or
 * contains an `await`, and both are node kinds rather than spellings.
 */
function suspendingTransactions(root: string): Offender[] {
  const offenders: Offender[] = [];
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const where = path.relative(root, file).split(path.sep).join('/');

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && LOCK_HELPERS.has(node.expression.text)
      ) {
        const callback = node.arguments[1];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          const { line } = source.getLineAndCharacterOfPosition(callback.getStart(source));
          const isAsync = callback.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
          if (isAsync) {
            offenders.push({ where: `${where}:${line + 1}`, detail: 'transaction is async' });
          }
          // An `await` anywhere in the body, including one nested in a block or loop. Nested
          // function bodies are skipped: their awaits belong to a different call.
          const findAwait = (inner: ts.Node): void => {
            if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner) || ts.isFunctionDeclaration(inner)) {
              if (inner !== callback) return;
            }
            if (ts.isAwaitExpression(inner)) {
              const at = source.getLineAndCharacterOfPosition(inner.getStart(source));
              offenders.push({ where: `${where}:${at.line + 1}`, detail: 'transaction awaits' });
            }
            ts.forEachChild(inner, findAwait);
          };
          ts.forEachChild(callback, findAwait);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return offenders;
}

describe('core-laws a locked annotation transaction never suspends', () => {
  it('finds the lock call sites, so the sweep is not over nothing', () => {
    // Positive control: this law is a scan, and a scan that matches no call site is green by default.
    let callSites = 0;
    for (const file of sourceFiles(path.join(repoRoot(), 'src'))) {
      const source = ts.createSourceFile(
        file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true,
      );
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && LOCK_HELPERS.has(node.expression.text)
        ) callSites += 1;
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(callSites).toBeGreaterThanOrEqual(5);
  });

  it('holds the lock across no suspension point in the engine', () => {
    expect(suspendingTransactions(repoRoot()).map(o => `${o.where}: ${o.detail}`).sort()).toEqual([]);
  });

  it('turns red on an async transaction and on an awaited one (kill mutation)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-await-law-'));
    try {
      const dir = path.join(tmpRoot, 'src', 'annotations');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '__kill_async.ts'), [
        'export async function save(): Promise<void> {',
        '  await withAnnotationFileLockAsync(file, async () => {',
        '    await write();',
        '  });',
        '}',
      ].join('\n'));

      const found = suspendingTransactions(tmpRoot).map(o => o.detail).sort();
      // Both forms are reported, and each on its own reason: a single count would go green if one
      // form started answering with the other's verdict.
      expect(found).toEqual(['transaction awaits', 'transaction is async']);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('makes an acquisition attempt out of synchronous calls only', () => {
    // The other half of the invariant, and a correctness one rather than a latency one. Acquiring used
    // to be `await fsPromises.writeFile(lock, pid, 'wx')` — an open and a write with an event-loop turn
    // between them. An acquirer starved in that gap left the lock file existing and EMPTY, and an empty
    // file names no owner, so the reclaim path read it as a dead owner and took a lock that was held.
    // Measured: a waiter reclaimed a live lock after exactly the staleness window.
    //
    // Asserted at the source, because the damage needs a second process to witness: two synchronous
    // writes in a row are indistinguishable from one inside this process, so no in-process test can
    // tell them apart. What is checkable is that the attempt never suspends.
    const file = path.join(repoRoot(), 'src', 'annotations', 'file-lock.ts');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);

    const awaited: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(node)
        && node.name
        && ['attemptAcquire', 'acquireLockSync'].includes(node.name.text)
      ) {
        const fnName = node.name.text;
        const findAwait = (inner: ts.Node): void => {
          if (ts.isAwaitExpression(inner)) {
            // The retry sleep is the one permitted suspension: a waiter must yield rather than block.
            const isTimerSleep = ts.isNewExpression(inner.expression)
              && ts.isIdentifier(inner.expression.expression)
              && inner.expression.expression.text === 'Promise';
            if (!isTimerSleep) awaited.push(`${fnName}: ${inner.expression.getText(source).slice(0, 60)}`);
          }
          ts.forEachChild(inner, findAwait);
        };
        ts.forEachChild(node, findAwait);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(awaited.sort()).toEqual([]);
    // Positive control: the file really does declare the functions this checked.
    expect(source.text).toContain('function attemptAcquire(');
    expect(source.text).toContain('function acquireLockSync(');

    // And the async wrapper holds no `await` between taking the lock and releasing it. There is no
    // separate `acquireLockAsync` to check any more, and that is the fix: it existed only to be
    // awaited, and awaiting it yielded a microtask with the lock already taken. The loop is inlined
    // so the acquired branch reaches the transaction and the release with no suspension point.
    expect(source.text).not.toContain('function acquireLockAsync');

    // Asked of the AST, not of a text slice: the retry sleep sits in the same function a few lines
    // below, and any substring cut wide enough to include the transaction also includes that sleep.
    const holdRegions: ts.TryStatement[] = [];
    const collect = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'assertSyncResult'
      ) {
        // The lock is held exactly across the `try` whose `finally` releases it, so that statement is
        // the hold. Everything suspendable inside it would be suspending while holding.
        const owner = ts.findAncestor(node, ts.isTryStatement);
        if (owner) holdRegions.push(owner);
      }
      ts.forEachChild(node, collect);
    };
    const asyncWrapper = source.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === 'withAnnotationFileLockAsync',
    );
    expect(asyncWrapper).toBeDefined();
    collect(asyncWrapper!);
    // Non-vacuity: the transaction really was found, so the sweep below runs over something.
    expect(holdRegions).toHaveLength(1);

    const suspendedWhileHolding: string[] = [];
    const findAwait = (node: ts.Node): void => {
      if (ts.isAwaitExpression(node)) suspendedWhileHolding.push(node.getText(source).slice(0, 60));
      ts.forEachChild(node, findAwait);
    };
    findAwait(holdRegions[0]!);
    expect(suspendedWhileHolding).toEqual([]);

    // And the waiter still yields rather than blocking — the one permitted suspension, outside the hold.
    expect(source.text).toContain('await new Promise');
  });

  it('keeps the wait deadline longer than the staleness window', () => {
    // The ordering the takeover depends on. Named here because this law and that one are the two
    // halves of the same failure mode.
    expect(LOCK_MAX_WAIT_MS).toBeGreaterThan(LOCK_STALE_MS);
  });
});

describe('core-laws annotation lock contention', () => {
  function tempAnnotationFile(): { dir: string; file: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-behaviour-'));
    const file = path.join(dir, 'repovine.annots.json');
    fs.writeFileSync(file, '{}');
    return { dir, file };
  }

  it('serializes two async transactions without either stalling', async () => {
    // The shape that actually failed in the suite: both sides async. Neither blocks the event loop,
    // so the holder runs to completion and releases, and the waiter takes the lock on a later turn.
    // Before the transactions were made non-suspending, the holder was parked inside `writeFileAtomic`
    // and a loaded event loop could keep it there past the wait deadline.
    const { dir, file } = tempAnnotationFile();
    try {
      const order: string[] = [];
      const started = Date.now();
      const first = withAnnotationFileLockAsync(file, () => {
        order.push('first');
        fs.writeFileSync(file, '{"first":true}');
        return 1;
      });
      const second = withAnnotationFileLockAsync(file, () => {
        order.push('second');
        return fs.readFileSync(file, 'utf8');
      });

      expect(await first).toBe(1);
      expect(await second).toBe('{"first":true}');
      // Serialized, and the reader saw the writer's bytes — mutual exclusion held.
      expect(order).toEqual(['first', 'second']);
      // Well under the staleness window: a regression shows up as a slow test, not a wrong value.
      expect(Date.now() - started).toBeLessThan(LOCK_STALE_MS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never leaves a lock file without an owner pid in it', async () => {
    // The correctness half of making acquisition one syscall. Acquiring used to be an open followed
    // by a write with an event-loop turn between them, so an acquirer that got starved left the lock
    // file existing and EMPTY. A waiter then read no pid out of it, concluded the owner was dead, and
    // reclaimed a lock that was still held — two holders at once. One `writeFileSync` cannot produce
    // that state.
    const { dir, file } = tempAnnotationFile();
    const lockPath = lockPathForAnnotationFile(file);
    try {
      const contents: string[] = [];
      await withAnnotationFileLockAsync(file, () => {
        contents.push(fs.readFileSync(lockPath, 'utf8'));
        return 0;
      });
      expect(contents).toEqual([String(process.pid)]);
      // Released on the way out.
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a promise-returning transaction instead of unlocking early', async () => {
    // Neither wrapper awaits the transaction, so a promise-returning callback would have the lock
    // released while its work continued — mutual exclusion silently gone. That must fail loudly.
    const { dir, file } = tempAnnotationFile();
    try {
      expect(() => withAnnotationFileLockSync(file, () => Promise.resolve('nope')))
        .toThrow(AnnotationLockAsyncTransactionError);
      await expect(withAnnotationFileLockAsync(file, () => Promise.resolve('nope')))
        .rejects.toThrow(AnnotationLockAsyncTransactionError);

      // The lock is released on the way out, so the file is usable afterwards.
      expect(withAnnotationFileLockSync(file, () => 'recovered')).toBe('recovered');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a sync caller through in the window right after an async transaction starts', async () => {
    // This case was once a comment saying the opposite: that a sync waiter cannot wait out an async
    // holder, that it is a property of the runtime, and that closing it needs an in-process mutex.
    // The premise was wrong. The holder needed the thread only because `await acquireLockAsync(…)`
    // put a microtask boundary between taking the lock and running the transaction; with the loop
    // inlined there is no such window, so there is nothing for a sync caller to be starved by.
    //
    // Asserted behaviourally at exactly that boundary. Calling the async wrapper runs its acquisition
    // synchronously, so the moment it returns is the instant the old code held the lock and had run
    // nothing. A sync acquirer is issued right there, on the same turn, before anything is awaited.
    const { dir, file } = tempAnnotationFile();
    try {
      let transactionRan = false;
      const held = withAnnotationFileLockAsync(file, () => { transactionRan = true; });
      // Uncontended, the whole transaction is already done: the wrapper never yielded while holding.
      expect(transactionRan).toBe(true);
      expect(fs.existsSync(`${file}.lock`)).toBe(false);

      const started = Date.now();
      withAnnotationFileLockSync(file, () => {});
      // A stall here is the defect: the previous shape timed out at the full LOCK_MAX_WAIT_MS.
      expect(Date.now() - started).toBeLessThan(LOCK_MAX_WAIT_MS / 3);
      await held;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still refuses a sync flush while an async save is in flight', () => {
    // The store-level guard stays: it is about a save that has genuinely suspended between its own
    // steps, which is a different question from the lock's own window.
    const storeSource = fs.readFileSync(path.join(repoRoot(), 'src', 'annotations', 'store.ts'), 'utf8');
    expect(storeSource).toContain('Cannot sync-flush annotations while an async save is in flight');
  });
});
