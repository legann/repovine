import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeFiles, codeLines, guardedRoots, repoRoot, sourceFiles } from './graph-law-helpers.js';
import { toPosixPath } from '../../src/platform/paths.js';
import {
  REFUSAL_REASONS,
  delivered,
  deliveredValue,
  isRefused,
  publishedRefusalMessage,
  refusal,
  refused,
  type Outcome,
} from '../../src/response/refusal.js';
import { EMPTY_DIAGNOSTIC_REASONS, SCOPE_UNRESOLVED } from '../../src/response/empty-reason.js';
import { readNodeBody, refusalPath } from '../../src/mcp/lib/node-body.js';
import { analyzeImpact } from '../../src/mcp/lib/dependencies/impact.js';
import { outsideRepoRefusal } from '../../src/stage1/index.js';
import { buildRefusalReport, outsideRepoReport } from '../../src/mcp/lib/refresh-summary.js';
import { addNode, createEmptyGraph } from '../../src/graph/index.js';
import { lawRuntime } from './graph-law-helpers.js';
import type { ModuleInfo, RepositoryFactsSnapshot } from '../../src/types.js';

/**
 * An expected failure has one form inside the engine, `throw` is left to programmer error, and a
 * refusal the build made is not lost to a silenced log.
 *
 * Every guard below is predicated on a rollback that COMPILES: a guard that only fails because the
 * tree stopped typechecking has proved nothing about the rollback it was written for.
 *
 * SCOPE OF THIS LAW. Stage 11 converted the engine perimeter a refusal reaches a reader through —
 * `src/response`, `src/mcp`, `src/stage1`, `src/stage2`, `src/context-quality` — and the guards are
 * aimed there. `src/cli`, `src/agents`, `src/annotations`, `src/source-plugins` and `src/iac-plugins`
 * still spell expected failures their own way; each exemption below says which one and what has to
 * be true before it comes off.
 */

const SRC = path.join(repoRoot(), 'src');

/** The directories stage 11 converted; guards below read only these. */
const CONVERTED_ROOTS = ['src/response', 'src/mcp', 'src/stage1', 'src/stage2', 'src/context-quality'];

/** A file's code with comment lines dropped, so no guard below is satisfiable by prose. */
function fileText(rel: string): string {
  return fs.readFileSync(path.join(repoRoot(), rel), 'utf8').split('\n')
    .filter(line => {
      const t = line.trim();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
    })
    .join('\n');
}

/** Files under a directory, repo-relative and POSIX-normalized. */
function filesUnder(rel: string): string[] {
  const dir = path.join(repoRoot(), rel);
  if (!fs.existsSync(dir)) return [];
  return [...sourceFiles(dir)].map(f => toPosixPath(path.relative(repoRoot(), f)));
}

