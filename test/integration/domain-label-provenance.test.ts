/**
 * Invariant: every domain label the graph emits names something that exists in the repository.
 *
 * A domain label is how an agent asks for a slice of the codebase. A label derived from a file
 * extension (`main-py`), or invented as a fallback (`cluster`), points at nothing the maintainer
 * can open — the scope resolves and the answer is about a thing that does not exist. The check
 * runs on every fixture, Python included, so a language whose extension the labeler does not know
 * fails here rather than shipping a name.
 *
 * Exempt: infra-kind and content domains, which the engine declares from a registered kind or an
 * observed module property rather than deriving from the tree.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectRepositoryFactsAsync } from '../../src/stage1/index.js';
import { composeRepositoryGraph, CONTENT_DOMAIN_IDS } from '../../src/stage2/index.js';
import { stripSourceExtension } from '../../src/plugin-host/source-set.js';
import { getActiveKindDomains } from '../../src/plugin-host/iac-set.js';
import type { RepositoryGraph } from '../../src/types.js';

const FIXTURES_ROOT = [
  path.resolve(process.cwd(), 'test', 'fixtures'),
  path.resolve(process.cwd(), 'repovine', 'test', 'fixtures'),
].find(candidate => fs.existsSync(candidate));

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.repovine']);

function listFixtures(): string[] {
  if (!FIXTURES_ROOT) throw new Error('Could not find test fixtures root.');
  return fs
    .readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

/** Same slugging the domain labeler applies, so a tree name and a label are comparable. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Names the repository actually contains: directory segments, file basenames with and without
 * their source extension, and declared package names. The extension is stripped rather than
 * slugged away — slugging `main.py` would mint `main-py` and let the very defect through.
 */
function collectTreeNames(root: string, packageNames: readonly string[]): Set<string> {
  const names = new Set<string>();
  const add = (value: string): void => {
    const slugged = slug(value);
    if (slugged) names.add(slugged);
  };

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        add(entry.name);
        walk(full);
        continue;
      }
      add(stripSourceExtension(entry.name));
    }
  };

  walk(root);
  for (const name of packageNames) add(name);
  return names;
}

function declaredDomainIds(): Set<string> {
  return new Set([...getActiveKindDomains().map(({ meta }) => meta.domainId), ...CONTENT_DOMAIN_IDS]);
}

function emittedDomainLabels(graph: RepositoryGraph): Array<{ id: string; label: string }> {
  const exempt = declaredDomainIds();
  const out: Array<{ id: string; label: string }> = [];
  for (const id of graph.byType.get('domain') ?? []) {
    if (exempt.has(id) || id.startsWith('domain:infra-')) continue;
    const node = graph.nodes.get(id);
    if (node?.type === 'domain') out.push({ id, label: node.label });
  }
  return out;
}

describe('domain labels name something in the repository', () => {
  describe.each(listFixtures())('%s', (fixtureName) => {
    const fixtureRoot = path.join(FIXTURES_ROOT!, fixtureName);

    let graph: RepositoryGraph;
    let treeNames: Set<string>;

    beforeAll(async () => {
      const origLog = console.log;
      console.log = () => {};
      try {
        const snapshot = await collectRepositoryFactsAsync(fixtureRoot);
        graph = composeRepositoryGraph(snapshot);
        treeNames = collectTreeNames(fixtureRoot, snapshot.packages.map(pkg => pkg.name));
      } finally {
        console.log = origLog;
      }
    });

    it('emits no domain label absent from the fixture tree', () => {
      const unbacked: string[] = [];
      for (const { label } of emittedDomainLabels(graph)) {
        // Hierarchical labels (`angular-fixture/users`) name a parent and a child; both must exist.
        for (const part of label.split('/')) {
          const wanted = slug(part);
          if (!wanted) continue;
          if (![...treeNames].some(name => name.includes(wanted))) unbacked.push(label);
        }
      }
      expect(unbacked).toEqual([]);
    });
  });
});
