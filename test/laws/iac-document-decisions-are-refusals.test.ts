import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach } from '@jest/globals';
import { defineIaCParser } from '@repovine/plugin-sdk';
import type { DocumentLoader, IaCParser, SemanticInfraDelta } from '@repovine/plugin-sdk';
import { collectInfraModules } from '../../src/stage1/infra.js';
import { resolveLoaderForFile } from '../../src/plugin-host/iac-set.js';
import { installOneMore, restoreBuiltinPlugins } from '../helpers/plugins.js';

/**
 * Law: every decision the document scan cannot make is refused, not guessed.
 *
 * Reading a file used to be settled by registration order in three places: which loader decoded it,
 * which parser got to read it, and which of two resources with one id survived. Order is not a
 * reason, so each of those is now either decided by a rule that does not depend on it, or refused
 * with both sides named.
 *
 * The cases below drive each decision to its refusal. A build that answered one of them by picking
 * a winner would return resources here instead of a refusal.
 */
describe('core-laws IaC document decisions are refusals, not registration order', () => {
  const tmpDirs: string[] = [];

  function repo(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine iac-décisions-'));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    return dir;
  }

  function parser(overrides: Partial<IaCParser> & Pick<IaCParser, 'kind' | 'loaderId'>): IaCParser {
    return defineIaCParser({
      fileMatch: { extensions: ['.probe'] },
      supports: () => true,
      parse: (): SemanticInfraDelta => ({
        kind: overrides.kind,
        resources: [{
          id: 'r',
          kind: 'other',
          provider: 'probe',
          identity: { namespace: 'probe', localKey: 'r' },
          contentHash: 'h',
          attributes: {},
        }],
      }),
      ...overrides,
    });
  }

  const nullLoader: DocumentLoader = { id: 'probe-a', load: () => [{ documentKey: '0', value: {} }] };
  const otherLoader: DocumentLoader = { id: 'probe-b', load: () => [{ documentKey: '0', value: {} }] };

  afterEach(async () => {
    await restoreBuiltinPlugins();
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a file two equally specific parsers want decoded differently', () => {
    installOneMore({
      id: 'probe-a',
      loaders: [nullLoader],
      parsers: [parser({ kind: 'probe-a', loaderId: 'probe-a' })],
    });
    installOneMore({
      id: 'probe-b',
      loaders: [otherLoader],
      parsers: [parser({ kind: 'probe-b', loaderId: 'probe-b' })],
    });

    const { modules, refusals } = collectInfraModules({ repoRoot: repo({ 'x.probe': '{}\n' }) });
    expect(modules).toEqual([]);
    expect(refusals.map(r => r.kind)).toEqual(['iac-loader-ambiguous']);
    expect(refusals[0].details).toMatchObject({ loaderIds: ['probe-a', 'probe-b'] });
  });

  it('lets the parser that named the file decide the loader over one that named the extension', () => {
    // This is the `vercel.json` case: a CloudFormation parser accepts every `.json`, and the Vercel
    // parser accepts exactly `vercel.json`. Specificity settles it without consulting either
    // plugin's position in the registry.
    installOneMore({
      id: 'probe-a',
      loaders: [nullLoader],
      parsers: [parser({ kind: 'probe-a', loaderId: 'probe-a' })],
    });
    installOneMore({
      id: 'probe-b',
      loaders: [otherLoader],
      parsers: [parser({
        kind: 'probe-b',
        loaderId: 'probe-b',
        fileMatch: { fileNames: ['named.probe'] },
      })],
    });

    expect(resolveLoaderForFile('named.probe', '.probe')).toMatchObject({
      status: 'resolved',
      loaderId: 'probe-b',
    });
    expect(resolveLoaderForFile('other.probe', '.probe')).toMatchObject({
      status: 'resolved',
      loaderId: 'probe-a',
    });
  });

  it('refuses a loader id no plugin registered', () => {
    installOneMore({
      id: 'probe-a',
      parsers: [parser({ kind: 'probe-a', loaderId: 'nobody-provides-this' })],
    });
    const { modules, refusals } = collectInfraModules({ repoRoot: repo({ 'x.probe': '{}\n' }) });
    expect(modules).toEqual([]);
    expect(refusals.map(r => r.kind)).toEqual(['iac-loader-unknown']);
  });

  it('refuses a second plugin claiming a loader id the first provides', () => {
    installOneMore({
      id: 'probe-a',
      loaders: [nullLoader],
      parsers: [parser({ kind: 'probe-a', loaderId: 'probe-a' })],
    });
    installOneMore({
      id: 'probe-b',
      loaders: [{ id: 'probe-a', load: () => [] }],
      parsers: [parser({ kind: 'probe-b', loaderId: 'probe-a' })],
    });
    const { refusals } = collectInfraModules({ repoRoot: repo({ 'x.probe': '{}\n' }) });
    expect(refusals.map(r => r.kind)).toContain('iac-loader-claimed-twice');
    expect(refusals.find(r => r.kind === 'iac-loader-claimed-twice')?.details)
      .toMatchObject({ loaderId: 'probe-a', heldBy: 'probe-a', refused: 'probe-b' });
  });

  it('lets two shared parsers both contribute from one document', () => {
    installOneMore({
      id: 'probe-a',
      loaders: [nullLoader],
      parsers: [parser({ kind: 'probe-a', loaderId: 'probe-a' })],
    });
    installOneMore({
      id: 'probe-b',
      parsers: [parser({ kind: 'probe-b', loaderId: 'probe-a' })],
    });
    const { modules, refusals } = collectInfraModules({ repoRoot: repo({ 'x.probe': '{}\n' }) });
    expect(refusals).toEqual([]);
    expect(modules.map(m => m.kind).sort()).toEqual(['probe-a', 'probe-b']);
  });

  it('refuses both readings when one parser claimed the document exclusively', () => {
    installOneMore({
      id: 'probe-a',
      loaders: [nullLoader],
      parsers: [parser({ kind: 'probe-a', loaderId: 'probe-a', claim: 'exclusive' })],
    });
    installOneMore({
      id: 'probe-b',
      parsers: [parser({ kind: 'probe-b', loaderId: 'probe-a' })],
    });
    const { modules, refusals } = collectInfraModules({ repoRoot: repo({ 'x.probe': '{}\n' }) });
    expect(modules).toEqual([]);
    expect(refusals.map(r => r.kind)).toEqual(['iac-document-claim-conflict']);
    expect(refusals[0].details).toMatchObject({ kinds: ['probe-a', 'probe-b'] });
  });

  it('a parser returning null leaves the others to read the document', () => {
    installOneMore({
      id: 'probe-a',
      loaders: [nullLoader],
      // Declaring the claim exclusive AND returning null: the old scan stopped at the first
      // supports() and lost the second reading; the exclusive claim only bites on a contribution.
      parsers: [defineIaCParser({
        kind: 'probe-a',
        loaderId: 'probe-a',
        claim: 'exclusive',
        fileMatch: { extensions: ['.probe'] },
        supports: () => true,
        parse: () => null,
      })],
    });
    installOneMore({
      id: 'probe-b',
      parsers: [parser({ kind: 'probe-b', loaderId: 'probe-a' })],
    });
    const { modules, refusals } = collectInfraModules({ repoRoot: repo({ 'x.probe': '{}\n' }) });
    expect(refusals).toEqual([]);
    expect(modules.map(m => m.kind)).toEqual(['probe-b']);
  });

  it('folds an identity stated twice and refuses one stated twice differently', () => {
    const twice = (localKey: string, attributes: Record<string, string>) => ({
      id: localKey,
      kind: 'other' as const,
      provider: 'probe',
      identity: { namespace: 'probe', localKey },
      contentHash: 'h',
      attributes,
    });
    installOneMore({
      id: 'probe-a',
      loaders: [nullLoader],
      parsers: [defineIaCParser({
        kind: 'probe-a',
        loaderId: 'probe-a',
        fileMatch: { extensions: ['.probe'] },
        supports: () => true,
        parse: (): SemanticInfraDelta => ({
          kind: 'probe-a',
          resources: [
            twice('same', { a: '1' }),
            twice('same', { a: '1' }),
            twice('split', { a: '1' }),
            twice('split', { a: '2' }),
          ],
        }),
      })],
    });
    const { modules, refusals } = collectInfraModules({ repoRoot: repo({ 'x.probe': '{}\n' }) });
    expect(modules.flatMap(m => m.resources).map(r => r.identity.localKey)).toEqual(['same']);
    expect(refusals.map(r => r.kind)).toEqual(['resource-identity-conflict']);
    expect(refusals[0].details).toMatchObject({ resourceId: 'resource:probe:split' });
  });
});
