import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { describeTransformersInstall } from '../../../src/semantic/embedder.js';

// @huggingface/transformers is a dev dependency of this repo, so the bare
// ('repovine') resolution path always succeeds in the monorepo checkout.
describe('describeTransformersInstall', () => {
  it('resolves the dev install next to repovine with a semver version', () => {
    const info = describeTransformersInstall(process.cwd());
    expect(info.resolved).toBe(true);
    expect(info.entryPath).toBeDefined();
    expect(path.isAbsolute(info.entryPath!)).toBe(true);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('resolves via the repovine source from an empty workspace root', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedder-install-'));
    try {
      const info = describeTransformersInstall(dir);
      expect(info.resolved).toBe(true);
      expect(info.source).toBe('repovine');
      expect(path.isAbsolute(info.entryPath!)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
