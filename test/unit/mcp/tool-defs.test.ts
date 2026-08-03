import { describe, expect, it } from '@jest/globals';
import { toolHandlers } from '../../../src/mcp/tools/registry.js';
import { toolDefs, getRequiredArgs } from '../../../src/mcp/tool-defs.js';
import { REFACTORING_CATEGORIES } from '../../../src/analysis/architecture/types.js';

// Tools that intentionally live outside toolHandlers because they are answered directly
// by the MCP server (e.g. metadata about the build lifecycle).
const TOOLS_HANDLED_BY_SERVER = new Set(['get_build_status']);

describe('public MCP tool definitions', () => {
  it('exposes the context framework as the public tools/list surface', () => {
    expect(toolDefs.map(def => def.name)).toEqual([
      'search_context',
      'map_context',
      'inspect_node',
      'get_entrypoints',
      'trace_flow',
      'analyze_dependencies',
      'get_config_surface',
      'analyze_architecture',
      'get_annotation_status',
      'get_annotation_merge_status',
      'merge_annotations',
      'validate_annotations',
      'write_annotation',
      'refresh_context',
      'suggest_domains_config',
      'decline_advisory',
      'get_context_session_quality',
      'get_build_status',
    ]);
  });

  it('registers every public tool in toolHandlers (except server-handled metadata tools)', () => {
    for (const name of toolDefs.map(def => def.name)) {
      if (TOOLS_HANDLED_BY_SERVER.has(name)) continue;
      expect(toolHandlers[name]).toBeDefined();
    }
  });

  it('adds per-call responseFormat to every public tool schema', () => {
    for (const def of toolDefs) {
      expect(def.schema.shape.responseFormat).toBeDefined();
      expect(def.schema.shape.contextSessionId).toBeDefined();
    }
  });

  it('documents get_build_status cancel support', () => {
    const buildStatus = toolDefs.find(def => def.name === 'get_build_status');
    expect(buildStatus?.schema.shape.cancel).toBeDefined();
    expect(buildStatus?.description).toContain('cancel');
    expect(buildStatus?.description).toContain('cancelled');
    expect(buildStatus?.schema.safeParse({ cancel: true }).success).toBe(true);
  });

  it('documents refresh_context config reload support', () => {
    const refresh = toolDefs.find(def => def.name === 'refresh_context');
    expect(refresh?.description).toContain('reloadConfig');
    expect(refresh?.schema.shape.reloadConfig).toBeDefined();
    expect(refresh?.schema.safeParse({ reloadConfig: true }).success).toBe(true);
  });

  it('accepts and documents the risk-scope-candidates annotation status view', () => {
    const status = toolDefs.find(def => def.name === 'get_annotation_status');
    expect(status?.schema.safeParse({ view: 'risk-scope-candidates' }).success).toBe(true);
    expect(status?.description).toContain('risk-scope-candidates');
    expect(status?.description).toContain('advisory plain/local risk entries');

    const validate = toolDefs.find(def => def.name === 'validate_annotations');
    expect(validate?.description).toContain('riskScopeCandidates');
  });

  it('accepts and documents the carrier-gaps annotation status view and the decline_advisory tool', () => {
    const status = toolDefs.find(def => def.name === 'get_annotation_status');
    expect(status?.schema.safeParse({ view: 'carrier-gaps' }).success).toBe(true);
    expect(status?.description).toContain('carrier-gaps');
    expect(status?.description).toContain('reviewed targets stay visible');

    const validate = toolDefs.find(def => def.name === 'validate_annotations');
    expect(validate?.description).toContain('carrierLinkGaps');
    expect(validate?.description).toContain('decline_advisory');

    const decline = toolDefs.find(def => def.name === 'decline_advisory');
    expect(decline?.schema.shape.kind).toBeDefined();
    expect(decline?.schema.shape.ids).toBeDefined();
    expect(decline?.schema.shape.all).toBeDefined();
    expect(decline?.schema.shape.reason).toBeDefined();
    expect(decline?.schema.safeParse({ kind: 'carrier-link-gaps', all: true, reason: 'type/config hub' }).success).toBe(true);
    expect(decline?.schema.safeParse({ kind: 'domains-config', ids: ['axis-1'] }).success).toBe(true);
    // kind is required and closed: a kind-less or unknown-kind call must fail schema validation.
    expect(decline?.schema.safeParse({ all: true }).success).toBe(false);
    expect(decline?.schema.safeParse({ kind: 'risk-scope-candidates' }).success).toBe(false);
    expect(getRequiredArgs(decline!)).toEqual(['kind']);
    expect(decline?.description).toContain('carrier-review.json');
    expect(decline?.description).toContain('onboarding-state.json');
    expect(decline?.description).toContain('riskHash');
  });

  it('documents the refresh_context rebuild path from a cancelled server', () => {
    const refresh = toolDefs.find(def => def.name === 'refresh_context');
    expect(refresh?.description).toContain('status:"cancelled"');
    expect(refresh?.description).toContain('re-triggers a fresh background build');
  });

  it('exposes no sessionId alias on normal tools; session-quality lookup stays explicit', () => {
    const search = toolDefs.find(def => def.name === 'search_context');
    const quality = toolDefs.find(def => def.name === 'get_context_session_quality');
    // A stray sessionId alias on ANY normal tool must be caught, not just search_context:
    // get_context_session_quality is the only tool that owns the explicit sessionId lookup key.
    const strayAliasTools = toolDefs
      .filter(def => def.name !== 'get_context_session_quality')
      .filter(def => def.schema.shape.sessionId !== undefined)
      .map(def => def.name);
    expect(strayAliasTools).toEqual([]);
    expect(search?.schema.shape.sessionId).toBeUndefined();
    expect(quality?.schema.shape.sessionId).toBeDefined();
    expect(quality?.schema.shape.consume).toBeDefined();
    expect(quality?.schema.shape.mode).toBeDefined();
    expect(quality?.schema.shape.warningThreshold).toBeDefined();
    expect(quality?.schema.safeParse({ sessionId: 'sess-1' }).success).toBe(true);
    expect(quality?.schema.safeParse({ contextSessionId: 'sess-1' }).success).toBe(false);
  });

  it('derives the live missing-required-arg gate from zod optionality (getRequiredArgs)', () => {
    const search = toolDefs.find(def => def.name === 'search_context')!;
    const write = toolDefs.find(def => def.name === 'write_annotation')!;
    const quality = toolDefs.find(def => def.name === 'get_context_session_quality')!;

    // Non-optional fields are required; the exact set is pinned so an inverted
    // `!isOptional()` (which would demand every optional param) or flipped
    // optionality semantics turns this red.
    expect(getRequiredArgs(search)).toEqual(['query']);
    expect(getRequiredArgs(write)).toEqual(['nodeId']);
    expect(getRequiredArgs(quality)).toEqual(['sessionId']);

    // The injected per-call params (see toolDefs.extend) are optional and must
    // never be demanded as required by the gate.
    expect(getRequiredArgs(search)).not.toContain('contextSessionId');
    expect(getRequiredArgs(search)).not.toContain('responseFormat');
    expect(getRequiredArgs(search)).not.toContain('limit');
  });

  it('does not register removed legacy annotation tool names', () => {
    const names = new Set(Object.keys(toolHandlers));
    for (const removed of [
      'get_semantic_status',
      'write_semantic_note',
      'write_module_annotation',
      'get_modules_annotation_queue',
      'get_annotation_coverage_stats',
      'get_orphaned_annotations',
      'cleanup_orphaned_annotations',
      'refresh_repo_context',
    ]) {
      expect(names.has(removed)).toBe(false);
    }
  });

  it('does not advertise parameters that their handlers do not honor', () => {
    const trace = toolDefs.find(def => def.name === 'trace_flow');
    expect(trace?.schema.shape.to).toBeUndefined();
    expect(trace?.schema.shape.depth).toBeUndefined();

    const dependencies = toolDefs.find(def => def.name === 'analyze_dependencies');
    expect(dependencies?.schema.shape.groupBy).toBeUndefined();
    expect(dependencies?.schema.shape.includeSymbols).toBeUndefined();
    expect(dependencies?.schema.shape.includeBoundaryFixes).toBeUndefined();
  });

  it('documents fuzzy search and scope alias behavior in public contracts', () => {
    const search = toolDefs.find(def => def.name === 'search_context');
    expect(search?.description).toContain('bounded OR');
    expect(search?.schema.shape).toEqual(expect.objectContaining({
      match: expect.any(Object),
      perTokenLimit: expect.any(Object),
    }));
    expect(search?.description).toContain('emptyDiagnostic');
    expect(search?.description).toContain('annotationMatched');
    expect(search?.description).toContain('annotation fields are omitted');

    const map = toolDefs.find(def => def.name === 'map_context');
    expect(map?.description).toContain('emptyDiagnostic');

    const inspect = toolDefs.find(def => def.name === 'inspect_node');
    expect(inspect?.description).toContain('do not bound inspect scope');
    expect(inspect?.description).toContain('verification obligations');
    expect(inspect?.description).toContain('must preserve');
    expect(inspect?.description).toContain('unchanged requires inspect_node');
    expect(inspect?.description).toContain('consumed by every importer of the module that derives it'); // derived-flag nudge
    expect(inspect?.description).toContain('investigate tag (risk/boundary/effect/wiring/co-change/hub)'); // investigate channel — all six tags
    expect(inspect?.description).toContain('investigatePointers'); // integrationPoints reach channel
    expect(inspect?.description).toContain('affordanceCount'); // affordance count documented in the tool description
    expect(inspect?.description).toContain('boundary-scoped risk'); // boundary tag documented
    expect(inspect?.description).toContain('consumer-scoped risk');
    expect(inspect?.description).toContain('attention block'); // hoisted-obligations block documented

    const entrypoints = toolDefs.find(def => def.name === 'get_entrypoints');
    expect(entrypoints?.description).toContain('domain scopes are semantic/path tags');
    expect(entrypoints?.description).toContain('emptyDiagnostic');

    const trace = toolDefs.find(def => def.name === 'trace_flow');
    expect(trace?.description).toContain('emptyDiagnostic');

    const config = toolDefs.find(def => def.name === 'get_config_surface');
    expect(config?.description).toContain('emptyDiagnostic');

    const dependencies = toolDefs.find(def => def.name === 'analyze_dependencies');
    expect(dependencies?.description).toContain('mode/scope-mismatch');
    expect(dependencies?.description).toContain('emptyDiagnostic');
    expect(dependencies?.description).toContain('result.analysis.truncation'); // build-site list caps documented
    expect(dependencies?.description).toContain('truncation.result'); // global size backstop documented
    expect(dependencies?.schema.shape.offset).toBeDefined(); // pages the capped lists

    const architecture = toolDefs.find(def => def.name === 'analyze_architecture');
    expect(architecture?.description).toContain('missing finding detail');
    expect(architecture?.description).toContain('emptyDiagnostic');
    expect(architecture?.description).toContain('truncation block'); // report-mode node preview documented
    expect(architecture?.schema.shape.annotationReasoning.description).toContain('verification obligations');
    expect('minConfidence' in (architecture?.schema.shape ?? {})).toBe(false);
    expect(architecture?.schema.shape.limit.safeParse(30).success).toBe(true);
    expect(architecture?.schema.shape.limit.safeParse(31).success).toBe(false);
    // The advertised category filter must accept exactly the engine's RefactoringCategory union
    // (the enum is SSOT-derived from REFACTORING_CATEGORIES; this guards against a re-hardcode drift).
    expect(architecture?.schema.safeParse({ categories: [...REFACTORING_CATEGORIES] }).success).toBe(true);
    expect(architecture?.schema.safeParse({ categories: ['not-a-real-category'] }).success).toBe(false);
  });
});
