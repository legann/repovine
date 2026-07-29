import { afterEach, describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { setSourcePluginsForTest } from '../../src/plugin-host/source-set.js';
import type { SourcePlugin, PendingModule, PendingModuleDraft } from '@repovine/plugin-sdk';

// The identity invariant: `mod:<pkg>/<path>` is load-bearing for scope resolution, annotation keys,
// boundary lookups and runtime handoff, so the ENGINE mints it. A producer reports where a file is
// and which ecosystem owns it; it has nowhere to put an id, because `PendingModuleDraft` has no such
// field. A third-party plugin therefore gets a well-formed id without cooperating, and cannot get one
// wrong. The ecosystem's own conventions travel as a declaration the engine applies.
describe('core-laws engine mints module ids (producer supplies none)', () => {
  const tempRoots: string[] = [];
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
    for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-mint-')));
    tempRoots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    return root;
  }

  /** A third-party plugin that reports drafts only — it never names an id. */
  function draftingPlugin(
    id: string,
    ext: string,
    capabilities?: SourcePlugin['capabilities'],
    seen?: PendingModule[],
  ): SourcePlugin {
    return {
      id,
      capabilities: capabilities ?? { extensions: [ext] },
      discover: (repoRoot: string) => {
        const pkg = { name: 'demo-app', path: '.', sourcePluginId: id };
        const pendingByPath = new Map<string, PendingModuleDraft>();
        const walk = (dir: string): void => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(abs); continue; }
            if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
            pendingByPath.set(abs, {
              filePath: abs,
              pkg,
              relPath: path.relative(repoRoot, abs).split(path.sep).join('/'),
              sourcePluginId: id,
            });
          }
        };
        walk(repoRoot);
        return { packages: [pkg], pendingByPath };
      },
      extract: input => {
        seen?.push(...input.pendingModules);
        return {
          deltas: input.pendingModules.map(pm => ({ moduleId: pm.moduleId, imports: [], exports: [] })),
          reused: 0,
          rescanned: input.pendingModules.length,
        };
      },
    };
  }

  it('mints a well-formed id for a plugin that declares no normalization', async () => {
    restore = setSourcePluginsForTest([draftingPlugin('go', '.go')]);
    const root = fixture({ 'cmd/server/main.go': 'package main\n' });

    const snapshot = await collectRepositoryFactsAsync(root);

    // No declaration means no suffix is stripped — the engine never guesses another ecosystem's rules.
    expect(snapshot.modules.map(m => m.id)).toEqual(['mod:demo-app/cmd/server/main.go']);
  });

  it('applies the ecosystem rules the plugin declared', async () => {
    restore = setSourcePluginsForTest([draftingPlugin('go', '.go', {
      extensions: ['.go'],
      moduleIdNormalize: { stripSuffixes: ['.go'], indexBasenames: ['mod'] },
    })]);
    const root = fixture({ 'cmd/server/main.go': 'package main\n', 'lib/mod.go': 'package lib\n' });

    const snapshot = await collectRepositoryFactsAsync(root);

    expect(snapshot.modules.map(m => m.id).sort())
      .toEqual(['mod:demo-app/cmd/server/main', 'mod:demo-app/lib']);
  });

  it('hands the minted id back to the producer as the extract correlation key', async () => {
    // The producer keys its deltas by an id it did not choose; the engine must therefore supply it
    // before extract() runs, or every delta would fail to match its module.
    const seen: PendingModule[] = [];
    restore = setSourcePluginsForTest([draftingPlugin('go', '.go', {
      extensions: ['.go'],
      moduleIdNormalize: { stripSuffixes: ['.go'] },
    }, seen)]);
    const root = fixture({ 'main.go': 'package main\n' });

    const snapshot = await collectRepositoryFactsAsync(root);

    expect(seen.map(pm => pm.moduleId)).toEqual(['mod:demo-app/main']);
    expect(snapshot.modules.map(m => m.id)).toEqual(['mod:demo-app/main']);
  });

  it('ignores an id a producer tries to smuggle onto its draft', async () => {
    // `PendingModuleDraft` has no `moduleId`, so this cannot happen through the typed contract. A
    // plain-JS plugin can still set the property; the engine overwrites it rather than trusting it.
    const plugin = draftingPlugin('go', '.go', {
      extensions: ['.go'],
      moduleIdNormalize: { stripSuffixes: ['.go'] },
    });
    const discover = plugin.discover.bind(plugin);
    plugin.discover = (repoRoot, options) => {
      const result = discover(repoRoot, options);
      for (const draft of result.pendingByPath.values()) {
        (draft as PendingModule).moduleId = 'not-a-module-id';
      }
      return result;
    };
    restore = setSourcePluginsForTest([plugin]);
    const root = fixture({ 'main.go': 'package main\n' });

    const snapshot = await collectRepositoryFactsAsync(root);

    expect(snapshot.modules.map(m => m.id)).toEqual(['mod:demo-app/main']);
  });
});
