import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  resolveThresholds as resolveAnalyzeArchitectureThresholds,
  type RefactoringFileConfig as AnalyzeArchitectureFileConfig,
  type RefactoringStrictness as AnalyzeArchitectureStrictness,
  type RefactoringThresholds as AnalyzeArchitectureThresholds,
} from './analysis/architecture/config.js';
import {
  DEFAULT_CONTEXT_QUALITY_CONFIG,
} from './context-quality/session-store.js';
import type { ContextQualityConfig } from './context-quality/types.js';
import { formatPipelineMuted, logPipeline, logPipelineWarn } from './cli/ui.js';
import { ANNOTATIONS_FILENAME, resolveAnnotationsFilePath } from './paths.js';
import { describeTransformersInstall } from './semantic/transformers-install.js';
import type { ScanPatternInput } from './scan-filters.js';

// ── Schema ──

/**
 * Global serializer ceiling: a single tool result's `content[0].text` never exceeds this.
 * The observed host flood was 59,549 chars, rejected and saved to file. Dense JSON (paths, IDs,
 * repeated keys, punctuation) tokenizes near ~3 chars/token, so 40K chars is ~10-13K tokens —
 * under the host budget with margin, vs ~16-17K worst case at 50K. Tunable per host via
 * mcp.response.maxChars / REPOVINE_MCP_MAX_CHARS.
 */
export const DEFAULT_MAX_RESPONSE_CHARS = 40_000;
/** Floor for a configured response ceiling; keeps the bounded envelope itself representable. */
export const MIN_RESPONSE_CHARS = 1_000;

const ScanScopeSchema = z.enum(['all', 'source', 'infra']);

const ScanPatternSchema = z.union([
  z.string(),
  z.object({
    path: z.string(),
    scope: ScanScopeSchema.optional(),
  }),
]);

const ScanConfigSchema = z.object({
  include: z.array(ScanPatternSchema).optional(),
  exclude: z.array(ScanPatternSchema).optional(),
  maxPackageWorkers: z.number().int().min(0).max(64).optional(),
});

const LinkingHandlersSchema = z.object({
  searchRoots: z.array(z.string()).optional(),
});

const LinkingBundlesSchema = z.object({
  scripts: z.array(z.string()).optional(),
  autoDetect: z.boolean().optional(),
});

const LinkingConfigSchema = z.object({
  handlers: LinkingHandlersSchema.optional(),
  bundles: LinkingBundlesSchema.optional(),
});

/** Repovine graph build: Stage 1 scan filters + Stage 2 infra→code linking hints. */
const BuildConfigSchema = z.object({
  scan: ScanConfigSchema.optional(),
  linking: LinkingConfigSchema.optional(),
});

const McpResponseConfigSchema = z.object({
  mode: z.enum(['concise', 'debug']).optional(),
  pretty: z.boolean().optional(),
  maxChars: z.number().int().min(MIN_RESPONSE_CHARS).optional(),
});

const McpConfigSchema = z.object({
  verbose: z.boolean().optional(),
  response: McpResponseConfigSchema.optional(),
});

