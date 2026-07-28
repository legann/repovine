/**
 * One form for "what to call next", one form for "why this came back empty" (L2).
 *
 * Steering an agent to its next call is one fact — which tool, which arguments, why now — and it had
 * grown five spellings: `{tool, args, reason}` on the envelope, `{tool, args}` under `attention`,
 * `{when?, tool?, args?, note?}` inside an empty diagnostic, a rendered `tool({json})` string in a
 * finding's detail, and prose in annotation health. Purpose is not what varies between them; the
 * delivery is. So the form is held to one type and one factory here, and each carrier keeps its own
 * slot and trigger.
 *
 * The same for emptiness: which branch answered, and whether a narrowing emptied a non-empty set or
 * there was nothing to begin with. That had eight copies of the scope-unresolved body, eight copies
 * of the graph-empty guard, six names for "a filter removed everything", and, in four tools, a gap
 * sentence beside a diagnostic message saying the same thing in different words.
 *
 * Two passes per tool over a real fixture: a read-only pass at repository scope, and a miss pass
 * whose arguments reach the branches that answer "nothing came back, and here is why". Between them
 * the two passes deliver two of the five carrier names below — the envelope's `navigation`, and the
 * `nextActions` a payload attaches to an empty diagnostic or to annotation health.
 *
 * The other three ship on branches no argument set here reaches. `attention[].next` is typed as a
 * next call by the response schema, which the envelope law in test/laws/mcp-envelope.test.ts parses
 * every response against. `nextAction` is written by the dispatcher above the handlers called here,
 * on the not-ready and missing-argument paths. A payload's `nextCalls` comes from a detail branch
 * that needs a finding id, and this fixture produces no findings. The text guards below reach those
 * three by shape instead of by execution: they read the source for a second spelling of the form.
 */
import { describe, expect, it, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepovineRuntime } from '../../src/mcp/context.js';
import { loadConfig } from '../../src/config.js';
import { toolDefs } from '../../src/mcp/tool-defs.js';
import { toolHandlers } from '../../src/mcp/tools/registry.js';
import { NextCallSchema } from '../../src/response/next-call.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';
import type { IndexBuildStatus } from '../../src/mcp/build-controller.js';
import { codeFiles, codeLines, findFixturesRoot } from './graph-law-helpers.js';

/** Every field name that carries a next call, wherever it sits in a response. */
const NEXT_CALL_FIELDS = ['navigation', 'nextActions', 'nextCalls', 'nextAction', 'next'];

/** Collect every next call in a response, with the path it arrived on. */
function nextCalls(value: unknown, trail: string[] = []): Array<{ path: string; call: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, i) => nextCalls(item, [...trail, String(i)]));
  if (typeof value !== 'object' || value === null) return [];
  const out: Array<{ path: string; call: unknown }> = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const here = [...trail, key];
    if (NEXT_CALL_FIELDS.includes(key)) {
      // `navigation` is five named sections of calls; the rest are a call or a list of them.
      const entries = key === 'navigation'
        ? Object.values(item as Record<string, unknown>).flatMap(section => Array.isArray(section) ? section : [])
        : Array.isArray(item) ? item : [item];
      for (const [i, call] of entries.entries()) out.push({ path: `${here.join('.')}[${i}]`, call });
      continue;
    }
    out.push(...nextCalls(item, here));
  }
  return out;
}

/** Every emptyDiagnostic in a response. */
function diagnostics(value: unknown, trail: string[] = []): Array<{ path: string; block: Record<string, unknown> }> {
  if (Array.isArray(value)) return value.flatMap((item, i) => diagnostics(item, [...trail, String(i)]));
  if (typeof value !== 'object' || value === null) return [];
  const out: Array<{ path: string; block: Record<string, unknown> }> = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'emptyDiagnostic' && typeof item === 'object' && item !== null) {
      out.push({ path: [...trail, key].join('.'), block: item as Record<string, unknown> });
      continue;
    }
    out.push(...diagnostics(item, [...trail, key]));
  }
  return out;
}

const READ_ONLY_ARGS: Record<string, Record<string, unknown>> = {
  search_context: { query: 'module' },
  map_context: { scope: 'all' },
  inspect_node: { scope: 'all' },
  get_entrypoints: {},
  trace_flow: { scope: 'all' },
  analyze_dependencies: { scope: 'all' },
  get_config_surface: { scope: 'all' },
  analyze_architecture: { scope: 'all' },
  get_annotation_status: { view: 'coverage' },
  get_annotation_merge_status: {},
  merge_annotations: {},
  validate_annotations: {},
  write_annotation: { nodeId: 'mod:absent/module', annotation: { summary: 'Never stored anywhere.' } },
  refresh_context: {},
  suggest_domains_config: {},
  decline_advisory: {},
  get_context_session_quality: { sessionId: 'law-session' },
  get_build_status: {},
};

