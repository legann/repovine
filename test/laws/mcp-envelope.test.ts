import { describe, expect, it, beforeAll, afterAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RepovineRuntime } from '../../src/mcp/context.js';
import { loadConfig } from '../../src/config.js';
import { toolDefs } from '../../src/mcp/tool-defs.js';
import { toolHandlers } from '../../src/mcp/tools/registry.js';
import { envelope, ToolResponseSchema } from '../../src/mcp/response/envelope.js';
import type { McpToolRuntime } from '../../src/mcp/types.js';
import type { IndexBuildStatus } from '../../src/mcp/build-controller.js';
import { findFixturesRoot } from './graph-law-helpers.js';

// The response contract. Input is described by a Zod schema per tool; for a long time the output was
// not described at all, and the shape drifted: two tools answered outside the envelope, the same
// build fact was named in two key registers, and failure came back in three forms. This holds every
// tool to one declared shape and one key convention, so the next tool cannot invent a nineteenth.
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

describe('core-laws MCP envelope (every tool answers in one declared shape)', () => {
  let runtime: McpToolRuntime;
  let artifactsDir: string;

  beforeAll(async () => {
    const fixtureRoot = path.join(findFixturesRoot(), 'basic-typescript');
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine-envelope-law-'));
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
  }, 120_000);

  afterAll(() => {
    fs.rmSync(artifactsDir, { recursive: true, force: true });
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

  it.each(toolDefs.map(def => def.name))('%s answers a valid envelope', async name => {
    const response = await toolHandlers[name](runtime, READ_ONLY_ARGS[name]);
    const parsed = ToolResponseSchema.safeParse(response);

    expect(parsed.success ? [] : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)).toEqual([]);
  }, 60_000);

  it.each(toolDefs.map(def => def.name))('%s names every response key in camelCase', async name => {
    const response = await toolHandlers[name](runtime, READ_ONLY_ARGS[name]);

    expect(snakeCaseKeys(response)).toEqual([]);
  }, 60_000);
});