export const AnalyzeArchitectureThresholdsSchema = z.object({
  duplicateLike: z.object({
    minGroupSize: z.number().int().min(1).optional(),
    minPackages: z.number().int().min(1).optional(),
  }).optional(),
  godModule: z.object({
    minScore: z.number().min(0).optional(),
    linesPerScorePoint: z.number().int().min(1).optional(),
  }).optional(),
  godDomain: z.object({
    minModules: z.number().int().min(1).optional(),
    minSubdomains: z.number().int().min(0).optional(),
  }).optional(),
  lowCohesion: z.object({
    minDomainSize: z.number().int().min(1).optional(),
  }).optional(),
  flowConvergence: z.object({
    maxBfsDepth: z.number().int().min(1).max(20).optional(),
  }).optional(),
  effectSpaghetti: z.object({
    minEffects: z.number().int().min(1).optional(),
    minNestedSideEffects: z.number().int().min(0).optional(),
    minSideEffectKinds: z.number().int().min(0).max(4).optional(),
  }).optional(),
  propDrillingOrchestration: z.object({
    minProps: z.number().int().min(1).optional(),
    minCallbackProps: z.number().int().min(0).optional(),
    minChildComponents: z.number().int().min(1).optional(),
    minForwardedRatio: z.number().min(0).max(1).optional(),
    minForwardedProps: z.number().int().min(1).optional(),
    minTunnelDepth: z.number().int().min(1).max(10).optional(),
    minWorkflowSignals: z.number().int().min(0).max(8).optional(),
  }).optional(),
  serviceWrapperExplosion: z.object({
    minGroupSize: z.number().int().min(1).optional(),
    maxFanIn: z.number().int().min(0).optional(),
    maxLineCount: z.number().int().min(1).optional(),
  }).optional(),
  uiDomainCoupling: z.object({
    minCoupledImports: z.number().int().min(1).optional(),
  }).optional(),
  routeConvergence: z.object({
    maxBfsDepth: z.number().int().min(1).max(20).optional(),
    minEntrypoints: z.number().int().min(2).optional(),
  }).optional(),
  annotationRisk: z.object({
    minImportance: z.number().int().min(0).optional(),
    minQualityScore: z.number().min(0).max(10).optional(),
    /**
     * Per-kind quality bar override; takes precedence over `minQualityScore`
     * for matching kinds. Allowed keys: types, ui, api-handler, adapter,
     * service-mgr, infra, service, domain, generic.
     */
    minQualityScoreByKind: z.object({
      types: z.number().min(0).max(10).optional(),
      ui: z.number().min(0).max(10).optional(),
      'api-handler': z.number().min(0).max(10).optional(),
      adapter: z.number().min(0).max(10).optional(),
      'service-mgr': z.number().min(0).max(10).optional(),
      infra: z.number().min(0).max(10).optional(),
      service: z.number().min(0).max(10).optional(),
      domain: z.number().min(0).max(10).optional(),
      generic: z.number().min(0).max(10).optional(),
    }).partial().optional(),
    derivedStalePenalty: z.number().min(0).max(10).optional(),
    derivedStaleHopLimit: z.number().int().min(0).max(5).optional(),
  }).optional(),
  unclearArchitecture: z.object({
    minDomainTags: z.number().int().min(1).optional(),
  }).optional(),
  secretConfigBoundary: z.object({
    minEvidenceScore: z.number().min(0).optional(),
    flagGenericPublicAuthEnv: z.boolean().optional(),
  }).optional(),
  authorizationPolicyDrift: z.object({
    minModules: z.number().int().min(2).optional(),
    minFeatureGroups: z.number().int().min(2).optional(),
    allowGeneralSubject: z.boolean().optional(),
    requireAuthzSignal: z.boolean().optional(),
  }).optional(),
  trustBoundaryValidation: z.object({
    minEvidenceScore: z.number().min(0).optional(),
    requireRouteOrSideEffect: z.boolean().optional(),
  }).optional(),
  privilegedClientSideEffect: z.object({
    minEvidenceScore: z.number().min(0).optional(),
    includeMutationOnly: z.boolean().optional(),
    allowGenericStorageName: z.boolean().optional(),
  }).optional(),
  sensitiveBrowserStorage: z.object({
    requireSensitiveKey: z.boolean().optional(),
    minAnnotationStorageSignals: z.number().int().min(1).optional(),
  }).optional(),
  serverClientBoundary: z.object({
    minTargets: z.number().int().min(1).optional(),
    allowGenericStorageName: z.boolean().optional(),
  }).optional(),
  sourceDisclosureSurface: z.object({
    minEvidenceScore: z.number().int().min(1).optional(),
  }).optional(),
  annotationSecretHygiene: z.object({
    enabled: z.boolean().optional(),
  }).optional(),
});

