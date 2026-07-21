/**
 * Tests for config loading (loadConfig) — file parsing, defaults, env overrides.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { jest } from '@jest/globals';
import { loadConfig, CONFIG_DEFAULTS } from '../../src/config.js';
import { getPipelineLogSink, setPipelineLogSink } from '../../src/cli/ui.js';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    delete process.env.REPOVINE_VERBOSE;
    delete process.env.REPOVINE_MCP_RESPONSE;
    delete process.env.REPOVINE_MCP_MAX_CHARS;
    delete process.env.REPOVINE_ANNOTATIONS_FILE;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.REPOVINE_VERBOSE;
    delete process.env.REPOVINE_MCP_RESPONSE;
    delete process.env.REPOVINE_MCP_MAX_CHARS;
    delete process.env.REPOVINE_ANNOTATIONS_FILE;
  });

  it('returns defaults when config file is absent', () => {
    const cfg = loadConfig(tmpDir);
    expect(cfg.workspace.annotationsFile).toBe('repovine.annots.json');
    expect(Object.keys(cfg)).toEqual([
      'workspace',
      'build',
      'mcp',
      'semanticSearchEmbeddings',
      'analyze_architecture',
      'contextQuality',
      'annotations',
      'plugins',
    ]);
    expect(Object.keys(CONFIG_DEFAULTS)).toEqual(Object.keys(cfg));
    expect(cfg.build.scan.include).toEqual([]);
    expect(cfg.build.scan.exclude).toEqual([]);
    expect(cfg.build.linking.handlers.searchRoots).toEqual([]);
    expect(cfg.build.linking.bundles.autoDetect).toBe(true);
    expect(cfg.mcp.verbose).toBe(false);
    expect(cfg.mcp.response).toEqual({
      mode: 'concise',
      pretty: false,
      maxChars: 40_000,
    });
    expect(cfg.contextQuality.thresholds.explore.minAnchors).toBe(1);
    expect(cfg.contextQuality.thresholds.implement.byteBudget).toBe(120_000);
    expect(cfg).not.toHaveProperty('verbose');
  });

  it('enables semantic search embeddings by default', () => {
    const cfg = loadConfig(tmpDir);
    expect(cfg.semanticSearchEmbeddings).toBe(true);
  });

  it('respects semantic_search_embeddings: false', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      semantic_search_embeddings: false,
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.semanticSearchEmbeddings).toBe(false);
  });

  it('parses valid config file', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      build: {
        scan: {
          include: ['types/**/*.d.ts'],
          exclude: ['types/vendor/**/*.d.ts'],
        },
        linking: { handlers: { searchRoots: ['apps/api/src'] } },
      },
      mcp: {
        verbose: true,
        response: {
          mode: 'debug',
          pretty: false,
        },
      },
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.build.scan.include).toEqual(['types/**/*.d.ts']);
    expect(cfg.build.scan.exclude).toEqual(['types/vendor/**/*.d.ts']);
    expect(cfg.build.linking.handlers.searchRoots).toEqual(['apps/api/src']);
    expect(cfg.mcp.verbose).toBe(true);
    expect(cfg.mcp.response).toEqual({
      mode: 'debug',
      pretty: false,
      maxChars: 40_000,
    });
  });

  it('returns defaults for invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), 'not json {{{');
    const cfg = loadConfig(tmpDir);
    expect(cfg.build.scan.include).toEqual(CONFIG_DEFAULTS.build.scan.include);
  });

  it('returns defaults for schema-invalid config', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      mcp: { response: { mode: 'chatty' } },
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.mcp.response.mode).toBe(CONFIG_DEFAULTS.mcp.response.mode);
  });

  it('warns for unknown keys while preserving valid sibling settings', () => {
    const previousSink = getPipelineLogSink();
    setPipelineLogSink('stderr');
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
        build: {
          scan: {
            include: ['types/**/*.d.ts'],
            incldue: ['typo/**/*.d.ts'],
          },
        },
        semanitc_search_embeddings: false,
      }));

      const cfg = loadConfig(tmpDir);

      expect(cfg.build.scan.include).toEqual(['types/**/*.d.ts']);
      const output = stderrWrite.mock.calls.map(call => String(call[0])).join('');
      expect(output).toContain('build.scan.incldue');
      expect(output).toContain('semanitc_search_embeddings');
    } finally {
      stderrWrite.mockRestore();
      setPipelineLogSink(previousSink);
    }
  });

  it('warns for unknown keys inside structured scan-pattern arrays', () => {
    const previousSink = getPipelineLogSink();
    setPipelineLogSink('stderr');
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
        build: {
          scan: {
            include: [{ path: 'infra/**', scope: 'infra', scpoe: 'source' }],
          },
        },
      }));

      const cfg = loadConfig(tmpDir);

      expect(cfg.build.scan.include).toEqual([{ path: 'infra/**', scope: 'infra' }]);
      expect(stderrWrite.mock.calls.map(call => String(call[0])).join(''))
        .toContain('build.scan.include[0].scpoe');
    } finally {
      stderrWrite.mockRestore();
      setPipelineLogSink(previousSink);
    }
  });

  it('REPOVINE_VERBOSE=1 enables verbose', () => {
    process.env.REPOVINE_VERBOSE = '1';
    const cfg = loadConfig(tmpDir);
    expect(cfg.mcp.verbose).toBe(true);
  });

  it('mcp.response debug profile expands response defaults', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      mcp: { response: { mode: 'debug' } },
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.mcp.response).toEqual({
      mode: 'debug',
      pretty: true,
      maxChars: 40_000,
    });
  });

  it('REPOVINE_MCP_RESPONSE overrides response mode', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      mcp: { response: { mode: 'debug' } },
    }));
    process.env.REPOVINE_MCP_RESPONSE = 'concise';
    const cfg = loadConfig(tmpDir);
    expect(cfg.mcp.response.mode).toBe('concise');
    expect(cfg.mcp.response.pretty).toBe(false);
  });

  it('reads mcp.response.maxChars from file', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      mcp: { response: { maxChars: 12_000 } },
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.mcp.response.maxChars).toBe(12_000);
  });

  it('REPOVINE_MCP_MAX_CHARS overrides file/default; invalid falls back', () => {
    process.env.REPOVINE_MCP_MAX_CHARS = '8000';
    expect(loadConfig(tmpDir).mcp.response.maxChars).toBe(8_000);
    process.env.REPOVINE_MCP_MAX_CHARS = '12'; // below MIN_RESPONSE_CHARS floor
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(loadConfig(tmpDir).mcp.response.maxChars).toBe(CONFIG_DEFAULTS.mcp.response.maxChars);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid REPOVINE_MCP_MAX_CHARS'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── Analyze architecture config ──

  it('analyze_architecture defaults to normal profile when config is absent', () => {
    const cfg = loadConfig(tmpDir);
    expect(cfg.analyze_architecture.strictness).toBe('normal');
    expect(cfg.analyze_architecture.thresholds.duplicateLike.minGroupSize).toBe(3);
    expect(cfg.analyze_architecture.thresholds.godModule.minScore).toBe(18);
    expect(cfg.analyze_architecture.thresholds.lowCohesion.minDomainSize).toBe(8);
    expect(cfg.analyze_architecture.thresholds.flowConvergence.maxBfsDepth).toBe(5);
    expect(cfg.analyze_architecture.thresholds.effectSpaghetti.minEffects).toBe(3);
    expect(cfg.analyze_architecture.thresholds.propDrillingOrchestration.minProps).toBe(8);
    expect(cfg.analyze_architecture.thresholds.serviceWrapperExplosion.minGroupSize).toBe(4);
    expect(cfg.analyze_architecture.thresholds.routeConvergence.maxBfsDepth).toBe(5);
    expect(cfg.analyze_architecture.thresholds.annotationRisk.minQualityScore).toBe(3);
    expect(cfg.analyze_architecture.thresholds.secretConfigBoundary.flagGenericPublicAuthEnv).toBe(true);
    expect(cfg.analyze_architecture.thresholds.privilegedClientSideEffect.includeMutationOnly).toBe(true);
    expect(cfg.analyze_architecture.thresholds.serverClientBoundary.allowGenericStorageName).toBe(true);
  });

  it('analyze_architecture "loose" profile lowers skip thresholds', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      analyze_architecture: { strictness: 'loose' },
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.analyze_architecture.strictness).toBe('loose');
    expect(cfg.analyze_architecture.thresholds.duplicateLike.minGroupSize).toBe(2);
    expect(cfg.analyze_architecture.thresholds.godModule.minScore).toBe(13);
    expect(cfg.analyze_architecture.thresholds.lowCohesion.minDomainSize).toBe(5);
    expect(cfg.analyze_architecture.thresholds.effectSpaghetti.minEffects).toBe(2);
    expect(cfg.analyze_architecture.thresholds.propDrillingOrchestration.minProps).toBe(6);
    expect(cfg.analyze_architecture.thresholds.serviceWrapperExplosion.maxFanIn).toBe(2);
    expect(cfg.analyze_architecture.thresholds.secretConfigBoundary.flagGenericPublicAuthEnv).toBe(true);
    expect(cfg.analyze_architecture.thresholds.sensitiveBrowserStorage.minAnnotationStorageSignals).toBe(1);
  });

  it('analyze_architecture "strict" profile raises skip thresholds', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      analyze_architecture: { strictness: 'strict' },
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.analyze_architecture.strictness).toBe('strict');
    expect(cfg.analyze_architecture.thresholds.duplicateLike.minGroupSize).toBe(4);
    expect(cfg.analyze_architecture.thresholds.godModule.minScore).toBe(25);
    expect(cfg.analyze_architecture.thresholds.lowCohesion.minDomainSize).toBe(12);
    expect(cfg.analyze_architecture.thresholds.effectSpaghetti.minEffects).toBe(4);
    expect(cfg.analyze_architecture.thresholds.propDrillingOrchestration.minTunnelDepth).toBe(3);
    expect(cfg.analyze_architecture.thresholds.routeConvergence.minEntrypoints).toBe(3);
    expect(cfg.analyze_architecture.thresholds.secretConfigBoundary.flagGenericPublicAuthEnv).toBe(false);
    expect(cfg.analyze_architecture.thresholds.privilegedClientSideEffect.includeMutationOnly).toBe(false);
    expect(cfg.analyze_architecture.thresholds.serverClientBoundary.allowGenericStorageName).toBe(false);
  });

  it('analyze_architecture per-knob overrides merge on top of strictness profile', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      analyze_architecture: {
        strictness: 'normal',
        thresholds: {
          godModule: { minScore: 50 },
          effectSpaghetti: { minEffects: 6 },
          propDrillingOrchestration: { minProps: 12 },
          annotationRisk: { minQualityScore: 7 },
          secretConfigBoundary: { flagGenericPublicAuthEnv: false },
          sensitiveBrowserStorage: { minAnnotationStorageSignals: 3 },
        },
      },
    }));
    const cfg = loadConfig(tmpDir);
    // overridden
    expect(cfg.analyze_architecture.thresholds.godModule.minScore).toBe(50);
    expect(cfg.analyze_architecture.thresholds.effectSpaghetti.minEffects).toBe(6);
    expect(cfg.analyze_architecture.thresholds.propDrillingOrchestration.minProps).toBe(12);
    expect(cfg.analyze_architecture.thresholds.annotationRisk.minQualityScore).toBe(7);
    expect(cfg.analyze_architecture.thresholds.secretConfigBoundary.flagGenericPublicAuthEnv).toBe(false);
    expect(cfg.analyze_architecture.thresholds.sensitiveBrowserStorage.minAnnotationStorageSignals).toBe(3);
    // not overridden — still from normal profile
    expect(cfg.analyze_architecture.thresholds.godModule.linesPerScorePoint).toBe(150);
    expect(cfg.analyze_architecture.thresholds.annotationRisk.minImportance).toBe(8);
    expect(cfg.analyze_architecture.thresholds.effectSpaghetti.minNestedSideEffects).toBe(3);
    expect(cfg.analyze_architecture.thresholds.propDrillingOrchestration.minCallbackProps).toBe(3);
    expect(cfg.analyze_architecture.thresholds.duplicateLike.minGroupSize).toBe(3);
    expect(cfg.analyze_architecture.thresholds.secretConfigBoundary.minEvidenceScore).toBe(1);
    expect(cfg.analyze_architecture.thresholds.sensitiveBrowserStorage.requireSensitiveKey).toBe(false);
  });

  it('invalid analyze_architecture schema falls back to defaults silently', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      analyze_architecture: { strictness: 'banana' },  // invalid enum
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.analyze_architecture.strictness).toBe('normal');
  });

  it('loads workspace.annotationsFile from repovine.config.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      workspace: { annotationsFile: 'docs/repovine/annots.json' },
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.workspace.annotationsFile).toBe('docs/repovine/annots.json');
  });

  it('REPOVINE_ANNOTATIONS_FILE overrides workspace.annotationsFile', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      workspace: { annotationsFile: 'docs/repovine/annots.json' },
    }));
    process.env.REPOVINE_ANNOTATIONS_FILE = '.cursor/repovine.annots.json';
    const cfg = loadConfig(tmpDir);
    expect(cfg.workspace.annotationsFile).toBe('.cursor/repovine.annots.json');
  });

  it('falls back to default when workspace.annotationsFile escapes repo root', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      workspace: { annotationsFile: '../../etc/passwd' },
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.workspace.annotationsFile).toBe('repovine.annots.json');
  });

  it('loads scoped scan.exclude from repovine.config.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      build: {
        scan: {
          exclude: [{ path: 'infrastructure/sam/template.yaml', scope: 'infra' }],
        },
      },
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.build.scan.exclude).toEqual([{ path: 'infrastructure/sam/template.yaml', scope: 'infra' }]);
  });

  it('merges contextQuality enforcement and warningThreshold config', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      contextQuality: {
        enforcement: { mode: 'harness' },
        thresholds: {
          implement: { warningThreshold: 0.75 },
        },
      },
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.contextQuality.enforcement.mode).toBe('harness');
    expect(cfg.contextQuality.purgeSessionsOnMcpStart).toBe(false);
    expect(cfg.contextQuality.thresholds.implement.warningThreshold).toBe(0.75);
    expect(cfg.contextQuality.thresholds.implement.threshold).toBe(0.55);
  });

  it('merges contextQuality config over deterministic defaults', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      contextQuality: {
        thresholds: {
          explore: { threshold: 0.7, minAnchors: 2 },
        },
        weights: { bytes: 0.4 },
        exportSymbolFloodRatio: 0.6,
        retainSessions: true,
        persistEvents: true,
        maxRequestEchoes: 7,
      },
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.contextQuality.thresholds.explore.threshold).toBe(0.7);
    expect(cfg.contextQuality.thresholds.explore.minAnchors).toBe(2);
    expect(cfg.contextQuality.thresholds.explore.byteBudget).toBe(80_000);
    expect(cfg.contextQuality.thresholds.explore.warningThreshold).toBe(0.55);
    expect(cfg.contextQuality.enforcement.mode).toBe('client');
    expect(cfg.contextQuality.purgeSessionsOnMcpStart).toBe(true);
    expect(cfg.contextQuality.thresholds.implement.threshold).toBe(0.55);
    expect(cfg.contextQuality.weights.bytes).toBe(0.4);
    expect(cfg.contextQuality.weights.or).toBeGreaterThan(0);
    expect(cfg.contextQuality.exportSymbolFloodRatio).toBe(0.6);
    expect(cfg.contextQuality.retainSessions).toBe(true);
    expect(cfg.contextQuality.persistEvents).toBe(true);
    expect(cfg.contextQuality.maxRequestEchoes).toBe(7);
  });

  it('defaults annotations.propagation to entrypoint-bounded path-only', () => {
    const cfg = loadConfig(tmpDir);
    expect(cfg.annotations.propagation).toEqual({
      domainStalePolicy: 'path-only',
      packageDomainHardQueue: false,
      consumerReachMaxDepth: 32,
      hubModulesExtra: [],
      hubModulesDeny: [],
    });
  });

  it('parses annotations.propagation block', () => {
    fs.writeFileSync(path.join(tmpDir, 'repovine.config.json'), JSON.stringify({
      annotations: {
        propagation: {
          domainStalePolicy: 'path-only',
          packageDomainHardQueue: false,
          hubModulesExtra: ['mod:repovine/src/types'],
          hubModulesDeny: ['mod:some-noisy-util'],
        },
      },
    }));
    const cfg = loadConfig(tmpDir);
    expect(cfg.annotations.propagation.domainStalePolicy).toBe('path-only');
    expect(cfg.annotations.propagation.packageDomainHardQueue).toBe(false);
    expect(cfg.annotations.propagation.hubModulesExtra).toEqual(['mod:repovine/src/types']);
    expect(cfg.annotations.propagation.hubModulesDeny).toEqual(['mod:some-noisy-util']);
  });
});
