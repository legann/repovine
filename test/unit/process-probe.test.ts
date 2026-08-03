/** process-probe helper: tracked spawn + liveness without external `ps`. */
import { isAlive, listChildProcesses, livePids, onceClosed, spawnTracked } from '../helpers/process-probe.js';

describe('process probe', () => {
  test('tracks a live child and forgets it after close', async () => {
    const child = spawnTracked(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
    });
    expect(typeof child.pid).toBe('number');
    const pid = child.pid as number;

    expect(isAlive(pid)).toBe(true);
    expect(livePids()).toContain(pid);

    child.kill();
    await onceClosed(child);

    expect(livePids()).not.toContain(pid);
    expect(isAlive(pid)).toBe(false);
  });

  test('a child that exits on its own leaves no tracked pid', async () => {
    const child = spawnTracked(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid as number;
    await onceClosed(child);
    expect(livePids()).not.toContain(pid);
  });

  test('listChildProcesses sees a live direct child and forgets it after close', async () => {
    const child = spawnTracked(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid as number;

    const seen = listChildProcesses(process.pid).find((c) => c.pid === pid);
    expect(seen).toBeDefined();
    expect(seen?.command).toContain('node');

    child.kill();
    await onceClosed(child);
    // The pid may linger as a zombie until reaped; poll briefly for disappearance.
    const deadline = Date.now() + 5_000;
    let gone = false;
    while (!gone && Date.now() < deadline) {
      gone = !listChildProcesses(process.pid).some((c) => c.pid === pid);
      if (!gone) await new Promise((r) => setTimeout(r, 50));
    }
    expect(gone).toBe(true);
  });
});
