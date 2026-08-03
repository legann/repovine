import { asPkgRelPath } from '@repovine/plugin-sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import {
  addEdge,
  addNode,
  countNodesOfType,
  createEmptyGraph,
  directImportTargets,
  domainLabel,
  domainMembers,
  edgeCount,
  isNodeType,
  nodeLabel,
  nodesOfType,
  walkImporters,
  handlerModuleIds,
  hasEdge,
  importerCount,
  infraTargetIds,
  isAuthoredTag,
  isPatternTag,
  isPrimaryTag,
  isTaggedInto,
  isWitnessedNode,
  modulePackageId,
  packageModuleIds,
  taggedDomains,
} from '../../src/graph/index.js';
import { EDGE_KINDS, TAG_EDGE_SOURCES } from '../../src/graph/model.js';
import { domainLabelFromId, domainNodeId, isDomainNodeId } from '../../src/graph/node-ids.js';
import { runtimeFanIn } from '../../src/analysis/architecture/heuristics.js';
import { resolveDomainContentHash } from '../../src/annotations/content-hash.js';
import { DEFAULT_PROPAGATION_CONFIG } from '../../src/config.js';
import { handleMapContext } from '../../src/mcp/tools/map-context.js';
import { findFixturesRoot, lawRuntime } from './graph-law-helpers.js';
import { makeProject } from './core-schema.js';
import { Node, SyntaxKind } from 'ts-morph';
import type {
  EdgeKind,
  ModuleInfo,
  RepositoryFactsSnapshot,
  RepositoryGraph,
  TagEdgeSource,
} from '../../src/types.js';

// One question about the graph, one implementation, one spelling of the miss.
//
// The questions this law holds: which package owns a module, which domains a node is in, which
// nodes a domain holds, whether an edge already exists, how much comes in over imports, and what a
// runtime resource dispatches into. Each was answered by between three and nine copies that had
// already drifted — a package miss that reached the response as the literal name `unknown`, a
// member count that contradicted the member list inside one response, and a roll-up hash that could
// never move because its tag filter excluded every writer but one.
//
// The law works in three ways, and each covers what the others miss:
//   1. runtime lists (EDGE_KINDS, TAG_EDGE_SOURCES) walked for totality, so a new kind or source
//      arrives as a failing case rather than as a silently unanswered one;
//   2. agreement between two readers of one node, which catches a copy however it is spelled;
//   3. text guards for a second declaration, which catch a copy before it has drifted far enough to
//      disagree with anything.

// ── fixture ──

const PKG = 'pkg:app';
const OWNED = 'mod:app/owned';
const LOOSE = 'mod:loose/orphan';
const TYPE_ONLY_IMPORTER = 'mod:app/type-importer';
const PATTERN_MATCHED = 'mod:app/pattern-matched';
const DOMAIN = 'domain:shared';
const SUBDOMAIN = 'domain:shared/sub';
const RESOURCE = 'resource:aws-lambda:Worker';
const DOCKERFILE = 'infra:dockerfile:Dockerfile';

interface FixtureOptions {
  ownedHash?: string;
  looseHash?: string;
  /** Attach the loose module to the package, for the differential check. */
  adoptLoose?: boolean;
}

