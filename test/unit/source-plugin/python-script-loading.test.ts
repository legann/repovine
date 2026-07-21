import { afterAll, describe, expect, it, jest } from '@jest/globals';
import * as actualFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PackageInfo, PendingModule } from '../../../src/types.js';
import type { SourceExtractInput } from '@repovine/plugin-sdk';

afterAll(() => {
  jest.unstable_unmockModule('node:fs');
  jest.resetModules();
});

describe('Python AST script loading and packaging', () => {
  it('builds the script beside the compiled extractor byte-for-byte', () => {
    const source = actualFs.readFileSync(
      path.join(process.cwd(), 'src', 'source-plugins', 'python', 'route-ast-script.py'),
    );
    const packaged = actualFs.readFileSync(
      path.join(process.cwd(), 'dist', 'source-plugins', 'python', 'route-ast-script.py'),
    );
    expect(packaged.equals(source)).toBe(true);
  });

  it('does not read at import and caches a missing-script failure as an empty result', async () => {
    jest.resetModules();
    const missing = Object.assign(new Error('ENOENT: route-ast-script.py'), { code: 'ENOENT' });
    const readFileSync = jest.fn(() => { throw missing; });
    jest.unstable_mockModule('node:fs', () => ({ ...actualFs, readFileSync }));

    const imported = await import('../../../src/source-plugins/python/extract.js');
    expect(readFileSync).not.toHaveBeenCalled();

    const pkg: PackageInfo = { name: 'py-pkg', path: '.', sourcePluginId: 'python' };
    const pending: PendingModule = {
      filePath: path.join(os.tmpdir(), 'lazy-script.py'),
      pkg,
      relPath: 'lazy-script.py',
      moduleId: 'mod:py-pkg/lazy-script',
      sourcePluginId: 'python',
    };
    const input: SourceExtractInput = {
      repoRoot: os.tmpdir(),
      packages: [pkg],
      pendingModules: [pending],
      prevByPath: new Map(),
      absPathToId: new Map([[pending.filePath, pending.moduleId]]),
      sourceByModuleId: new Map([[
        pending.moduleId,
        { content: 'def run():\n    return 1\n', contentHash: 'hash' },
      ]]),
      extractContext: { pythonBin: 'python3' },
      analysisVersion: 0,
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(imported.extractPython(input)).resolves.toEqual({ deltas: [], reused: 0, rescanned: 0 });
      await expect(imported.extractPython(input)).resolves.toEqual({ deltas: [], reused: 0, rescanned: 0 });
      expect(readFileSync).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('route-ast-script.py'));
    } finally {
      warn.mockRestore();
    }
  });
});