const AnalyzeArchitectureConfigSchema = z.object({
  strictness: z.enum(['loose', 'normal', 'strict']).optional(),
  thresholds: AnalyzeArchitectureThresholdsSchema.optional(),
});

const ContextQualityWeightsSchema = z.object({
  or: z.number().min(0).optional(),
  cap: z.number().min(0).optional(),
  volume: z.number().min(0).optional(),
  low: z.number().min(0).optional(),
  unresolved: z.number().min(0).optional(),
  test: z.number().min(0).optional(),
  bytes: z.number().min(0).optional(),
  chain: z.number().min(0).optional(),
  map: z.number().min(0).optional(),
  inspect: z.number().min(0).optional(),
  impact: z.number().min(0).optional(),
  anchor: z.number().min(0).optional(),
  recover: z.number().min(0).optional(),
  end: z.number().min(0).optional(),
}).partial();

const ContextQualityThresholdSchema = z.object({
  threshold: z.number().min(0).max(1).optional(),
  warningThreshold: z.number().min(0).max(1).optional(),
  minAnchors: z.number().int().min(0).optional(),
  byteBudget: z.number().int().min(1).optional(),
}).partial();

const ContextQualityEnforcementSchema = z.object({
  mode: z.enum(['harness', 'client']).optional(),
}).partial();

const WorkspaceConfigSchema = z.object({
  /** Repo-root-relative path to shared annotation memory (default: repovine.annots.json). */
  annotationsFile: z.string().min(1).optional(),
});

const ContextQualityConfigSchema = z.object({
  weights: ContextQualityWeightsSchema.optional(),
  thresholds: z.object({
    explore: ContextQualityThresholdSchema.optional(),
    implement: ContextQualityThresholdSchema.optional(),
    annotate: ContextQualityThresholdSchema.optional(),
  }).partial().optional(),
  enforcement: ContextQualityEnforcementSchema.optional(),
  recoveryWindow: z.number().int().min(0).max(20).optional(),
  recoveryDiscount: z.number().min(0).max(1).optional(),
  exportSymbolFloodRatio: z.number().min(0).max(1).optional(),
  archResponseOversizeBytes: z.number().int().min(1).optional(),
  lowConfidenceRejectRatio: z.number().min(0).max(1).optional(),
  testPackageRegex: z.string().min(1).optional(),
  retainSessions: z.boolean().optional(),
  persistEvents: z.boolean().optional(),
  maxRequestEchoes: z.number().int().min(0).max(200).optional(),
  purgeSessionsOnMcpStart: z.boolean().optional(),
});

const PropagationConfigSchema = z.object({
  domainStalePolicy: z.enum(['all-tags', 'path-only']).optional(),
  packageDomainHardQueue: z.boolean().optional(),
  consumerReachMaxDepth: z.number().int().min(1).max(128).optional(),
  hubModulesExtra: z.array(z.string()).optional(),
  hubModulesDeny: z.array(z.string()).optional(),
});

const AnnotationsConfigSchema = z.object({
  propagation: PropagationConfigSchema.optional(),
});

/**
 * External plugin wiring. `defaults` toggles the bundled TS/Python/IaC preset;
 * `add` names third-party plugins that must already be npm-installed in the ANALYZED repo (resolved
 * from its node_modules); `disable` drops a plugin (bundled or added) by its id. Arbitrary npm
 * is never auto-installed — install + listing here is the user's trust decision.
 *
 * `retract` removes single declared facts by catalog key (`dir:node_modules`,
 * `resource-kind:<namespace>/<provider>/<kind>`, `trigger-type:<namespace>/<provider>/<type>`,
 * `value:<axis>=<value>`), for the case where a plugin's claim is wrong for one repository but the
 * plugin itself is wanted. Disabling a capability keeps its declarations; this is the explicit way
 * to drop one, and a selector that matches nothing is reported rather than ignored.
 */
