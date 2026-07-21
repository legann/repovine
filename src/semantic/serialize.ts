export type Limiter = <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

function abortError(signal: AbortSignal): Error {
  const reason = (signal as { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new Error('aborted');
}

/**
 * Bounded-concurrency limiter: at most `maxConcurrency` tasks run at once; the rest queue FIFO and
 * start as slots free. Admission control for resources that have no other cap — concurrent MCP
 * requests would otherwise each spin up unbounded inference or worker threads. A rejecting task
 * frees its slot and surfaces its rejection to its own caller only.
 *
 * A task may pass an `AbortSignal`: a caller cancelled while still queued leaves the line immediately
 * (the returned promise rejects) instead of waiting for admission just to bail. A slot the queued task
 * never occupied stays uncounted, so an aborted waiter cannot leak concurrency.
 */
export function createLimiter(maxConcurrency: number): Limiter {
  const max = Math.max(1, Math.floor(maxConcurrency));
  let active = 0;
  const waiters: Array<() => void> = [];
  const release = (): void => {
    active--;
    const next = waiters.shift();
    if (next) { active++; next(); }
  };
  return async <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    // Pre-aborted: reject before running the task, whether or not a slot is free.
    if (signal?.aborted) throw abortError(signal);
    if (active >= max) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(abortError(signal)); return; }
        const admit = (): void => { cleanup(); resolve(); };
        const onAbort = (): void => {
          const idx = waiters.indexOf(admit);
          if (idx >= 0) waiters.splice(idx, 1); // relinquish the queue place; it was never active-counted
          cleanup();
          reject(abortError(signal!));
        };
        const cleanup = (): void => { if (signal) signal.removeEventListener('abort', onAbort); };
        waiters.push(admit);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } else {
      active++;
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/**
 * Concurrency limiter of 1: async tasks run one at a time in submission order. Bounds peak inference
 * cost — concurrent embed calls (one per in-flight search_context) would otherwise run parallel
 * ONNX inference, and CPU-bound inference only contends when overlapped.
 */
export function createSerializer(): Limiter {
  return createLimiter(1);
}