describe('refusal form: one declaration', () => {
  it('declares the outcome union and the refusal in exactly one module', () => {
    const declarations = codeLines([])
      .filter(l => /export (?:type Outcome\b|interface Refusal\b|const REFUSAL_REASONS\b)/.test(l.text))
      .map(l => l.where.split(':')[0]);

    expect([...new Set(declarations)]).toEqual(['src/response/refusal.ts']);
    expect(declarations).toHaveLength(3);
  });

  it('keeps every accessor of the form on the form, so a consumer never re-derives one', () => {
    // isFreshVerdict shipped as a predicate over the one already-discriminated union in the engine
    // and has zero callers: both consumers wrote `.state === 'fresh'` by hand. The accessors here
    // are pinned as reachable so the same thing does not happen to this union.
    expect(isRefused(refused('not-found', 'probe', 'x'))).toBe(true);
    expect(isRefused(delivered(1))).toBe(false);
    expect(deliveredValue(delivered(7))).toBe(7);
    expect(() => deliveredValue(refused('not-found', 'probe', 'gone'))).toThrow(/refusal: not-found/);
    expect(refusal('unreadable', 'probe', 'm', { a: 1 })).toEqual({
      reason: 'unreadable',
      kind: 'probe',
      message: 'm',
      details: { a: 1 },
    });
  });

  it('produces every reason it declares, from a call that makes a refusal', () => {
    // A vocabulary with an unused member is a name nobody had to choose between, and the next site
    // adds a synonym instead of picking one. Anchored to `refused(`/`refusal(` rather than to the
    // string anywhere in src: an unrelated literal elsewhere in the engine would otherwise keep a
    // dead member alive, which is how this check first passed while four members had no producer.
    const text = codeFiles(['src/response/refusal.ts']).map(f => f.text).join(' ');
    const unproduced = REFUSAL_REASONS.filter(reason =>
      !new RegExp(`\\brefus(?:ed|al)\\(\\s*['"\`]${reason}['"\`]`).test(text));

    expect(unproduced).toEqual([]);
  });

  it('shares no member with the emptiness vocabulary', () => {
    // Emptiness answers the request; a refusal declines it. One name in both would let a site
    // report either fact with the same string and no reader could tell which happened.
    const shared = (REFUSAL_REASONS as readonly string[])
      .filter(r => (EMPTY_DIAGNOSTIC_REASONS as readonly string[]).includes(r));

    expect(shared).toEqual([]);
  });
});

