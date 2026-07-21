import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkSourcePluginConformance,
  checkIaCPluginConformance,
  defineSourcePlugin,
  type SourcePlugin,
  type SourceExtractInput,
  type PendingModule,
  type IaCParser,
  type IaCPluginDescriptor,
} from '@repovine/plugin-sdk';
import dockerfileIacPlugin from '../../../src/iac-plugins/dockerfile/index.js';

// The conformance kit is the objective bar a plugin self-certifies against. Bundled plugins pass it
// (dogfood); a plugin that leaks mechanics or is non-deterministic fails the matching check.
describe('plugin-sdk conformance kit', () => {
  const tmpRoots: string[] = [];

  function sampleRepoWithFooFile(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-'));
    tmpRoots.push(root);
    fs.writeFileSync(path.join(root, 'app.foo'), 'foo source\n');
    return root;
  }

  function fooDiscover(repoRoot: string) {
    const pkg = { name: 'foo-pkg', path: '.', sourcePluginId: 'foo-lang' };
    const pendingByPath = new Map<string, PendingModule>();
    for (const entry of fs.readdirSync(repoRoot)) {
      if (entry.endsWith('.foo')) {
        const filePath = path.join(repoRoot, entry);
        pendingByPath.set(filePath, { filePath, pkg, relPath: entry, moduleId: `mod:foo-pkg/${entry.replace(/\.foo$/, '')}`, sourcePluginId: 'foo-lang' });
      }
    }
    return { packages: [pkg], pendingByPath };
  }

  afterEach(() => {
    for (const r of tmpRoots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  it('a well-formed source plugin passes every check', async () => {
    const plugin = defineSourcePlugin({
      id: 'foo-lang',
      fileMatch: { extensions: ['.foo'] },
      capabilities: { extensions: ['.foo'] },
      discover: fooDiscover,
      extract(input: SourceExtractInput) {
        const deltas = input.pendingModules.map(pm => ({ moduleId: pm.moduleId, imports: [], exports: [], semanticHints: { webFramework: 'fooframework' } }));
        return { deltas, reused: 0, rescanned: deltas.length };
      },
    });
    const report = await checkSourcePluginConformance(plugin, { sampleRepoRoot: sampleRepoWithFooFile() });
    expect(report.passed).toBe(true);
  });

  it('fails the semantics-only check when a delta leaks engine-owned mechanics', async () => {
    const plugin: SourcePlugin = {
      id: 'leaky',
      fileMatch: { extensions: ['.foo'] },
      discover: fooDiscover,
      extract(input: SourceExtractInput) {
        // Illegally stamps mechanical fields the engine owns.
        const deltas = input.pendingModules.map(pm => ({ moduleId: pm.moduleId, imports: [], exports: [], id: 'x', contentHash: 'deadbeef' }));
        return { deltas: deltas as never, reused: 0, rescanned: deltas.length };
      },
    };
    const report = await checkSourcePluginConformance(plugin, { sampleRepoRoot: sampleRepoWithFooFile() });
    expect(report.passed).toBe(false);
    const leak = report.checks.find(c => c.name.includes('semantics only'));
    expect(leak?.ok).toBe(false);
  });

  it('fails the determinism check when extract output varies for identical input', async () => {
    let n = 0;
    const plugin: SourcePlugin = {
      id: 'flaky',
      fileMatch: { extensions: ['.foo'] },
      discover: fooDiscover,
      extract(input: SourceExtractInput) {
        n += 1;
        const deltas = input.pendingModules.map(pm => ({ moduleId: pm.moduleId, imports: [], exports: [], semanticHints: { webFramework: `v${n}` } }));
        return { deltas, reused: 0, rescanned: deltas.length };
      },
    };
    const report = await checkSourcePluginConformance(plugin, { sampleRepoRoot: sampleRepoWithFooFile() });
    expect(report.passed).toBe(false);
    expect(report.checks.find(c => c.name.includes('deterministic'))?.ok).toBe(false);
  });

  it('the bundled Dockerfile plugin passes IaC conformance (dogfood)', () => {
    const report = checkIaCPluginConformance(dockerfileIacPlugin, {
      samples: [{ filePath: '/repo/Dockerfile', relPath: 'Dockerfile', doc: 'FROM node:20\nEXPOSE 3000\n' }],
    });
    expect(report.passed).toBe(true);
  });

  it('mirrors the engine dispatch: supports() gates parse(), and only the first claiming parser runs', () => {
    // `guarded` matches the file via fileMatch but declines via supports(); its parse() throws.
    // The engine never parses a doc a parser did not claim, so the kit must not either — running
    // parse() unconditionally (the old kit) would fail this well-formed multi-parser plugin.
    let guardedParsed = false;
    const guarded: IaCParser = {
      kind: 'helm',
      fileMatch: { extensions: ['.yaml'] },
      supports: () => false,
      parse: () => { guardedParsed = true; throw new Error('parse() ran on an unclaimed doc'); },
    };
    const claiming: IaCParser = {
      kind: 'kubernetes',
      fileMatch: { extensions: ['.yaml'] },
      supports: (_f, doc) => !!doc && typeof doc === 'object' && 'apiVersion' in (doc as object),
      parse: () => ({ kind: 'kubernetes', resources: [] }),
    };
    const descriptor: IaCPluginDescriptor = { id: 'dispatch-fidelity', parsers: [guarded, claiming] };

    const report = checkIaCPluginConformance(descriptor, {
      samples: [{ filePath: '/repo/svc.yaml', relPath: 'svc.yaml', doc: { apiVersion: 'v1', kind: 'Service' } }],
    });

    expect(guardedParsed).toBe(false);
    expect(report.passed).toBe(true);
  });
});