const PluginsConfigSchema = z.object({
  defaults: z.boolean().optional(),
  add: z.array(z.string()).optional(),
  disable: z.array(z.string()).optional(),
  retract: z.array(z.string()).optional(),
});

const RepoContextConfigSchema = z.object({
  workspace: WorkspaceConfigSchema.optional(),
  /** External source/IaC plugin wiring. Bundled languages need no entry (auto by file-match). */
  plugins: PluginsConfigSchema.optional(),
  /** Graph build pipeline: `scan` (Stage 1 index) + `linking` (Stage 2 infra→code edges). */
  build: BuildConfigSchema.optional(),
  mcp: McpConfigSchema.optional(),
  annotations: AnnotationsConfigSchema.optional(),
  /**
   * Enable local Hugging Face embeddings for fuzzy NL entry in `search_context`.
   * Token index (graph + annotations) is always on. Requires optional `@huggingface/transformers`.
   */
  semantic_search_embeddings: z.boolean().optional(),
  // Config block for the architecture detectors behind `analyze_architecture`.
  // The engine reports candidates; it does not perform refactoring on its own.
  analyze_architecture: AnalyzeArchitectureConfigSchema.optional(),
  // Deterministic scoring of repovine MCP context sessions.
  contextQuality: ContextQualityConfigSchema.optional(),
  // Delivery Protocol project config (agents.roles and related). The agents layer reads the raw file
  // and validates role internals with its own messages, so this only registers the key so zod stops
  // stripping it and warning; a strict shape that rejected a role block would drop sibling config to
  // defaults.
  agents: z.record(z.string(), z.unknown()).optional(),
});

export type RepoContextFileConfig = z.infer<typeof RepoContextConfigSchema>;

export type DomainStalePolicy = 'all-tags' | 'path-only';

export interface PropagationConfig {
  domainStalePolicy: DomainStalePolicy;
  packageDomainHardQueue: boolean;
  consumerReachMaxDepth: number;
  hubModulesExtra: string[];
  hubModulesDeny: string[];
}

export const DEFAULT_CONTRACT_HUB_THRESHOLDS = {
  minCrossPackageFanIn: 2,
  minImportance: 12,
} as const;

export const DEFAULT_PROPAGATION_CONFIG: PropagationConfig = {
  domainStalePolicy: 'path-only',
  packageDomainHardQueue: false,
  consumerReachMaxDepth: 32,
  hubModulesExtra: [],
  hubModulesDeny: [],
};

/** In-process MiniLM model; fixed — not configurable in `repovine.config.json`. */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
/** Cards per embedding batch during semantic search index sync. */
export const DEFAULT_EMBEDDING_BATCH_SIZE = 16;

// ── Resolved config (all fields present) ──

export interface ResolvedConfig {
  workspace: {
    /** Repo-root-relative annotations file path. */
    annotationsFile: string;
  };
  build: {
    scan: {
      include: ScanPatternInput[];
      exclude: ScanPatternInput[];
      /** undefined = auto-pick by CPU; 0/1 = inline; >1 = N workers. */
      maxPackageWorkers: number | undefined;
    };
    linking: {
      handlers: { searchRoots: string[] };
      bundles: { scripts: string[]; autoDetect: boolean };
    };
  };
  mcp: {
    verbose: boolean;
    response: {
      mode: 'concise' | 'debug';
      pretty: boolean;
      /** Hard ceiling on serialized `content[0].text`; oversized results return a bounded marker. */
      maxChars: number;
    };
  };
  /** Local Hugging Face embeddings for `search_context` NL fuzzy entry. */
  semanticSearchEmbeddings: boolean;
  /**
   * True when `semanticSearchEmbeddings` came from peer detection rather than from the config file.
   * The build path announces the derived-off case only: a user who wrote `false` chose it, and the
   * embedder error already advertises that key as the way to silence the message.
   */
  semanticSearchEmbeddingsDerived: boolean;
  analyze_architecture: {
    strictness: AnalyzeArchitectureStrictness;
    thresholds: AnalyzeArchitectureThresholds;
  };
  contextQuality: ContextQualityConfig;
  annotations: {
    propagation: PropagationConfig;
  };
  /** External plugin wiring. Resolved from `plugins` in repovine.config.json. */
  plugins: PluginsConfig;
}