/** The misses: every branch that answers "nothing came back, and here is why". */
function missArgs(packageId: string): Record<string, Record<string, unknown>> {
  return {
    search_context: { query: 'zzzqqq nosuchtoken anywhere' },
    map_context: { scope: packageId, limit: 1, offset: 100_000 },
    inspect_node: { nodeId: 'mod:absent/module' },
    get_entrypoints: { scope: 'zzz:not-a-scope' },
    trace_flow: { scope: 'zzz:not-a-scope' },
    analyze_dependencies: { scope: 'zzz:not-a-scope', mode: 'impact' },
    get_config_surface: { scope: packageId, namePattern: 'ZZZ_NO_SUCH_NAME' },
    analyze_architecture: { scope: 'zzz:not-a-scope' },
    get_annotation_status: { view: 'orphans' },
    get_annotation_merge_status: {},
    merge_annotations: {},
    validate_annotations: {},
    write_annotation: { nodeId: 'mod:absent/module', annotation: { summary: 'Never stored anywhere.' } },
    refresh_context: {},
    suggest_domains_config: {},
    decline_advisory: {},
    get_context_session_quality: { sessionId: 'law-session' },
    get_build_status: {},
  };
}

describe('core-laws next-call form (L2)', () => {
  let runtime: McpToolRuntime;
  let artifactsDir: string;
  let misses: Record<string, Record<string, unknown>>;
  const answers = new Map<string, unknown[]>();

  beforeAll(async () => {
    const fixtureRoot = path.join(findFixturesRoot(), 'basic-typescript');
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-next-call-law-'));
    const origLog = console.log;
    console.log = () => {};
    let ctx: RepovineRuntime;
    try {
      ctx = await RepovineRuntime.create(fixtureRoot, artifactsDir, loadConfig(fixtureRoot));
    } finally {
      console.log = origLog;
    }
    const ready = { status: 'ready', stage: 'ready', retryAfterSec: 0, message: 'Ready.' } as IndexBuildStatus;
    runtime = {
      repoRoot: fixtureRoot,
      getState: () => ctx.getState(),
      getConfig: () => loadConfig(fixtureRoot),
      refreshRepoState: () => {},
      build: {
        snapshot: () => ready,
        waitForSettled: async () => ready,
        cancel: async () => ready,
        readyState: () => ctx.getState(),
      },
    };
    const { graph } = ctx.getState();
    const packageId = [...(graph.byType.get('package') ?? [])].sort()[0];
    if (!packageId) throw new Error('Fixture has no package node to scope the miss pass to.');
    misses = missArgs(packageId);
  }, 120_000);

  afterAll(() => {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('covers every tool on both passes', () => {
    // A tool added without an entry here would otherwise be skipped in silence.
    expect(Object.keys(READ_ONLY_ARGS).sort()).toEqual(toolDefs.map(def => def.name).sort());
    expect(Object.keys(misses).sort()).toEqual(toolDefs.map(def => def.name).sort());
  });

  const responsesFor = async (name: string): Promise<unknown[]> => {
    const cached = answers.get(name);
    if (cached) return cached;
    const fresh = [
      await toolHandlers[name](runtime, READ_ONLY_ARGS[name]),
      await toolHandlers[name](runtime, misses[name]),
    ];
    answers.set(name, fresh);
    return fresh;
  };

  it.each(toolDefs.map(def => def.name))('%s answers next calls in one shape', async (name) => {
    const seen: string[] = [];
    for (const response of await responsesFor(name)) {
      for (const { path: at, call } of nextCalls(response)) {
        seen.push(at);
        const parsed = NextCallSchema.safeParse(call);
        expect({ at, ok: parsed.success, call }).toEqual({ at, ok: true, call });
      }
    }
    // Non-vacuous where steering exists. Three tools report state rather than narrow a scope:
    // `get_build_status` answers about the build, `get_context_session_quality` about a session, and
    // `decline_advisory` records a decision. Named, so the pass cannot go empty in silence.
    const stateOnly = new Set(['get_build_status', 'get_context_session_quality', 'decline_advisory']);
    if (!stateOnly.has(name)) expect(seen.length).toBeGreaterThan(0);
  });

  it.each(toolDefs.map(def => def.name))('%s states emptiness once, in one shape', async (name) => {
    for (const response of await responsesFor(name)) {
      const envelope = response as { gaps?: string[]; result?: unknown };
      for (const { path: at, block } of diagnostics(response)) {
        expect({ at, reason: typeof block.reason }).toEqual({ at, reason: 'string' });
        expect({ at, message: typeof block.message }).toEqual({ at, message: 'string' });
        expect({ at, actions: Array.isArray(block.nextActions) }).toEqual({ at, actions: true });
        // The gap is the diagnostic's own sentence — the second wording used to sit beside it.
        const gaps = envelope.gaps ?? [];
        const echoes = gaps.filter(gap => gap !== block.message && gap.includes(String(block.message).slice(0, 30)));
        expect({ at, echoes }).toEqual({ at, echoes: [] });
      }
    }
  });

  it('reaches a miss branch on the tools that have one', async () => {
    // Guards above are conditional on a diagnostic arriving; without this the pass could be empty.
    const withDiagnostic: string[] = [];
    for (const name of toolDefs.map(def => def.name)) {
      const found = (await responsesFor(name)).some(response => diagnostics(response).length > 0);
      if (found) withDiagnostic.push(name);
    }
    expect(withDiagnostic.sort()).toEqual([
      'analyze_architecture', 'analyze_dependencies', 'get_config_surface',
      'get_entrypoints', 'inspect_node', 'map_context', 'search_context', 'trace_flow',
    ]);
  });

  // ── One implementation, held by text ──

  it('builds the scope-unresolved body in one place', () => {
    const offenders = codeLines(['mcp/response/empty-diagnostics.ts'])
      .filter(line => /reason:\s*'scope_unresolved'/.test(line.text));
    expect(offenders).toEqual([]);
  });

  it('builds the filtered-out body in one place', () => {
    const offenders = codeLines(['mcp/response/empty-diagnostics.ts'])
      .filter(line => /reason:\s*'filtered_out'/.test(line.text));
    expect(offenders).toEqual([]);
  });

  it('asks whether the graph is empty in one place', () => {
    const offenders = codeLines(['mcp/response/empty-diagnostics.ts', 'mcp/scope/resolve.ts'])
      .filter(line => /graphIsEffectivelyEmpty\s*\(/.test(line.text));
    expect(offenders).toEqual([]);
  });

  it('keeps one factory for a next call', () => {
    // A hand-written `{ tool, args }` literal beside the factory is how the fifth spelling appeared.
    const offenders = codeLines(['response/next-call.ts'])
      .filter(line => /\{\s*tool:\s*'[a-z_]+',\s*args:/.test(line.text));
    expect(offenders).toEqual([]);
  });

  it('leaves no retired spelling of a next call', () => {
    // The factory guard above reads one line and matches one spelling, `{ tool: 'x', args: … }`. The
    // empty-diagnostic spelling this form replaced — `when` and `note` beside `tool` — walked past
    // it, and walked past it wherever it sat, including the three carriers the passes above never
    // reach. Whole-file text so a literal split across lines still reads as one; `[^{}]` keeps the
    // match inside a single brace level, so an `args` object nested in it cannot bridge two
    // unrelated literals; both key orders, because the retired shape wrote them either way.
    const retiredBeforeTool = /\{[^{}]*\b(?:when|note)\s*:[^{}]*\btool\s*:/;
    const retiredAfterTool = /\{[^{}]*\btool\s*:[^{}]*\b(?:when|note)\s*:/;
    const offenders: string[] = [];
    for (const file of codeFiles([])) {
      const hit = retiredBeforeTool.exec(file.text) ?? retiredAfterTool.exec(file.text);
      if (hit) offenders.push(`${file.where}: ${hit[0].replace(/\s+/g, ' ').trim()}`);
    }
    expect(offenders).toEqual([]);
  });

  it('leaves no second name for the narrowing that emptied a set', () => {
    const retired = /'(kind_filter_empty|name_pattern_empty|type_filter_excluded|weak_token_only_suppressed)'/;
    const offenders = codeLines([]).filter(line => retired.test(line.text));
    expect(offenders).toEqual([]);
  });

  it('holds the text guards above over a non-empty corpus', () => {
    // The guards read two corpora: the line guards call `codeLines`, the spelling guard calls
    // `codeFiles`. Counting one stands in for the other only while both walk the same roots, so
    // each is counted for itself and a root that stopped resolving reddens whichever it emptied.
    expect(codeFiles([]).length).toBeGreaterThan(200);
    expect(codeLines([]).length).toBeGreaterThan(20_000);
  });
});