function fixture(options: FixtureOptions = {}): { graph: RepositoryGraph; snapshot: RepositoryFactsSnapshot } {
  const { ownedHash = 'owned-h1', looseHash = 'loose-h1', adoptLoose = false } = options;
  const graph = createEmptyGraph();
  const node = (id: string, type: string, label: string, data?: unknown) =>
    addNode(graph, { id, type, label, description: label, ...(data ? { data } : {}) } as never);

  node('root', 'root', 'root');
  node(PKG, 'package', 'app');
  node(DOMAIN, 'domain', 'shared', { tier: 'feature' });
  node(SUBDOMAIN, 'domain', 'shared/sub', { tier: 'feature', parent: DOMAIN });
  node(OWNED, 'module', 'owned');
  node(LOOSE, 'module', 'orphan');
  node(TYPE_ONLY_IMPORTER, 'module', 'type-importer');
  node(PATTERN_MATCHED, 'module', 'pattern-matched');
  node(RESOURCE, 'runtime-resource', 'Worker', { provider: 'aws', kind: 'lambda' });
  node(DOCKERFILE, 'module', 'Dockerfile');

  addEdge(graph, PKG, OWNED, 'contains');
  addEdge(graph, PKG, TYPE_ONLY_IMPORTER, 'contains');
  addEdge(graph, PKG, PATTERN_MATCHED, 'contains');
  addEdge(graph, adoptLoose ? PKG : 'root', LOOSE, 'contains');
  addEdge(graph, 'root', DOCKERFILE, 'contains');

  // Domain membership: three modules, one runtime resource and one subdomain node all tag into the
  // same domain, so a count taken off the whole set and a list filtered to modules differ.
  addEdge(graph, OWNED, DOMAIN, 'tagged', { tagSource: 'path' });
  addEdge(graph, LOOSE, DOMAIN, 'tagged', { tagSource: 'path' });
  addEdge(graph, PATTERN_MATCHED, DOMAIN, 'tagged', { tagSource: 'pattern' });
  addEdge(graph, TYPE_ONLY_IMPORTER, DOMAIN, 'tagged', { tagSource: 'cluster' });
  addEdge(graph, RESOURCE, DOMAIN, 'tagged');
  addEdge(graph, SUBDOMAIN, DOMAIN, 'tagged');
  // The subdomain's own member carries no tagSource — the shape every writer but one produces.
  addEdge(graph, OWNED, SUBDOMAIN, 'tagged');

  // Import shapes: one runtime importer, one type-only importer.
  addEdge(graph, TYPE_ONLY_IMPORTER, OWNED, 'imports', { isTypeOnly: true });
  addEdge(graph, LOOSE, OWNED, 'imports');

  // The resource reaches a build artifact and a module over the same edge kind.
  addEdge(graph, RESOURCE, DOCKERFILE, 'infra');
  addEdge(graph, RESOURCE, OWNED, 'infra');

  const modules = [
    { id: OWNED, pkgRelPath: asPkgRelPath('app/owned.ts'), packageName: 'app', exports: [], imports: [], contentHash: ownedHash },
    { id: LOOSE, pkgRelPath: asPkgRelPath('loose/orphan.ts'), packageName: 'app', exports: [], imports: [], contentHash: looseHash },
    { id: TYPE_ONLY_IMPORTER, pkgRelPath: asPkgRelPath('app/type-importer.ts'), packageName: 'app', exports: [], imports: [], contentHash: 'ti-h1' },
    { id: PATTERN_MATCHED, pkgRelPath: asPkgRelPath('app/pattern-matched.ts'), packageName: 'app', exports: [], imports: [], contentHash: 'pm-h1' },
  ] as unknown as ModuleInfo[];
  const snapshot = { repoRoot: '/repo', timestamp: 't', packages: [], modules } as unknown as RepositoryFactsSnapshot;
  return { graph, snapshot };
}

async function mapContextModules(graph: RepositoryGraph, snapshot: RepositoryFactsSnapshot): Promise<Record<string, unknown>> {
  const ctx = lawRuntime(graph, snapshot);
  const base = ctx.getState();
  ctx.getState = () => ({
    ...base,
    annotations: { getAll: () => ({}), get: () => undefined } as unknown as typeof base.annotations,
  });
  const response = await handleMapContext(ctx, { scope: DOMAIN, view: 'modules' });
  return response.result as Record<string, unknown>;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The repository root, derived from the fixtures directory rather than from the process cwd. */
function repoRoot(): string {
  return path.resolve(findFixturesRoot(), '..', '..');
}

/** Every `src/` file except the one allowed to declare the answer, paired with its lines. */
function otherSourceLines(canonical: string[]): Array<{ rel: string; line: string; number: number }> {
  const root = repoRoot();
  const rows: Array<{ rel: string; line: string; number: number }> = [];
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const rel = path.relative(root, file);
    if (canonical.includes(rel)) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      // Comment lines are prose: naming a traversal in a sentence declares nothing.
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      rows.push({ rel, line, number: i + 1 });
    });
  }
  return rows;
}

const GRAPH_INDEX = path.join('src', 'graph', 'index.ts');
const NODE_IDS = path.join('src', 'graph', 'node-ids.ts');