/** Resolved external-plugin wiring. `defaults` defaults to true (bundled preset on). */
export interface PluginsConfig {
  defaults: boolean;
  add: string[];
  disable: string[];
  /** Catalog keys this repository retracts from the declarations its plugins ship. */
  retract: string[];
}

// ── Defaults ──

const DEFAULTS: ResolvedConfig = {
  workspace: {
    annotationsFile: ANNOTATIONS_FILENAME,
  },
  build: {
    scan: {
      include: [],
      exclude: [],
      maxPackageWorkers: undefined,
    },
    linking: {
      handlers: { searchRoots: [] },
      bundles: { scripts: [], autoDetect: true },
    },
  },
  mcp: {
    verbose: false,
    response: {
      mode: 'concise',
      pretty: false,
      maxChars: DEFAULT_MAX_RESPONSE_CHARS,
    },
  },
  semanticSearchEmbeddings: true,
  semanticSearchEmbeddingsDerived: true,
  analyze_architecture: {
    strictness: 'normal',
    thresholds: resolveAnalyzeArchitectureThresholds(undefined),
  },
  contextQuality: DEFAULT_CONTEXT_QUALITY_CONFIG,
  annotations: {
    propagation: { ...DEFAULT_PROPAGATION_CONFIG },
  },
  plugins: { defaults: true, add: [], disable: [], retract: [] },
};

const CONFIG_FILENAME = 'repovine.config.json';

// ── Loader ──

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Zod object schemas strip unknown keys; surface those omissions without rejecting valid siblings. */
function collectUnknownConfigPaths(raw: unknown, parsed: unknown, prefix = ''): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    return raw.flatMap((value, index) =>
      collectUnknownConfigPaths(value, parsed[index], `${prefix}[${index}]`));
  }
  if (!isConfigObject(raw) || !isConfigObject(parsed)) return [];
  const unknown: string[] = [];
  for (const [key, rawValue] of Object.entries(raw)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(parsed, key)) {
      unknown.push(keyPath);
      continue;
    }
    unknown.push(...collectUnknownConfigPaths(rawValue, parsed[key], keyPath));
  }
  return unknown;
}

export function loadConfig(configDir: string): ResolvedConfig {
  const filePath = path.join(configDir, CONFIG_FILENAME);
  let fileConfig: RepoContextFileConfig = {};

  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const parsed = RepoContextConfigSchema.safeParse(raw);
      if (parsed.success) {
        fileConfig = parsed.data;
        const unknownPaths = collectUnknownConfigPaths(raw, parsed.data);
        if (unknownPaths.length > 0) {
          logPipelineWarn(
            `  Config: unknown ${unknownPaths.length === 1 ? 'key' : 'keys'} in ${filePath} (ignored): ${unknownPaths.join(', ')}`,
          );
        }
        logPipeline(formatPipelineMuted(`Config loaded: ${filePath}`));
      } else {
        logPipelineWarn(`  Config: validation errors in ${filePath}, using defaults`);
        logPipelineWarn(`    ${z.prettifyError(parsed.error)}`);
      }
    } catch (e) {
      logPipelineWarn(`  Config: failed to parse ${filePath} — ${(e as Error).message}`);
    }
  }

  return resolveConfig(fileConfig, configDir);
}

function resolveWorkspaceAnnotationsFile(
  fileValue: string | undefined,
  repoRoot: string,
): string {
  const envValue = process.env.REPOVINE_ANNOTATIONS_FILE?.trim();
  const candidate = envValue || fileValue?.trim() || ANNOTATIONS_FILENAME;
  try {
    resolveAnnotationsFilePath(repoRoot, candidate);
    return candidate;
  } catch (e) {
    logPipelineWarn(
      `  Config: invalid workspace.annotationsFile "${candidate}" (${(e as Error).message}), using ${ANNOTATIONS_FILENAME}`,
    );
    return ANNOTATIONS_FILENAME;
  }
}