describe('refusal form: no second spelling in the converted perimeter', () => {
  // Directories stage 11 converted. Everything else is listed as an exemption below with the
  // condition that takes it off.
  const CONVERTED = CONVERTED_ROOTS;

  /**
   * Modules inside the converted perimeter that still spell a failure their own way, each with the
   * reason and what has to be true before the entry comes off.
   */
  /**
   * Modules inside the converted perimeter that still spell a failure their own way, each with the
   * reason and the condition that takes the entry off. Every entry is load-bearing: the check below
   * removes each one in turn and fails if the guards stay green without it, so an exemption cannot
   * outlive the form it was written for.
   */
  const EXEMPT = [
    // `annotateModule` returns `T | {error}` at eleven sites, and `cleanupOrphanedAnnotations` at
    // one. They belong to the annotations layer reached through mcp/lib and convert with
    // `src/annotations`, in one change, so the write path and its readers never disagree.
    'src/mcp/lib/annotations.ts',
    // Domain-map catches the pagination throws and re-encodes them as `{error}`. Comes off with the
    // scope vocabulary: `kind:'unknown'` in SCOPE_KINDS is the same decision, and stage 4 owns it.
    'src/mcp/lib/domain-map.ts',
    // `inspect-node-core` returns `{error}` for a bad bodyLimit and for a node id the graph does not
    // hold. Comes off when `buildInspectNodeDetail` returns an `Outcome`, which is a change to what
    // the handler builds its envelope from.
    'src/mcp/lib/inspect-node-core.ts',
    // A long-running build's lifecycle (`building`/`ready`/`failed`/`cancelled`) is polled, not
    // branched on once. Comes off if cancellation joins the refusal vocabulary — stage 11 left
    // cancellation out on purpose, as a fact neither a refusal nor an emptiness carries.
    'src/mcp/build-controller.ts',
    // `semanticSearch` reports a background sync with a per-state row count a refusal has no slot
    // for. Comes off when the refusal form carries counts, or when the sync reports through the sink.
    'src/mcp/types.ts',
    'src/mcp/lib/refresh-summary.ts',
    // Semantic ranking degrades to lexical and says which way; the payload differs per state. Same
    // condition as `semanticSearch` above.
    'src/mcp/tools/search-context.ts',
  ];



  /** The three forms the audit named, minus the one that became canonical. */
  const SECOND_SPELLINGS: Array<{ what: string; re: RegExp }> = [
    { what: 'bare {error} return', re: /(?:return|=>)\s*\(?\s*\{\s*error\s*:/ },
    { what: 'ok-discriminated outcome', re: /\bok\s*:\s*(?:true|false|boolean)\s*[;,}]/ },
    { what: 'status failure literal', re: /\bstatus\s*:\s*['"`](?:failed|error)['"`]/ },
  ];

  function offenders(exempt: readonly string[]): string[] {
    return codeFiles(exempt)
      .filter(f => CONVERTED.some(dir => f.where.startsWith(`${dir}/`)))
      .filter(f => f.where !== 'src/response/refusal.ts')
      .filter(f => SECOND_SPELLINGS.some(s => s.re.test(f.text)))
      .map(f => f.where);
  }

  it('has no unlisted module spelling a failure any of the audit\'s other three ways', () => {
    expect(offenders(EXEMPT)).toEqual([]);
  });

  it('every exemption is load-bearing and names a module that exists', () => {
    // An exemption that holds nothing is legacy in the guard: it reads as a waiver a maintainer
    // weighed, and it blanket-waives its file against every future tightening of the regexps.
    // The first edition of this list had 34 entries, 31 of which the guards never reached.
    for (const rel of EXEMPT) {
      expect(fs.existsSync(path.join(repoRoot(), rel))).toBe(true);
      expect(offenders(EXEMPT.filter(e => e !== rel))).toEqual([rel]);
    }
  });

  it('covers the whole converted perimeter, so an added file is guarded by default', () => {
    // The list of guarded directories is pinned, not derived: an empty list would pass every check
    // above without reading a single file.
    for (const dir of CONVERTED) expect(filesUnder(dir).length).toBeGreaterThan(0);
    expect(filesUnder('src/response')).toContain('src/response/refusal.ts');
  });
});

describe('refusal form: the published spelling has one reader', () => {
  it('leaves no subsystem sniffing a published response for a string error field', () => {
    // `context-quality/metrics.ts` duck-typed `{error: string}` across a module boundary with no
    // type link, so a change to the published shape would have zeroed the metric with no compile
    // error. Rollback: restore `typeof value.error === 'string'` there — it compiles.
    //
    // Scoped to subsystems that read an ALREADY-PUBLISHED response. A handler reading the `{error}`
    // its own un-converted producer returned is the perimeter guard's business, not this one's.
    // Matches the dotted access, the optional chain and the cast — the three ways this predicate
    // would actually be written against a response typed `unknown`, and the two the first edition
    // of this guard could not see.
    const offenders = codeFiles(['src/response/refusal.ts'])
      .filter(f => f.where.startsWith('src/context-quality/') || f.where.startsWith('src/agents/'))
      .filter(f => /typeof\s+[^;]{0,80}?\berror\b\s*===\s*['"`]string['"`]/.test(f.text))
      .map(f => f.where);

    expect(offenders).toEqual([]);
  });

  it('reads the published refusal through the declared reader', () => {
    expect(publishedRefusalMessage({ result: { error: 'refused' } })).toBe('refused');
    expect(publishedRefusalMessage({ result: { value: 1 } })).toBeUndefined();
    expect(publishedRefusalMessage({ error: 'top level is not the slot' })).toBeUndefined();
    expect(publishedRefusalMessage(null)).toBeUndefined();
  });

  it('names the one emptiness reason another subsystem matches on in a single module', () => {
    // Rollback: retype `'scope_unresolved'` as a literal in metrics.ts — it compiles, and the
    // rename that follows it would not.
    // Every quoting style: the first edition matched single quotes only, so retyping the member as
    // `"scope_unresolved"` — which nothing in the repo forbids — passed the guard written to make
    // that exact retype impossible.
    const sites = codeLines([])
      .filter(l => /['"`]scope_unresolved['"`]/.test(l.text))
      .map(l => l.where.split(':')[0]);

    expect([...new Set(sites)]).toEqual(['src/response/empty-reason.ts']);
    expect(SCOPE_UNRESOLVED).toBe('scope_unresolved');
  });
});

describe('refusal form: undefined does not mean "could not"', () => {
  const outsideRepo = path.join(path.sep === '/' ? '/' : 'C:\\', 'elsewhere', 'secret.ts');

  function moduleGraph(id: string, filePath: string) {
    const graph = createEmptyGraph();
    addNode(graph, { id, type: 'module', label: id, data: {} } as never);
    const mod = { id, filePath, relativeFilePath: 'src/x.ts', exports: [] } as unknown as ModuleInfo;
    return { graph, modulesById: new Map<string, ModuleInfo>([[id, mod]]) };
  }

  it('answers a body it may not read with a refusal that carries the reason', async () => {
    // Before: `{ error: string }`, indistinguishable at the type level from a body with no lines.
    // Rollback: change the reason to `'unreadable'` — it compiles and loses the fact that a policy,
    // not the filesystem, refused.
    const { graph, modulesById } = moduleGraph('mod:repo/src/x', outsideRepo);
    const outcome = await readNodeBody(graph, modulesById, path.join(path.sep === '/' ? '/' : 'C:\\', 'repo'), 'mod:repo/src/x', 'module');

    expect(isRefused(outcome)).toBe(true);
    if (!isRefused(outcome)) return;
    expect(outcome.refusal.reason).toBe('rejected-by-policy');
    expect(outcome.refusal.message).toContain('outside repo root');
  });

  it('answers an id the graph does not hold with a refusal, not an empty analysis', async () => {
    const graph = createEmptyGraph();
    const outcome: Outcome<unknown> = analyzeImpact(lawRuntime(graph), { nodeId: 'mod:repo/src/nope' });

    expect(isRefused(outcome)).toBe(true);
    if (!isRefused(outcome)) return;
    expect(outcome.refusal.reason).toBe('not-found');
    expect(outcome.refusal.details).toEqual({ nodeId: 'mod:repo/src/nope' });
  });

  it('answers a scope that resolved but names no graph node with a refusal, not an exception', () => {
    // Reachable, and by the ordinary route: `resolveModulePathAlias` answers a path-shaped scope
    // out of `modulesById` without asking whether the graph holds the id, so a module composition
    // dropped resolves to `kind:'module'` and then finds no node. An earlier edition of this stage
    // called the branch unreachable by reading the call site's shape instead of the argument that
    // arrives at it, and routed it through `deliveredValue` — which would trade a scoped answer for
    // the wrapper's own sentence under scope `all`. Rollback: put `deliveredValue` back.
    const handler = fileText('src/mcp/tools/analyze-dependencies.ts');

    expect(handler).toContain('if (isRefused(impact)) return dependencyRefusal(');
    expect(handler).toContain('if (isRefused(callgraph)) return dependencyRefusal(');
    expect(handler).not.toContain('deliveredValue(');
    // The resolver this depends on: a module id taken from the snapshot, unverified against the graph.
    expect(fileText('src/mcp/scope/resolve.ts')).toMatch(/export function resolveModulePathAlias[\s\S]{0,700}return mod\.id;/);
  });

  it('separates a delivered empty answer from a refusal', () => {
    // Emptiness stays emptiness: a graph with the node but nothing around it delivers a value.
    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:repo/src/lonely', type: 'module', label: 'lonely', data: {} } as never);
    const outcome: Outcome<unknown> = analyzeImpact(lawRuntime(graph), { nodeId: 'mod:repo/src/lonely' });

    expect(isRefused(outcome)).toBe(false);
    expect(deliveredValue(outcome)).toMatchObject({ downstream: [], upstream: [] });
  });
});

describe('refusal form: what the build refused is delivered', () => {
  // Two refusals, and the other one carries a count and a sample too. A reader that picks the
  // containment entry by the shape of its details rather than by its declared kind picks this one.
  const conflict = refusal('conflict', 'file-claimed-twice', '2 file(s) were claimed by two source plugins.', { count: 2, sample: ['a.ts', 'b.ts'] });

  const snapshotWith = (paths: string[]): RepositoryFactsSnapshot => ({
    repoRoot: '/repo',
    timestamp: '2026-07-27T00:00:00.000Z',
    modules: [],
    packages: [],
    buildRefusals: [conflict, outsideRepoRefusal(paths)],
  });

  it('records a build refusal on the snapshot, where a silenced log is not the only channel', () => {
    const report = buildRefusalReport(snapshotWith(['src/leak.ts']));

    expect(report).toHaveLength(2);
    expect(report?.map(r => r.kind)).toEqual(['file-claimed-twice', 'outside-workspace']);
    expect(report?.[1]?.reason).toBe('rejected-by-policy');
    expect(report?.[1]?.message).toContain('absent from the graph');
  });

  it('carries composition refusals across the isolate boundary', () => {
    // Stage 2 runs in a worker over a structured clone of the snapshot, so a refusal written onto
    // that argument is dropped at the boundary — silently, and for the one producer whose only
    // other channel is a log the worker itself mutes. Rollback: post `refusals: []` from the
    // worker — it compiles, and the sink goes empty on the path every installed package takes.
    const worker = fileText('src/stage2/worker.ts');
    const compose = fileText('src/stage2/index.ts');
    const parent = fileText('src/mcp/context.ts');

    expect(worker).toContain('refusals: getComposedRefusals(graph)');
    expect(compose).toContain('rememberComposedRefusals(result.graph, result.refusals ?? [])');
    expect(parent).toContain('getComposedRefusals(graph)');
    // Written on the parent's snapshot, not on the argument compose was handed.
    expect(compose).not.toMatch(/snapshot\.buildRefusals\s*=/);
  });

  it('carries the sink onto the snapshot the build publishes', () => {
    // The sink only helps if discovery actually writes it. Rollback: drop the spread in
    // `buildSnapshot` — it compiles, and every reader below keeps passing on its own fixture.
    const assembly = fileText('src/stage1/index.ts');

    expect(assembly).toMatch(/buildRefusals\.length > 0 \? \{ buildRefusals \}/);
    expect(assembly).toContain('refusals.unshift(outsideRepoRefusal(outsideRepoPaths))');
    expect(assembly).toContain('FILE_CLAIMED_TWICE_REFUSAL');
    expect(assembly).toContain('SOURCE_PLUGIN_UNAVAILABLE_REFUSAL');
  });

  it('is absent, not empty, when the build refused nothing', () => {
    expect(buildRefusalReport({ repoRoot: '/repo', timestamp: 't', modules: [], packages: [] })).toBeUndefined();
    expect(buildRefusalReport({ repoRoot: '/repo', timestamp: 't', modules: [], packages: [], buildRefusals: [] }))
      .toBeUndefined();
  });

  it('composes the containment sentence once, where the paths were refused', () => {
    // The report used to re-derive the cause from a path list that had already lost the context it
    // was refused in. Rollback: rebuild the sentence inside `outsideRepoReport`.
    const report = outsideRepoReport(snapshotWith(['../shared/util.ts']))!;

    expect(report.warning).toBe(outsideRepoRefusal(['../shared/util.ts']).message);
    expect(report.count).toBe(1);
    // Picked by declared kind: the sibling refusal above sits first and carries the same details
    // shape, so a reader identifying it by that shape publishes the wrong one under `outsideRepo`.
    expect(report.sample).toEqual(['../shared/util.ts']);
  });

  it('publishes the sink on every surface that reports build state', () => {
    // `refresh_context`, `get_build_status` and `repovine status` each mute the pipeline log that
    // carries these facts. Rollback: delete any one of the three calls — it compiles.
    const readers = codeLines(['src/mcp/lib/refresh-summary.ts'])
      .filter(l => l.text.includes('buildRefusalReport('))
      .map(l => l.where.split(':')[0]);

    expect([...new Set(readers)].sort()).toEqual([
      'src/cli/health.ts',
      'src/mcp/lib/annotations.ts',
      'src/mcp/tools/build-status.ts',
    ]);
  });

  it('spells a path in the machine-readable slot the way every other repo-relative value is spelled', () => {
    // The sentence is read by a person and keeps the host's separators; `details` is read by a
    // program. Two producers of one field with two spellings is a reader that works until it meets
    // the other one — `readNodeBody` answered `src\\leak.ts` on win32 while stage 1 answered
    // `src/leak.ts` for the same file. A behavioural check cannot see this on a POSIX host, so the
    // guard is on how the value is built. Rollback: put `displayPath` back in the details slot.
    const offenders = codeLines([])
      .filter(l => CONVERTED_ROOTS.some(dir => l.where.startsWith(`${dir}/`)))
      .filter(l => /(?:path|sample)\s*:\s*(?:displayPath|path\.relative)\(/.test(l.text))
      .map(l => l.where);

    expect(offenders).toEqual([]);
    expect(fileText('src/mcp/lib/node-body.ts')).toMatch(/export function refusalPath[\s\S]{0,120}toPosixPath\(displayPath\(/);
    expect(refusalPath('/repo', '/repo/src/a/b.ts')).toBe('src/a/b.ts');
  });

  it('keeps a partial answer honest: a body it could not read is said in gaps', () => {
    // A containment refusal used to ride out as a field on a response marked successful, read by
    // nothing. Rollback: drop `gaps: partial` from the inspect_node envelope — it compiles.
    const handler = fileText('src/mcp/tools/inspect-node.ts');

    expect(handler).toContain('result.bodyError');
    expect(handler).toContain('result.grepError');
    expect(handler).toMatch(/gaps:\s*withheld/);
  });
});

describe('refusal form: throw stays for programmer error', () => {
  it('puts the one place the two conventions meet inside the module that owns the form', () => {
    // Read from code with comments stripped: a boundary asserted by a doc comment is a boundary a
    // reader can delete without turning anything red.
    const code = fileText('src/response/refusal.ts');
    const throwsHere = code.split('\n').filter(line => line.includes('throw '));

    expect(throwsHere).toHaveLength(1);
    expect(code).toMatch(/export function deliveredValue<T>\(outcome: Outcome<T>\): T \{/);
    expect(code.indexOf('throw ')).toBeGreaterThan(code.indexOf('export function deliveredValue'));
  });

  it('does not throw an expected failure out of a converted engine reader', async () => {
    // Rollback: make `readNodeBody` rethrow the errno instead of refusing — it compiles, and the
    // caller that has to keep going (inspect_node building a partial view) would crash the tool.
    const graph = createEmptyGraph();
    addNode(graph, { id: 'mod:repo/src/gone', type: 'module', label: 'gone', data: {} } as never);
    const missing = path.join(repoRoot(), 'src', '__no_such_file_for_the_law__.ts');
    const mod = { id: 'mod:repo/src/gone', filePath: missing, relativeFilePath: 'src/gone.ts', exports: [] } as unknown as ModuleInfo;

    const outcome = await readNodeBody(graph, new Map([['mod:repo/src/gone', mod]]), repoRoot(), 'mod:repo/src/gone', 'module');

    expect(isRefused(outcome)).toBe(true);
    if (!isRefused(outcome)) return;
    expect(outcome.refusal.reason).toBe('unreadable');
  });

  it('throws only where a refusal would have no caller to hand it to', () => {
    // `deliveredValue` is the one place the two conventions meet, and it is named as such.
    expect(() => deliveredValue({ ok: false, refusal: refusal('conflict', 'probe', 'held') }))
      .toThrow(/expected a delivered value/);
  });
});

describe('refusal form: guarded roots are real', () => {
  it('reads the engine and the SDK, so an empty sweep cannot pass', () => {
    // Both roots by name: a relocated SDK would make every text guard in this law stop reading it
    // with nothing turning red, which is the failure mode this check exists for.
    expect(guardedRoots().map(r => toPosixPath(path.relative(repoRoot(), r.dir))))
      .toEqual(['src', 'packages/plugin-sdk/src']);
    expect(fs.existsSync(SRC)).toBe(true);
    expect(codeLines([]).length).toBeGreaterThan(10_000);
    expect(codeFiles([]).length).toBeGreaterThan(200);
  });
});
