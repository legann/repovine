import { describe, expect, it, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepovineRuntime } from '../../src/mcp/context.js';
import { loadConfig } from '../../src/config.js';
import { toolDefs } from '../../src/mcp/tool-defs.js';
import { toolHandlers } from '../../src/mcp/tools/registry.js';
import { envelope, ToolResponseSchema } from '../../src/mcp/response/envelope.js';
import { TruncationMapSchema, TruncationSchema } from '../../src/response/truncation.js';
import { PROVENANCE_METHODS, ProvenanceSchema, provenance } from '../../src/response/provenance.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';
import type { IndexBuildStatus } from '../../src/mcp/build-controller.js';
import { findFixturesRoot } from './graph-law-helpers.js';
import { copyFixtureDirSync } from '../helpers/fixture-copy.js';

// The response contract. Input is described by a Zod schema per tool; for a long time the output was
// not described at all, and the shape drifted: two tools answered outside the envelope, the same
// build fact was named in two key registers, failure came back in three forms, and a bound on the
// answer had fourteen spellings. This holds every tool to one declared shape, one key convention and
// one way of saying "there is more", so the next tool cannot invent a nineteenth.
//
// Two passes per tool. The first answers at repository scope; the second is scoped to a real node,
// because several tools never build a node view at repository scope — the branch that carries the
// most keys, and the one this law did not see while the first pass was the only one.
//
// Reads only. Every argument set below is chosen to leave the fixture unchanged; a refusal is a
// valid envelope too, so a tool that declines still satisfies the law.
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
  // A node the fixture does not contain: exercises the refusal path without writing anything.
  write_annotation: { nodeId: 'mod:absent/module', annotation: { summary: 'Never stored anywhere.' } },
  refresh_context: {},
  suggest_domains_config: {},
  decline_advisory: {},
  get_context_session_quality: { sessionId: 'law-session' },
  get_build_status: {},
};

/**
 * A second argument set per tool, aimed at the branches the first set never reaches.
 *
 * At repository scope several tools answer with a summary and never build a node view — which is the
 * shape with the most keys, and the one no law saw while `READ_ONLY_ARGS` was the only pass. The ids
 * come from the built fixture rather than being written here, so the set cannot go stale into a
 * silent skip.
 */
function nodeScopedArgs(moduleId: string, packageId: string): Record<string, Record<string, unknown>> {
  return {
    search_context: { query: 'module', limit: 1 },
    map_context: { scope: packageId, limit: 1 },
    inspect_node: { nodeId: moduleId, exportLimit: 1, includeBody: true, bodyLimit: 1, grepBody: 'e' },
    get_entrypoints: { scope: packageId, limit: 1 },
    trace_flow: { scope: packageId, limit: 1 },
    analyze_dependencies: { scope: moduleId, mode: 'impact', limit: 1 },
    get_config_surface: { scope: packageId, limit: 1 },
    analyze_architecture: { scope: packageId, limit: 1 },
    get_annotation_status: { view: 'queue', limit: 1 },
    get_annotation_merge_status: {},
    merge_annotations: {},
    validate_annotations: { scope: packageId, limit: 1 },
    write_annotation: { nodeId: 'mod:absent/module', annotation: { summary: 'Never stored anywhere.' } },
    refresh_context: {},
    suggest_domains_config: {},
    decline_advisory: {},
    get_context_session_quality: { sessionId: 'law-session' },
    get_build_status: {},
  };
}

/** Response keys are camelCase. Tool names and node ids carry underscores, but they are values. */
function snakeCaseKeys(value: unknown, trail: string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => snakeCaseKeys(item, [...trail, String(i)]));
  if (typeof value !== 'object' || value === null) return [];
  const out: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key.includes('_')) out.push([...trail, key].join('.'));
    out.push(...snakeCaseKeys(item, [...trail, key]));
  }
  return out;
}

/**
 * A response says "there is more" in one shape or not at all.
 *
 * These names are how the previous shapes spelled it — a suffix per site, a bare boolean, a count of
 * what was dropped. Any of them coming back means a new form grew beside the primitive.
 */
const TRUNCATION_SHAPED_KEY = /(truncated|pagination|hasmore|omitted|shownrefs|totalrefs|nextoffset)$/i;
const TRUNCATION_BOOLEAN_KEY = /^(truncated|hasmore|omitted)$/i;

function truncationShapedKeys(value: unknown, trail: string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => truncationShapedKeys(item, [...trail, String(i)]));
  if (typeof value !== 'object' || value === null) return [];
  const out: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // Inside a `truncation` block these words are the primitive's own vocabulary; the schema check
    // below owns that shape. Everywhere else they are a bound reported beside it.
    if (key === 'truncation') continue;
    if (TRUNCATION_SHAPED_KEY.test(key)) out.push([...trail, key].join('.'));
    if (TRUNCATION_BOOLEAN_KEY.test(key) && typeof item === 'boolean') out.push([...trail, key].join('.'));
    out.push(...truncationShapedKeys(item, [...trail, key]));
  }
  return out;
}

/** Every `truncation` block in a response, wherever it sits. */
function truncationBlocks(value: unknown, trail: string[] = []): Array<{ path: string; block: unknown }> {
  if (Array.isArray(value)) return value.flatMap((item, i) => truncationBlocks(item, [...trail, String(i)]));
  if (typeof value !== 'object' || value === null) return [];
  const out: Array<{ path: string; block: unknown }> = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'truncation') out.push({ path: [...trail, key].join('.'), block: item });
    else out.push(...truncationBlocks(item, [...trail, key]));
  }
  return out;
}