/**
 * Merge file config + env overrides + CLI overrides into a fully resolved config.
 * Precedence: defaults < file < env < CLI.
 */
function resolvePropagationConfig(file?: z.infer<typeof PropagationConfigSchema>): PropagationConfig {
  return {
    domainStalePolicy: file?.domainStalePolicy ?? DEFAULT_PROPAGATION_CONFIG.domainStalePolicy,
    packageDomainHardQueue: file?.packageDomainHardQueue ?? DEFAULT_PROPAGATION_CONFIG.packageDomainHardQueue,
    consumerReachMaxDepth: file?.consumerReachMaxDepth ?? DEFAULT_PROPAGATION_CONFIG.consumerReachMaxDepth,
    hubModulesExtra: file?.hubModulesExtra ?? [...DEFAULT_PROPAGATION_CONFIG.hubModulesExtra],
    hubModulesDeny: file?.hubModulesDeny ?? [...DEFAULT_PROPAGATION_CONFIG.hubModulesDeny],
  };
}

function resolveConfig(file: RepoContextFileConfig, repoRoot: string): ResolvedConfig {
  const envVerbose = process.env.REPOVINE_VERBOSE;
  const envMcpResponse = process.env.REPOVINE_MCP_RESPONSE;

  const analyzeArchitectureFile: AnalyzeArchitectureFileConfig | undefined = file.analyze_architecture;
  const analyzeArchitecture = {
    strictness: analyzeArchitectureFile?.strictness ?? DEFAULTS.analyze_architecture.strictness,
    thresholds: resolveAnalyzeArchitectureThresholds(analyzeArchitectureFile),
  };
  const contextQuality = resolveContextQualityConfig(file.contextQuality);

  const fileResponse = file.mcp?.response;
  let mcpResponseMode = fileResponse?.mode ?? DEFAULTS.mcp.response.mode;
  if (envMcpResponse === 'concise' || envMcpResponse === 'debug') {
    mcpResponseMode = envMcpResponse;
  } else if (envMcpResponse) {
    console.warn(`  Config: invalid REPOVINE_MCP_RESPONSE="${envMcpResponse}", using ${mcpResponseMode}`);
  }
  const defaultPretty = mcpResponseMode === 'debug' ? true : DEFAULTS.mcp.response.pretty;

  const envMaxChars = process.env.REPOVINE_MCP_MAX_CHARS;
  let mcpResponseMaxChars = fileResponse?.maxChars ?? DEFAULTS.mcp.response.maxChars;
  if (envMaxChars) {
    const parsed = Number(envMaxChars);
    if (Number.isFinite(parsed) && parsed >= MIN_RESPONSE_CHARS) {
      mcpResponseMaxChars = Math.floor(parsed);
    } else {
      console.warn(`  Config: invalid REPOVINE_MCP_MAX_CHARS="${envMaxChars}", using ${mcpResponseMaxChars}`);
    }
  }

  return {
    workspace: {
      annotationsFile: resolveWorkspaceAnnotationsFile(file.workspace?.annotationsFile, repoRoot),
    },
    build: {
      scan: {
        include: file.build?.scan?.include ?? DEFAULTS.build.scan.include,
        exclude: file.build?.scan?.exclude ?? DEFAULTS.build.scan.exclude,
        maxPackageWorkers: file.build?.scan?.maxPackageWorkers ?? DEFAULTS.build.scan.maxPackageWorkers,
      },
      linking: {
        handlers: {
          searchRoots: file.build?.linking?.handlers?.searchRoots ?? DEFAULTS.build.linking.handlers.searchRoots,
        },
        bundles: {
          scripts: file.build?.linking?.bundles?.scripts ?? DEFAULTS.build.linking.bundles.scripts,
          autoDetect: file.build?.linking?.bundles?.autoDetect ?? DEFAULTS.build.linking.bundles.autoDetect,
        },
      },
    },
    mcp: {
      verbose: envVerbose === '1' ? true : file.mcp?.verbose ?? DEFAULTS.mcp.verbose,
      response: {
        mode: mcpResponseMode,
        pretty: fileResponse?.pretty ?? defaultPretty,
        maxChars: mcpResponseMaxChars,
      },
    },
    semanticSearchEmbeddings: resolveSemanticSearchEmbeddings(file, repoRoot),
    semanticSearchEmbeddingsDerived: file.semantic_search_embeddings === undefined,
    analyze_architecture: analyzeArchitecture,
    contextQuality,
    annotations: {
      propagation: resolvePropagationConfig(file.annotations?.propagation),
    },
    plugins: {
      defaults: file.plugins?.defaults ?? DEFAULTS.plugins.defaults,
      add: file.plugins?.add ?? [...DEFAULTS.plugins.add],
      disable: file.plugins?.disable ?? [...DEFAULTS.plugins.disable],
      retract: file.plugins?.retract ?? [...DEFAULTS.plugins.retract],
    },
  };
}

