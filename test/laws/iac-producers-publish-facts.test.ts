import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IaCParser, ReadonlyFactRecord, SemanticInfraDelta } from '@repovine/plugin-sdk';
import { collectInfraModules } from '../../src/stage1/infra.js';
import { installOneMore, restoreBuiltinPlugins } from '../helpers/plugins.js';

/**
 * Law: an IaC producer publishes facts on the same terms a source producer does.
 *
 * A resource says what exists. What one ecosystem knows about it beyond the canonical fields — a
 * Kubernetes Ingress backend, a namespace, a workload kind — has no canonical field to live in, and
 * before this channel the only way it reached the graph was a branch in the engine reading the
 * ecosystem's own attribute spellings. A fact carries it instead: the projector that understands it
 * selects the schema, and the host stores strings it never interprets.
 *
 * The ownership rule is the source boundary's rule, unchanged: a producer publishes under a schema
 * it owns, and anything else is refused with the plugin named.
 */
describe('core-laws IaC producers publish facts', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    await restoreBuiltinPlugins();
  });

  function repo(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-facts-law-'));
    tmpDirs.push(root);
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    return root;
  }

  /** A parser for an ecosystem that exists nowhere but this file. */
  function parserPublishing(facts: readonly ReadonlyFactRecord[]): IaCParser {
    return {
      kind: 'zephyr',
      loaderId: 'json',
      fileMatch: { extensions: ['.zephyr'] },
      supports: () => true,
      parse: (_filePath, relPath): SemanticInfraDelta => ({
        kind: 'zephyr',
        resources: [{
          id: 'gateway',
          kind: 'zephyr-gateway',
          provider: 'zephyr',
          identity: { namespace: 'zephyr', localKey: 'gateway' },
          contentHash: 'zephyr-gateway',
          attributes: { declaredIn: relPath },
          triggers: [],
          envRefs: [],
        }],
        facts,
      }),
    };
  }

  it('carries a published fact from the parser to the snapshot', () => {
    installOneMore({
      id: 'zephyr',
      parsers: [parserPublishing([{
        schema: 'zephyr/routing@1',
        subjectRef: { type: 'resource', namespace: 'zephyr', localKey: 'gateway' },
        value: { backends: ['checkout', 'search'], namespace: 'edge' },
      }])],
    });

    const { facts, refusals } = collectInfraModules({ repoRoot: repo({ 'edge.zephyr': '{}\n' }) });

    expect(refusals).toEqual([]);
    expect(facts).toEqual([{
      schema: 'zephyr/routing@1',
      subjectRef: { type: 'resource', namespace: 'zephyr', localKey: 'gateway' },
      value: { backends: ['checkout', 'search'], namespace: 'edge' },
    }]);
  });

  it('refuses a fact published under another plugin\'s schema, and keeps the resource', () => {
    installOneMore({
      id: 'zephyr',
      parsers: [parserPublishing([{
        schema: 'kubernetes/workload@1',
        subjectRef: { type: 'resource', namespace: 'zephyr', localKey: 'gateway' },
        value: { stolen: true },
      }])],
    });

    const { facts, refusals, modules } = collectInfraModules({
      repoRoot: repo({ 'edge.zephyr': '{}\n' }),
    });

    expect(facts).toEqual([]);
    expect(refusals.map(r => r.kind)).toEqual(['plugin-fact-rejected']);
    expect(refusals[0]!.message).toContain('kubernetes/workload@1');
    // The refusal is about the fact, not the document: what the parser said exists still exists.
    // The id here is the one the parser stated; the engine mints the final one downstream.
    expect(modules.flatMap(m => m.resources).map(r => r.id)).toEqual(['gateway']);
  });

  it('publishes nothing when a parser declares no facts', () => {
    installOneMore({ id: 'zephyr', parsers: [parserPublishing([])] });

    const { facts, refusals } = collectInfraModules({ repoRoot: repo({ 'edge.zephyr': '{}\n' }) });

    expect(refusals).toEqual([]);
    expect(facts).toEqual([]);
  });
});
