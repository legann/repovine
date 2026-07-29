import { asPkgRelPath } from '@repovine/plugin-sdk';
import { asHostPath, asRepoRelPath } from '@repovine/plugin-sdk';
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
      path.join(process.cwd(), 'packages', 'plugins', 'source-python', 'src', 'route-ast-script.py'),
    );
    const packaged = actualFs.readFileSync(
      path.join(process.cwd(), 'packages', 'plugins', 'source-python', 'dist', 'route-ast-script.py'),
    );
    expect(packaged.equals(source)).toBe(true);
  });

  it('does not probe at import and caches a missing-script failure as an empty result', async () => {
    jest.resetModules();
    const missing = Object.assign(new Error('ENOENT: route-ast-script.py'), { code: 'ENOENT' });
    // The loader probes the script path with accessSync (the subprocess runs the
    // file; its content is never read into Node).
    const accessSync = jest.fn(() => { throw missing; });
    jest.unstable_mockModule('node:fs', () => ({ ...actualFs, accessSync }));

    const imported = await import('../../../packages/plugins/source-python/src/extract.js');
    expect(accessSync).not.toHaveBeenCalled();

    const pkg: PackageInfo = { name: 'py-pkg', repoRelDir: asRepoRelPath('.'), sourcePluginId: 'python' };
    const pending: PendingModule = {
      absPath: asHostPath(path.join(os.tmpdir(), 'lazy-script.py')),
      pkg,
      pkgRelPath: asPkgRelPath('lazy-script.py'),
      moduleId: 'mod:py-pkg/lazy-script',
      sourcePluginId: 'python',
    };
    const input: SourceExtractInput = {
      repoRoot: asHostPath(os.tmpdir()),
      packages: [pkg],
      pendingModules: [pending],
      prevByAbsPath: new Map(),
      absPathToId: new Map([[pending.absPath, pending.moduleId]]),
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
      expect(accessSync).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('route-ast-script.py'));
    } finally {
      warn.mockRestore();
    }
  });
});
