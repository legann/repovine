import * as path from 'node:path';
import {
  isTrustedInterpreterPathEntry,
  detectPython,
  safeInterpreterCwd,
} from '../../../src/source-plugins/python/discover.js';

/**
 * The interpreter is resolved to an absolute path from trusted PATH directories, and subprocesses run
 * from a non-repo working directory. Together these keep a repo-local `./python`/`./python.exe` (which
 * the Windows spawn search tries before PATH) and a repo-local `ast.py` (which `python -c` would find
 * on `sys.path`) from ever executing when analyzing an untrusted repository.
 */
describe('python interpreter resolution trust boundary', () => {
  const cwd = process.cwd();

  it('rejects empty, relative, and current-directory PATH entries', () => {
    // Every entry here resolves the executable search against the cwd — the vector a repo-local
    // interpreter would exploit.
    expect(isTrustedInterpreterPathEntry('', cwd)).toBe(false);
    expect(isTrustedInterpreterPathEntry('.', cwd)).toBe(false);
    expect(isTrustedInterpreterPathEntry('bin', cwd)).toBe(false);
    expect(isTrustedInterpreterPathEntry('./tools', cwd)).toBe(false);
    expect(isTrustedInterpreterPathEntry(cwd, cwd)).toBe(false);
    expect(isTrustedInterpreterPathEntry(path.resolve(cwd), cwd)).toBe(false);
  });

  it('accepts an absolute directory that is not the current directory', () => {
    expect(isTrustedInterpreterPathEntry(path.resolve(cwd, '..'), cwd)).toBe(true);
  });

  it('runs interpreter subprocesses from a directory outside the repo', () => {
    expect(safeInterpreterCwd().startsWith(cwd)).toBe(false);
    expect(path.isAbsolute(safeInterpreterCwd())).toBe(true);
  });

  const py = detectPython();
  (py ? it : it.skip)('resolves the interpreter to an absolute path, never a bare name', () => {
    expect(py).toBeTruthy();
    expect(path.isAbsolute(py as string)).toBe(true);
  });
});
