import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseBundleOutputScript, loadBundleOutputHandlerMap } from '../../../src/stage2/bundle-output-loader.js';

describe('parseBundleOutputScript — esbuild style', () => {
  it('maps output path to TS entry when they differ', () => {
    const src = `
      const lambdaFunctions = [
        { entryPoint: 'health.ts', outputFile: 'health.js', artifactDir: 'health' },
        { entryPoint: 'integrations/payments/ingest.ts', outputFile: 'webhooks/ingest.js', artifactDir: 'x' },
        { entryPoint: 'integrations/payments/oauth.ts', outputFile: 'oauth.js', artifactDir: 'y' },
      ];
    `;
    const m = parseBundleOutputScript(src);
    expect(m['webhooks/ingest']).toBe('integrations/payments/ingest');
    expect(m['oauth']).toBe('integrations/payments/oauth');
    expect(m['health']).toBeUndefined();
  });

  it('supports outputFile before entryPoint', () => {
    const src = `{ outputFile: 'webhooks/worker.js', entryPoint: 'integrations/payments/worker.ts' }`;
    const m = parseBundleOutputScript(src);
    expect(m['webhooks/worker']).toBe('integrations/payments/worker');
  });
});

describe('parseBundleOutputScript — webpack style (entry/output)', () => {
  it('parses entry → output pair', () => {
    const src = `module.exports = { entry: 'src/users.ts', output: 'dist/users.js' };`;
    const m = parseBundleOutputScript(src);
    expect(m['dist/users']).toBe('src/users');
  });

  it('parses reverse order output → entry', () => {
    const src = `{ output: 'dist/main.js', entry: 'src/main.ts' }`;
    const m = parseBundleOutputScript(src);
    expect(m['dist/main']).toBe('src/main');
  });
});

describe('parseBundleOutputScript — rollup style (input/file)', () => {
  it('parses input → file pair', () => {
    const src = `export default { input: 'src/api.ts', file: 'dist/api.cjs' };`;
    const m = parseBundleOutputScript(src);
    expect(m['dist/api']).toBe('src/api');
  });

  it('parses reverse order file → input', () => {
    const src = `{ file: 'dist/cli.mjs', input: 'src/cli.ts' }`;
    const m = parseBundleOutputScript(src);
    expect(m['dist/cli']).toBe('src/cli');
  });
});

describe('loadBundleOutputHandlerMap — auto-detect convention paths', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-loader-test-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('discovers scripts/bundle.js without explicit config', () => {
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'scripts/bundle.js'),
      `[{ entryPoint: 'src/foo.ts', outputFile: 'dist/foo.js' }]`,
    );
    const m = loadBundleOutputHandlerMap(tmp, []);
    expect(m['dist/foo']).toBe('src/foo');
  });

  it('discovers per-workspace bundle scripts via package.json workspaces', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      workspaces: ['packages/*'],
    }));
    fs.mkdirSync(path.join(tmp, 'packages/lambda/scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'packages/lambda/scripts/bundle.js'),
      `[{ entryPoint: 'src/handler.ts', outputFile: 'dist/handler.js' }]`,
    );
    const m = loadBundleOutputHandlerMap(tmp, []);
    expect(m['dist/handler']).toBe('src/handler');
  });

  it('uses bundleScripts when provided', () => {
    fs.mkdirSync(path.join(tmp, 'custom'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'custom/my-build.js'),
      `{ entryPoint: 'src/x.ts', outputFile: 'out/x.js' }`,
    );
    const m = loadBundleOutputHandlerMap(tmp, ['custom/my-build.js']);
    expect(m['out/x']).toBe('src/x');
  });

  it('returns empty when neither explicit nor convention files exist', () => {
    const m = loadBundleOutputHandlerMap(tmp, []);
    expect(m).toEqual({});
  });

  it('merges explicit bundleScripts with auto-detected scripts (additive)', () => {
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'scripts/bundle.js'),
      `[{ entryPoint: 'src/foo.ts', outputFile: 'dist/foo.js' }]`,
    );
    fs.mkdirSync(path.join(tmp, 'custom'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'custom/extra.js'),
      `{ entryPoint: 'src/bar.ts', outputFile: 'dist/bar.js' }`,
    );
    const m = loadBundleOutputHandlerMap(tmp, ['custom/extra.js']);
    expect(m['dist/foo']).toBe('src/foo');
    expect(m['dist/bar']).toBe('src/bar');
  });

  it('skips auto-detect when autoDetect is false', () => {
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'scripts/bundle.js'),
      `[{ entryPoint: 'src/foo.ts', outputFile: 'dist/foo.js' }]`,
    );
    const m = loadBundleOutputHandlerMap(tmp, [], false);
    expect(m).toEqual({});
  });

  it('still loads explicit bundleScripts when autoDetect is false', () => {
    fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'scripts/bundle.js'),
      `[{ entryPoint: 'src/foo.ts', outputFile: 'dist/foo.js' }]`,
    );
    fs.mkdirSync(path.join(tmp, 'custom'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'custom/extra.js'),
      `{ entryPoint: 'src/bar.ts', outputFile: 'dist/bar.js' }`,
    );
    const m = loadBundleOutputHandlerMap(tmp, ['custom/extra.js'], false);
    expect(m['dist/foo']).toBeUndefined();
    expect(m['dist/bar']).toBe('src/bar');
  });

  // A configured script path is repo-root-relative, and `path.join` normalizes a `..` segment away
  // instead of rejecting it. Everything the engine reads stays under the workspace root.
  it('refuses a configured script path that climbs out of the workspace root', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-outside-')));
    fs.writeFileSync(
      path.join(outside, 'evil.js'),
      `{ entryPoint: 'src/evil.ts', outputFile: 'dist/evil.js' }`,
    );
    const rel = path.relative(tmp, path.join(outside, 'evil.js'));

    const m = loadBundleOutputHandlerMap(tmp, [rel], false);

    expect(m).toEqual({});
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