/**
 * Semantic search needs the optional `@huggingface/transformers` peer, so the default follows
 * whether that peer resolves. A literal `true` named a capability that a plain `npm i repovine`
 * never has: every default install then reported its own correct state as a sync failure.
 *
 * An explicit `semantic_search_embeddings` in the config file still wins either way, so forcing it
 * on keeps producing the actionable "install the peer" error instead of silence.
 */
function resolveSemanticSearchEmbeddings(file: RepoContextFileConfig, repoRoot: string): boolean {
  if (file.semantic_search_embeddings !== undefined) return file.semantic_search_embeddings;
  return describeTransformersInstall(repoRoot).resolved;
}

type ContextQualityFileConfig = NonNullable<RepoContextFileConfig['contextQuality']>;

function resolveContextQualityConfig(file?: ContextQualityFileConfig): ContextQualityConfig {
  const defaults = DEFAULT_CONTEXT_QUALITY_CONFIG;
  const enforcement = {
    ...defaults.enforcement,
    ...(file?.enforcement ?? {}),
  };
  const purgeSessionsOnMcpStart =
    file?.purgeSessionsOnMcpStart ?? enforcement.mode === 'client';
  return {
    weights: {
      ...defaults.weights,
      ...(file?.weights ?? {}),
    },
    thresholds: {
      explore: {
        ...defaults.thresholds.explore,
        ...(file?.thresholds?.explore ?? {}),
      },
      implement: {
        ...defaults.thresholds.implement,
        ...(file?.thresholds?.implement ?? {}),
      },
      annotate: {
        ...defaults.thresholds.annotate,
        ...(file?.thresholds?.annotate ?? {}),
      },
    },
    enforcement,
    purgeSessionsOnMcpStart,
    recoveryWindow: file?.recoveryWindow ?? defaults.recoveryWindow,
    recoveryDiscount: file?.recoveryDiscount ?? defaults.recoveryDiscount,
    exportSymbolFloodRatio: file?.exportSymbolFloodRatio ?? defaults.exportSymbolFloodRatio,
    archResponseOversizeBytes: file?.archResponseOversizeBytes ?? defaults.archResponseOversizeBytes,
    lowConfidenceRejectRatio: file?.lowConfidenceRejectRatio ?? defaults.lowConfidenceRejectRatio,
    testPackageRegex: file?.testPackageRegex ?? defaults.testPackageRegex,
    retainSessions: file?.retainSessions ?? defaults.retainSessions,
    persistEvents: file?.persistEvents ?? defaults.persistEvents,
    maxRequestEchoes: file?.maxRequestEchoes ?? defaults.maxRequestEchoes,
  };
}

export { CONFIG_FILENAME, DEFAULTS as CONFIG_DEFAULTS };