describe('core-laws graph traversal (one question, one implementation)', () => {
  // ── the fixture answers every case below, so nothing here is vacuously green ──

  it('reaches every edge kind and every tag source, so the totality checks are not empty', () => {
    const { graph } = fixture();
    const usedKinds = new Set<EdgeKind>(graph.edges.map(e => e.kind));
    for (const kind of ['contains', 'imports', 'tagged', 'infra'] as EdgeKind[]) {
      expect(usedKinds.has(kind)).toBe(true);
    }
    const usedSources = new Set(graph.edges.map(e => e.metadata?.tagSource));
    for (const source of ['path', 'pattern', 'cluster'] as TagEdgeSource[]) {
      expect(usedSources.has(source)).toBe(true);
    }
    // The shape that broke the roll-up hash: a tagged edge with no source at all.
    expect(usedSources.has(undefined)).toBe(true);
  });

  // ── which package owns a module ──

  it('answers the package of a module with a node id or with nothing', () => {
    const { graph } = fixture();
    expect(modulePackageId(graph, OWNED)).toBe(PKG);
    expect(modulePackageId(graph, LOOSE)).toBeUndefined();
    expect(packageModuleIds(graph, PKG).sort()).toEqual([OWNED, PATTERN_MATCHED, TYPE_ONLY_IMPORTER].sort());
  });

  it('never publishes a package name the graph cannot resolve', async () => {
    const { graph, snapshot } = fixture();
    const result = await mapContextModules(graph, snapshot);
    const byPackage = result.byPackage as Record<string, unknown>;
    // Every key is a package node that exists. `unknown` used to sit here beside `pkg:app`,
    // indistinguishable in form from a real id and resolvable as nothing.
    for (const key of Object.keys(byPackage)) {
      expect(graph.nodes.get(key)?.type).toBe('package');
    }
    // The modules the graph cannot place are named, not dropped and not invented a package for.
    const withoutPackage = result.withoutPackage as Array<{ id: string }>;
    expect(withoutPackage.map(m => m.id)).toEqual([LOOSE]);
  });

  it('moves one module between the two lists when its package edge moves', async () => {
    const before = fixture();
    const after = fixture({ adoptLoose: true });
    const b = await mapContextModules(before.graph, before.snapshot);
    const a = await mapContextModules(after.graph, after.snapshot);

    const countIn = (r: Record<string, unknown>) =>
      Object.values(r.byPackage as Record<string, unknown[]>).reduce((n, list) => n + list.length, 0);
    expect(countIn(a) - countIn(b)).toBe(1);
    expect(((b.withoutPackage as unknown[]) ?? []).length - ((a.withoutPackage as unknown[] | undefined) ?? []).length).toBe(1);
  });

  // ── which domains a node is in, and which nodes a domain holds ──

  it('answers domain membership from one walk, in both directions', () => {
    const { graph } = fixture();
    expect(taggedDomains(graph, OWNED).ids).toEqual([DOMAIN, SUBDOMAIN]);
    expect(taggedDomains(graph, OWNED).labels).toEqual(['shared', 'shared/sub']);
    expect(isTaggedInto(graph, OWNED, DOMAIN)).toBe(true);
    expect(isTaggedInto(graph, DOCKERFILE, DOMAIN)).toBe(false);

    const members = domainMembers(graph, DOMAIN);
    expect(members.modules.sort()).toEqual([LOOSE, OWNED, PATTERN_MATCHED, TYPE_ONLY_IMPORTER].sort());
    expect(members.resources).toEqual([RESOURCE]);
    // The subdomain node tags into its parent, so `all` is wider than modules plus resources.
    expect(members.all.length).toBe(members.modules.length + members.resources.length + 1);
  });

  it('reports a member count the member list can account for', async () => {
    const { graph, snapshot } = fixture();
    const result = await mapContextModules(graph, snapshot);
    const listed = Object.values(result.byPackage as Record<string, unknown[]>).flat().length
      + ((result.withoutPackage as unknown[] | undefined)?.length ?? 0);
    // `taggedModules` counted the resource and the subdomain node while the listing below it
    // filtered them out, so one response said 11 and showed 2.
    expect(result.taggedModules).toBe(listed);
    expect(result.taggedNonModuleCount).toBe(2);
  });

  // ── the tag-source partitions stay three ──

  it('classifies every tag source, including an edge that carries none', () => {
    // Written out rather than derived from TAG_EDGE_SOURCES: a table computed from the list cannot
    // fail when the list grows, and every partition here has a silent default. A new source has to
    // be classified here by hand, which is the point — `isAuthoredTag` is an exclusion, so an
    // unclassified source would fold into the path-only roll-up hash without anyone deciding it.
    const EXPECTED: Record<string, { primary: boolean; pattern: boolean; authored: boolean }> = {
      path: { primary: true, pattern: false, authored: true },
      package: { primary: true, pattern: false, authored: false },
      cluster: { primary: true, pattern: false, authored: false },
      pattern: { primary: false, pattern: true, authored: true },
      '(none)': { primary: true, pattern: false, authored: true },
    };

    const edgeWith = (tagSource: TagEdgeSource | undefined) =>
      (tagSource ? { from: 'a', to: 'b', kind: 'tagged' as const, metadata: { tagSource } }
        : { from: 'a', to: 'b', kind: 'tagged' as const });

    // Totality both ways: every declared source is in the table, and the table names no source that
    // is not declared.
    expect(Object.keys(EXPECTED).sort()).toEqual([...TAG_EDGE_SOURCES, '(none)'].sort());

    for (const [key, expected] of Object.entries(EXPECTED)) {
      const edge = edgeWith(key === '(none)' ? undefined : key as TagEdgeSource);
      expect({ key, primary: isPrimaryTag(edge), pattern: isPatternTag(edge), authored: isAuthoredTag(edge) })
        .toEqual({ key, ...expected });
    }

    // The three disagree pairwise, which is what makes them three questions rather than one with a
    // flag. Collapsing any pair makes one of these fail.
    const rows = Object.values(EXPECTED);
    expect(rows.some(r => r.primary !== r.pattern)).toBe(true);
    expect(rows.some(r => r.primary !== r.authored)).toBe(true);
    expect(rows.some(r => r.pattern !== r.authored)).toBe(true);
  });

  it('moves a domain roll-up hash when a member with no tag source moves', () => {
    const a = fixture({ ownedHash: 'owned-h1' });
    const b = fixture({ ownedHash: 'owned-h2' });
    const hashOf = (f: { graph: RepositoryGraph; snapshot: RepositoryFactsSnapshot }, id: string) =>
      resolveDomainContentHash(f.graph, f.snapshot, id, DEFAULT_PROPAGATION_CONFIG);

    // The subdomain's only member is tagged without a source. Under an inclusion list of
    // path/pattern it had no members at all, hashed to the empty sentinel, and its annotation could
    // never go stale — on this repository that was every subdomain.
    expect(hashOf(a, SUBDOMAIN)).not.toBe('empty');
    expect(hashOf(a, SUBDOMAIN)).not.toBe(hashOf(b, SUBDOMAIN));
    expect(hashOf(a, DOMAIN)).not.toBe(hashOf(b, DOMAIN));
  });

  // ── how much comes in ──

  it('keeps the import counters distinct, because they answer different questions', () => {
    const { graph } = fixture();
    // OWNED has one runtime importer and one type-only importer, plus a tag and an infra edge.
    const queue = importerCount(graph, OWNED);
    const architecture = runtimeFanIn(graph, OWNED);
    const ranking = (graph.inEdges.get(OWNED) ?? []).filter(e => e.kind !== 'contains').length;

    expect(queue).toBe(2);
    expect(architecture).toBe(1);
    expect(ranking).toBe(3);
    // Three numbers for one node. Merging any pair collapses one of these, which is the knowledge
    // this law exists to keep: the queue would stop seeing a type-only importer, and search ranking
    // would stop scoring nodes that carry no `imports` edge at all.
    expect(new Set([queue, architecture, ranking]).size).toBe(3);
  });

  // ── edge existence ──

  it('answers edge existence for every declared edge kind', () => {
    const { graph } = fixture();
    for (const kind of EDGE_KINDS) {
      // Totality: the predicate takes any kind. A kind added to EDGE_KINDS arrives here.
      expect(hasEdge(graph, OWNED, kind, 'mod:absent')).toBe(false);
    }
    expect(hasEdge(graph, OWNED, 'tagged', DOMAIN)).toBe(true);
    expect(hasEdge(graph, OWNED, 'imports', DOMAIN)).toBe(false);
    expect(hasEdge(graph, DOMAIN, 'tagged', OWNED)).toBe(false);
  });

  // ── what a runtime resource dispatches into ──

  it('separates everything a resource is wired to from the code it dispatches into', () => {
    const { graph } = fixture();
    expect(infraTargetIds(graph, RESOURCE)).toEqual([DOCKERFILE, OWNED]);
    expect(handlerModuleIds(graph, RESOURCE)).toEqual([OWNED]);
    expect(isWitnessedNode(graph, RESOURCE)).toBe(true);
    expect(isWitnessedNode(graph, 'resource:absent')).toBe(false);
  });

  // ── the domain id pair ──

  it('mints, strips and tests a domain id in one place', () => {
    expect(domainNodeId('shared')).toBe(DOMAIN);
    expect(domainLabelFromId(DOMAIN)).toBe('shared');
    expect(domainLabelFromId('shared')).toBe('shared');
    expect(isDomainNodeId(DOMAIN)).toBe(true);
    expect(isDomainNodeId(OWNED)).toBe(false);

    // The mint is unconditional and the strip is total, so a caller holding either form composes
    // them. Folding the coercion into the mint would merge a domain configured as `domain:shared`
    // into the domain named `shared`, which is a different set of members.
    expect(domainNodeId(domainLabelFromId(DOMAIN))).toBe(DOMAIN);
    expect(domainNodeId('domain:shared')).toBe('domain:domain:shared');
  });

  // ── text guards ──
  //
  // What these guards see: the literal shapes the removed copies were written in. What they do not
  // see: a copy assembled through intermediate variables, hidden behind a local alias, or reached
  // by optional chaining on a different receiver. Those are covered only by the agreement checks
  // above, and only once they disagree. `mod.packageName` is deliberately outside every guard: it
  // answers the same question from the stage-1 record rather than from the graph, and reconciling
  // the two sources is a decision, not a de-duplication.

  /**
   * Bodies that differ only in the names they use are the same implementation written twice.
   *
   * The four guards below are aimed at the shape each removed copy was written in, so a copy that
   * comes back under another name in another file passes them — that is exactly how two
   * byte-identical copies survived this stage's first pass. This one asks a different question: it
   * normalises every function body in `src/` (identifiers to a placeholder, whitespace collapsed,
   * literals kept, because the literal is what distinguishes one graph question from another) and
   * fails when two bodies in different declarations normalise the same.
   *
   * What it does not catch: a copy that reorders statements, splits one expression across
   * intermediate variables, or inlines a helper call. Literals are deliberately kept, so two
   * traversals that differ only in an edge kind are not reported — they are different questions.
   */
  it('holds no two function bodies that differ only in their names', () => {
    const project = makeProject(repoRoot());
    const files = project.addSourceFilesAtPaths(path.join(repoRoot(), 'src/**/*.ts').replace(/\\/g, '/'));

    // Bodies smaller than this are shared by construction — a one-line getter or a `return x` says
    // nothing about who owns the question.
    const MIN_NORMALISED_LENGTH = 60;

    /**
     * Declarations that share a body today, each with what holds it there.
     *
     * This is a work queue, not a silencer. An entry says either why the two must stay separate or
     * which class already owns the merge; a pair with neither has no business being here. A new
     * duplicate fails the law on the day it is written, which is the whole point — the entries below
     * were found by this guard on the day it was added, and every one of them predates it.
     */
    const ALLOWED: Array<{ names: string[]; why: string }> = [
      // Path spellings, the kebab chain, and the hash recipe are gone: one `repoRelativePosix`,
      // one `domainSlug`, one `sha256Hex`. The one pair left on this axis answers two questions.
      { names: ['pathToSlug', 'slug'], why: 'package name of a manifest-less directory, per source plugin: the two ecosystems agree today and each owns its own naming rules' },
      // Asset rendering: one projection written twice, no stage owns it yet.
      { names: ['replaceMarkedAgentsMdSection', 'replaceMarkedSection'], why: 'managed-block replacement written once per renderer' },
      { names: ['looksLikeRepoContextAgentsMd', 'looksLikeRepoContextAgentsMd'], why: 'same predicate in two renderers' },
      { names: ['renderedAssetPath', 'renderedAssetPath'], why: 'same path derivation in two renderers' },
    ];

    /**
     * Erase the names a body invented for itself, keep every name it borrowed.
     *
     * An identifier is replaced only when it is declared inside the function — a parameter or a
     * local. Anything free (an imported helper, a module-level constant, a property) survives,
     * because that is what decides which question the body answers: the two domain roll-up hashes
     * differ by one predicate passed as an argument and by nothing else.
     */
    const normalise = (fn: Node, body: Node): string => {
      const bodyStart = body.getStart();
      const replacements: Array<{ start: number; end: number }> = [];
      for (const id of body.getDescendantsOfKind(SyntaxKind.Identifier)) {
        const parent = id.getParent();
        if (parent && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) continue;
        const declaredInside = (id.getSymbol()?.getDeclarations() ?? []).some(decl => {
          return decl.getStart() >= fn.getStart() && decl.getEnd() <= fn.getEnd();
        });
        if (declaredInside) replacements.push({ start: id.getStart() - bodyStart, end: id.getEnd() - bodyStart });
      }
      let text = body.getText();
      for (const { start, end } of replacements.sort((a, b) => b.start - a.start)) {
        text = `${text.slice(0, start)}_${text.slice(end)}`;
      }
      return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/\s+/g, '');
    };

    const byBody = new Map<string, string[]>();
    for (const file of files) {
      const rel = path.relative(repoRoot(), file.getFilePath());
      for (const fn of [...file.getFunctions(), ...file.getDescendantsOfKind(SyntaxKind.MethodDeclaration)]) {
        const body = fn.getBody();
        const name = fn.getSymbol()?.getName();
        if (!body || !name) continue;
        const key = normalise(fn, body);
        if (key.length < MIN_NORMALISED_LENGTH) continue;
        const holders = byBody.get(key) ?? [];
        holders.push(`${name} (${rel}:${fn.getStartLineNumber()})`);
        byBody.set(key, holders);
      }
    }

    const allowedNameSets = ALLOWED.map(entry => entry.names.slice().sort().join('|'));
    const duplicates = [...byBody.values()]
      .filter(holders => holders.length > 1)
      .filter(holders => {
        const names = holders.map(h => h.split(' ')[0]).sort().join('|');
        return !allowedNameSets.includes(names);
      })
      .map(holders => holders.join('  ==  '));

    expect(duplicates).toEqual([]);
  });

  it('enumerates a node type in one place', () => {
    // Five spellings of "the type index may be absent" were the whole difference between the call
    // sites: `?? []`, a spread, an `if (set)` guard, an early return and a ternary.
    const shape = /\.byType\.get\(/;
    const offenders = otherSourceLines([GRAPH_INDEX, path.join('src', 'graph', 'mutate.ts')])
      .filter(row => shape.test(row.line))
      // Pruning removes a node from the index; that is a write, not an enumeration.
      .filter(row => !row.line.includes('.delete('))
      .map(row => `${row.rel}:${row.number}`);
    expect(offenders).toEqual([]);
  });

  it('falls back from a missing label in one place', () => {
    // Three fallback families existed — the id, a file path, a domain label — and the first two
    // were written inline at every site. The named forms make the choice visible at the call.
    const shape = /\?\.label \?\? /;
    const offenders = otherSourceLines([GRAPH_INDEX])
      .filter(row => shape.test(row.line))
      // A path fallback answers a different question and says so by naming the path.
      .filter(row => !/pkgRelPath|repoRelPath|absPath|relativeFilePath|filePath/.test(row.line))
      .map(row => `${row.rel}:${row.number}`);
    expect(offenders).toEqual([]);
  });

  it('answers the graph-read helpers it declares', () => {
    const { graph } = fixture();
    expect(nodesOfType(graph, 'package')).toEqual([PKG]);
    expect(nodesOfType(graph, 'template')).toEqual([]);
    expect(countNodesOfType(graph, 'domain')).toBe(2);
    expect(isNodeType(graph, OWNED, 'module')).toBe(true);
    expect(isNodeType(graph, 'mod:absent', 'module')).toBe(false);
    expect(nodeLabel(graph, OWNED)).toBe('owned');
    expect(nodeLabel(graph, 'mod:absent')).toBe('mod:absent');
    expect(domainLabel(graph, DOMAIN)).toBe('shared');
    // A domain the graph no longer holds reads as the name it had, not as its id.
    expect(domainLabel(graph, 'domain:gone')).toBe('gone');
    expect(directImportTargets(graph, LOOSE)).toEqual([OWNED]);
    expect(edgeCount(graph, OWNED, 'imports', 'in')).toBe(2);
    expect(edgeCount(graph, OWNED, 'imports', 'out')).toBe(0);
    expect(edgeCount(graph, RESOURCE, 'infra', 'out')).toBe(2);
  });

  it('walks importers once for callers that reduce it differently', () => {
    const { graph } = fixture();
    const seen: Array<[string, string]> = [];
    walkImporters(graph, OWNED, 4, (importerId, parentId) => {
      seen.push([importerId, parentId]);
      return 'continue';
    });
    expect(seen.map(([id]) => id).sort()).toEqual([LOOSE, TYPE_ONLY_IMPORTER].sort());
    expect(seen.every(([, parent]) => parent === OWNED)).toBe(true);

    // `stop` ends the walk, which is what makes one traversal serve a boolean and a path.
    const visited: string[] = [];
    walkImporters(graph, OWNED, 4, (importerId) => {
      visited.push(importerId);
      return 'stop';
    });
    expect(visited).toHaveLength(1);

    // Depth zero visits nothing: the bound is on hops, not on the start node.
    const none: string[] = [];
    walkImporters(graph, OWNED, 0, (id) => { none.push(id); return 'continue'; });
    expect(none).toEqual([]);
  });

  it('walks graph adjacency in one place', () => {
    // The merge of two importer walks into `walkImporters` removes the copies but not the option of
    // writing a third by hand, and one hand-rolled walk is not a duplicate of anything, so the
    // body-hash check above cannot see it. This one reads the shape.
    //
    // What it does not cover: a walk that spells its queue differently, and the two downstream
    // walks named below — those follow imports outward and accumulate payloads (semantic-hint
    // targets, a path array) rather than reducing a reachability question, which is a different
    // traversal and belongs with the detector arithmetic.
    const DOWNSTREAM_WALKS = [
      path.join('src', 'analysis', 'architecture', 'detectors.ts'),
      path.join('src', 'analysis', 'architecture', 'heuristics.ts'),
    ];
    const shape = /const queue: Array<\{ id: string; (depth: number|path: string\[\]) \}>/;
    const offenders = otherSourceLines([GRAPH_INDEX, ...DOWNSTREAM_WALKS])
      .filter(row => shape.test(row.line))
      .map(row => `${row.rel}:${row.number}`);
    expect(offenders).toEqual([]);
  });

  it('resolves the owning package in one place', () => {
    // The shape all six copies shared: a `contains` in-edge filtered by the `pkg:` prefix.
    const shape = /kind === 'contains'\s*&&\s*\w+\.from\.startsWith\('pkg:'\)/;
    const offenders = otherSourceLines([GRAPH_INDEX])
      .filter(row => shape.test(row.line))
      .map(row => `${row.rel}:${row.number}`);
    expect(offenders).toEqual([]);
  });

  it('builds and strips the domain prefix in one place', () => {
    // Three spellings existed for the strip alone: slice('domain:'.length), slice(7), and a regexp.
    const mint = /`domain:\$\{/;
    const strip = /\.replace\(\/\^domain:\/|\.slice\('domain:'\.length\)/;
    const offenders = otherSourceLines([NODE_IDS])
      .filter(row => mint.test(row.line) || strip.test(row.line))
      .map(row => `${row.rel}:${row.number}`);
    expect(offenders).toEqual([]);
  });

  it('tests edge existence in one place', () => {
    // The one-liner eight builders carried, each with its kind baked into the body.
    const shape = /\.some\(\w+ => \w+\.kind === '\w+' && \w+\.to === /;
    const offenders = otherSourceLines([GRAPH_INDEX])
      .filter(row => shape.test(row.line))
      .map(row => `${row.rel}:${row.number}`);
    expect(offenders).toEqual([]);
  });

  it('walks tagged edges for membership in one place', () => {
    // A `tagged` comparison outside the graph module is either a partition of the tag source (all
    // of which live in the graph module) or a second membership walk. The producers are exempt:
    // writing an edge is not asking about one.
    const shape = /kind === 'tagged'|kind !== 'tagged'/;
    const offenders = otherSourceLines([GRAPH_INDEX])
      .filter(row => shape.test(row.line) && !row.line.includes('addEdge('))
      .map(row => `${row.rel}:${row.number}`);
    expect(offenders).toEqual([]);
  });
});