describe('core-laws MCP envelope (every tool answers in one declared shape)', () => {
  let runtime: McpToolRuntime;
  let tmpRoot: string;
  let artifactsDir: string;
  let deepArgs: Record<string, Record<string, unknown>>;
  const answers = new Map<string, unknown[]>();

  beforeAll(async () => {
    // The runtime roots in a copy, not the committed fixture: a build writes .repovine/ state into
    // its repo root, and refresh_context takes the annotation file lock there. Suites in other jest
    // workers copy the committed fixture concurrently, and a copied transient lock file names a live
    // pid — every later acquisition in that copy then waits out the full lock deadline and fails.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-envelope-law-'));
    const fixtureRoot = path.join(tmpRoot, 'basic-typescript');
    copyFixtureDirSync(path.join(findFixturesRoot(), 'basic-typescript'), fixtureRoot);
    artifactsDir = path.join(tmpRoot, 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
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
    const moduleId = [...(graph.byType.get('module') ?? [])].sort()[0];
    const packageId = [...(graph.byType.get('package') ?? [])].sort()[0];
    if (!moduleId || !packageId) throw new Error('Fixture has no module/package node to scope the deep pass to.');
    deepArgs = nodeScopedArgs(moduleId, packageId);
  }, 120_000);

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('refuses a field added beside result', () => {
    // TypeScript rejects the same addition at the call site; this holds the runtime shape too, so a
    // payload assembled through a cast or arriving from a future non-TS caller is still refused.
    const valid = envelope('all', 'Fine', { ok: true });

    expect(ToolResponseSchema.safeParse(valid).success).toBe(true);
    expect(ToolResponseSchema.safeParse({ ...valid, tookMs: 1 }).success).toBe(false);
  });

  it('every advertised tool has a handler, and every handler is advertised', () => {
    expect(Object.keys(toolHandlers).sort()).toEqual(toolDefs.map(def => def.name).sort());
  });

  it('every tool defines read-only arguments for this law', () => {
    // A tool added without an entry here would otherwise be skipped in silence.
    expect(Object.keys(READ_ONLY_ARGS).sort()).toEqual(toolDefs.map(def => def.name).sort());
  });

  it('every tool defines node-scoped arguments for the deep pass', () => {
    // Repository scope leaves several tools on a summary branch that carries no node view. Without
    // an entry per tool here, the pass that reaches those branches would skip them without saying so.
    expect(Object.keys(deepArgs).sort()).toEqual(toolDefs.map(def => def.name).sort());
  });

  // One invocation per (tool, pass), reused by every check below. Some handlers rebuild the graph,
  // so calling them once per assertion would pay for the rebuild three times over on every platform.
  const responsesFor = async (name: string): Promise<unknown[]> => {
    const cached = answers.get(name);
    if (cached) return cached;
    const fresh = [
      await toolHandlers[name](runtime, READ_ONLY_ARGS[name]),
      await toolHandlers[name](runtime, deepArgs[name]),
    ];
    answers.set(name, fresh);
    return fresh;
  };

  it.each(toolDefs.map(def => def.name))('%s answers a valid envelope', async name => {
    for (const response of await responsesFor(name)) {
      const parsed = ToolResponseSchema.safeParse(response);

      expect(parsed.success ? [] : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)).toEqual([]);
    }
  }, 60_000);

  it.each(toolDefs.map(def => def.name))('%s names every response key in camelCase', async name => {
    for (const response of await responsesFor(name)) {
      expect(snakeCaseKeys(response)).toEqual([]);
    }
  }, 60_000);

  // A bound was reported fourteen ways before this: a suffix per site, a bare boolean, a count of
  // what was dropped. One shape, or the answer does not say what a caller can still ask for.
  it.each(toolDefs.map(def => def.name))('%s reports every bound through the primitive', async name => {
    for (const response of await responsesFor(name)) {
      expect(truncationShapedKeys(response)).toEqual([]);
      for (const { path, block } of truncationBlocks(response)) {
        const parsed = TruncationMapSchema.safeParse(block);
        expect(parsed.success ? [] : [`${path}: ${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`]).toEqual([]);
      }
    }
  }, 60_000);

  it('refuses a bound that claims a page without saying where it resumes', () => {
    // `page` is the only kind a caller can act on without reading prose; a nextOffset-less page is
    // the shape that reads as "there is more" and leaves no way to ask for it.
    expect(TruncationSchema.safeParse({
      shown: 1, total: 2, unit: 'item', more: { kind: 'page', arg: 'offset', nextOffset: 1 },
    }).success).toBe(true);
    expect(TruncationSchema.safeParse({
      shown: 1, total: 2, unit: 'item', more: { kind: 'page', arg: 'offset' },
    }).success).toBe(false);
    // A boolean is not a bound: without counters a reader cannot tell a cap from an empty answer.
    expect(TruncationSchema.safeParse({ truncated: true }).success).toBe(false);
    expect(TruncationSchema.safeParse({ shown: 1, unit: 'item' }).success).toBe(false);
  });

  it('grades every provenance method the same way everywhere', () => {
    // `basis` is what a reader acts on and `method` is what produced it; a site that set them apart
    // by hand could grade a hash comparison as a guess.
    for (const method of PROVENANCE_METHODS) {
      expect(ProvenanceSchema.safeParse(provenance(method)).success).toBe(true);
    }
    expect(ProvenanceSchema.safeParse({ basis: 'computed', method: 'vibes' }).success).toBe(false);
  });
});
