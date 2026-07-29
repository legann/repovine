import type { ResourceIdentity } from './plugin/resource-identity.js';

export type SymbolKind =
  | 'function' | 'class' | 'interface' | 'type'
  | 'const' | 'enum' | 'component' | 'unknown';
export interface PackageInfo {
  name: string;
  path: string;
  version?: string;
  /** Logical id of the source plugin that discovered this package (e.g. 'typescript'). */
  sourcePluginId?: string;
}

/** A discovered source file as a producer reports it: location and ownership, no identity. The
 * engine mints `moduleId` from these fields, so the graph id never depends on plugin cooperation. */
export interface PendingModuleDraft {
  filePath: string;
  /** Present for SFCs: the virtual `.ts` path used by ts-morph. */
  virtualPath?: string;
  pkg: PackageInfo;
  relPath: string;
  /** Logical id of the source plugin that owns this file; drives worker dispatch. */
  sourcePluginId?: string;
}

/** A discovered source file awaiting AST extraction: a producer's draft after the engine stamped
 * `moduleId`. Handed back to the same plugin's extract() pass (which is worker_threads-safe), where
 * the id serves as the correlation key for deltas and source text. */
export interface PendingModule extends PendingModuleDraft {
  moduleId: string;
}

export interface ParamInfo {
  name: string;
  type: string;
}

export interface FieldInfo {
  name: string;
  type: string;
  optional: boolean;
}

export interface MemberInfo {
  name: string;
  kind: 'method' | 'property';
  access: 'private' | 'protected' | 'public';
  signature?: string;
  lineRange: { start: number; end: number };
}

export interface InternalInfo {
  name: string;
  kind: 'function' | 'variable' | 'destructuring';
  signature?: string;
  lineRange: { start: number; end: number };
}

export interface ConditionalRender {
  component: string;
  condition: string;
  renderedIn: string;
  lineRange: { start: number; end: number };
}

export interface ExportInfo {
  name: string;
  kind: SymbolKind;
  signature?: string;
  params?: ParamInfo[];
  returnType?: string;
  typeValue?: string;
  fields?: FieldInfo[];
  implementsInterfaces?: string[];
  calls?: string[];
  /** Distinct callee names found before the producer's per-declaration cap. Present only when it
   * exceeds `calls.length`, so a consumer can report the dropped count instead of inferring it. */
  callsTotal?: number;
  privateMembers?: MemberInfo[];
  internals?: InternalInfo[];
  lineRange: { start: number; end: number };
  isDefault: boolean;
  defaultLocalName?: string;
}

export interface ImportInfo {
  moduleSpecifier: string;
  resolvedModuleId?: string;
  importedNames: string[];
  isTypeOnly: boolean;
  isExternal: boolean;
}

/**
 * A re-export declaration (`export * from './x'` or `export { a, b } from './x'`). The barrel that
 * carries it re-exports the target's symbols; the engine follows these to resolve a cross-barrel
 * import to the defining leaf. Captured syntactically like imports — no name resolution at the
 * producer boundary.
 */
export interface ReExportInfo {
  moduleSpecifier: string;
  resolvedModuleId?: string;
  /** Named re-exports (`export { a, b } from`); undefined for `export * from` (star). */
  names?: string[];
  /** True for `export * from` (re-exports the whole module surface). */
  isStar: boolean;
  isExternal: boolean;
}

export interface ModuleInfo {
  id: string;
  packageName: string;
  filePath: string;
  relativeFilePath: string;
  contentHash: string;
  imports: ImportInfo[];
  exports: ExportInfo[];
  /** Re-export declarations carried by this module (barrels). Empty/absent for non-barrels. */
  reExports?: ReExportInfo[];
  /** Module-level forward calls: callee names not inside any exported declaration (top-level
   * statements, non-exported local helpers). Per-export calls live on `ExportInfo.calls`; this
   * bucket is what makes a non-exported helper's calls visible to reverse-by-name lookup. */
  calls?: string[];
  /** Distinct callee names found before the producer's cap; present only when it exceeds
   * `calls.length`. */
  callsTotal?: number;
  semanticHints?: SemanticHints;
  /** Logical id of the source plugin that produced this module ('typescript' | 'python' | …).
   * Lets language-specific downstream layers (frontend route inference, UI detectors) stay
   * TS-only and keep non-TS modules deterministically empty. */
  sourcePluginId?: string;
}

/**
 * Producer output for ONE module: language semantics only. A source plugin emits these; the engine
 * stamps all mechanical / language-agnostic metadata — `id`, `filePath`, `relativeFilePath`,
 * `packageName`, `contentHash`, `sourcePluginId` provenance — at the Stage-1 boundary when it
 * assembles the full `ModuleInfo`. The producer echoes back `moduleId` purely as a
 * correlation key to the engine-minted `PendingModule.moduleId`; it does NOT mint ids or paths.
 * Splitting this from `ModuleInfo` is what makes "plugin cannot set a mechanical field" a
 * compile-time guarantee rather than a convention.
 */
export interface SemanticModuleDelta {
  moduleId: string;
  imports: ImportInfo[];
  exports: ExportInfo[];
  /** Re-export declarations (see `ModuleInfo.reExports`). */
  reExports?: ReExportInfo[];
  /** Module-level forward calls (see `ModuleInfo.calls`). Producer-owned semantics; the engine
   * carries it onto the assembled `ModuleInfo` unchanged. */
  calls?: string[];
  /** See `ModuleInfo.callsTotal`. */
  callsTotal?: number;
  semanticHints?: SemanticHints;
  /**
   * Set when this extraction is incomplete and must not be cached (e.g. a transient subprocess
   * failure that yields empty imports/exports). The engine then stamps an empty `contentHash` so
   * the next incremental run re-parses instead of reusing a poisoned result. Default false.
   */
  transient?: boolean;
}

export interface RouteInfo {
  path: string;
  component: string;
  /**
   * Where the route's existence is stated: written in code, or implied by the file's place in the
   * tree. The two are different questions from {@link RouteInfo.syntax}, which says what code form
   * carried a `code` declaration and has no answer for a `layout` one.
   */
  declaredIn?: RouteDeclarationSite;
  /**
   * The code form that carried the declaration. Absent when `declaredIn` is `layout`, because there
   * is no declaration to have a form. Named by shape, so an ecosystem whose routes arrive as markup
   * reports `markup` whatever its markup dialect is called.
   */
  syntax?: RouteDeclarationSyntax;
  kind?: 'frontend' | 'api';
  method?: string;
  /** File-route framework token used by MCP entrypoint output, e.g. nextjs-app, sveltekit. */
  framework?: string;
  /** File-route slot used by MCP entrypoint output and ids, e.g. page, route, server-api. */
  fileType?: string;
  /** Template names this route's handler/render unit renders, when statically known. */
  rendersTemplate?: string[];
}

/** Where a route declaration lives. */
export type RouteDeclarationSite = 'code' | 'layout';

/** The code form a route declaration takes: markup element, table entry, decorator, or call. */
export type RouteDeclarationSyntax = 'markup' | 'table' | 'decorator' | 'call';

/**
 * The runtime calls the built-in JavaScript producer recognises. Listed for autocomplete only.
 *
 * Open: a producer names the call in its own ecosystem's spelling, and the host pairs it with a
 * resource through a `runtimeActions` declaration that states which identity namespace the call
 * writes to. Nothing branches on the string.
 */
export type KnownRuntimeActionName =
  | 'sqs.sendMessage'
  | 'sns.publish'
  | 'eventbridge.putEvents'
  | 'lambda.invoke';

export type RuntimeActionName = KnownRuntimeActionName | (string & {});

export interface RuntimeAction {
  action: RuntimeActionName;
  envVar?: string;
  lineRange?: { start: number; end: number };
}

/**
 * The UI framework a producer recognised in a module.
 *
 * Open: the listed names are what the built-in JavaScript producer detects, and a producer for a
 * framework nobody here has heard of spells its own. The host stores the string and shows it; no
 * behaviour is keyed on which one it is.
 */
export type KnownUiFramework =
  | 'react'
  | 'next'
  | 'vue'
  | 'nuxt'
  | 'angular'
  | 'svelte'
  | 'unknown';
export type UiFramework = KnownUiFramework | (string & {});

export interface UiSignalBase {
  lineRange?: { start: number; end: number };
}

/**
 * The lifecycle mechanism a producer recognised. Open for the same reason as `UiFramework`: the
 * names carry the framework that owns the mechanism, and a producer for another one spells its own.
 */
export type KnownUiLifecycleEffectKind =
  | 'react-effect'
  | 'vue-watch'
  | 'vue-lifecycle'
  | 'svelte-lifecycle'
  | 'angular-lifecycle'
  | 'generic-effect';
export type UiLifecycleEffectKind = KnownUiLifecycleEffectKind | (string & {});

export interface UiLifecycleEffect extends UiSignalBase {
  kind: UiLifecycleEffectKind;
  name: string;
  dataAccessCount?: number;
  navigationCount?: number;
  timerCount?: number;
  subscriptionCount?: number;
}

export interface UiDataAccess extends UiSignalBase {
  kind:
    | 'fetch'
    | 'http-client'
    | 'query'
    | 'mutation'
    | 'graphql'
    | 'storage'
    | 'api-client';
  callee: string;
  target?: string;
}

export interface UiNavigationAction extends UiSignalBase {
  kind: 'navigate' | 'router-push' | 'redirect' | 'history';
  callee: string;
  target?: string;
}

export interface UiTimerAction extends UiSignalBase {
  kind: 'timeout' | 'interval' | 'animation-frame';
  callee: string;
}

export interface UiSubscriptionAction extends UiSignalBase {
  kind: 'event-listener' | 'observable' | 'websocket' | 'realtime';
  callee: string;
}

/** The state mechanism a producer recognised. Open, like the lifecycle axis beside it. */
export type KnownUiStateSignalKind =
  | 'react-state'
  | 'react-reducer'
  | 'react-context'
  | 'vue-ref'
  | 'vue-reactive'
  | 'vue-provide'
  | 'svelte-store'
  | 'angular-service-state'
  | 'rxjs-state'
  | 'generic-state';
export type UiStateSignalKind = KnownUiStateSignalKind | (string & {});

export interface UiStateSignal extends UiSignalBase {
  kind: UiStateSignalKind;
  name?: string;
}

export interface UiServiceWrapperHint {
  candidate: boolean;
  role: 'service' | 'client' | 'api' | 'adapter' | 'manager' | 'provider';
  lineCount: number;
  delegateCallCount: number;
}

export interface UiComponentPropHint extends UiSignalBase {
  name: string;
  kind: 'data' | 'callback' | 'setter' | 'state-flag' | 'unknown';
  source: 'destructured-param' | 'props-object' | 'type-only' | 'unknown';
}

export interface UiChildComponentHint extends UiSignalBase {
  componentName: string;
  passedProps: string[];
  passedCallbacks: string[];
  forwardedProps: string[];
  spreadProps: string[];
}

export interface UiComponentLocalSignals {
  localState: number;
  effects: number;
  dataAccess: number;
  navigation: number;
  timers: number;
  subscriptions: number;
  serviceImports: number;
  validationOrMapping: number;
}

export interface UiComponentHint extends UiSignalBase {
  framework: UiFramework;
  name: string;
  props: UiComponentPropHint[];
  childComponents: UiChildComponentHint[];
  localSignals: UiComponentLocalSignals;
}

export interface SecuritySignal extends UiSignalBase {
  kind:
    | 'secret-env'
    | 'public-env'
    | 'browser-storage'
    | 'browser-storage-sensitive'
    | 'cookie-access'
    | 'validation'
    | 'authz'
    | 'source-disclosure';
  name?: string;
  callee?: string;
  target?: string;
}

export interface UiHints {
  framework?: UiFramework;
  lifecycleEffects?: UiLifecycleEffect[];
  dataAccess?: UiDataAccess[];
  navigation?: UiNavigationAction[];
  timers?: UiTimerAction[];
  subscriptions?: UiSubscriptionAction[];
  state?: UiStateSignal[];
  serviceWrapper?: UiServiceWrapperHint;
  components?: UiComponentHint[];
}

/**
 * SSR / runtime markers detected from source text.
 * These are framework-agnostic execution hints — they say WHERE/HOW a module runs,
 * not WHAT it does (that's the domain).
 */
export interface SsrMarkers {
  /** Contains `'use server'` directive at file top (Next.js Server Action / React Server Component). */
  useServer?: boolean;
  /** Contains `'use client'` directive at file top (Next.js Client Component). */
  useClient?: boolean;
  /** Exports `getServerSideProps` (Next.js Pages Router SSR). */
  getServerSideProps?: boolean;
  /** Exports `getStaticProps` (Next.js Pages Router SSG). */
  getStaticProps?: boolean;
  /** Exports `getInitialProps` (legacy Next.js SSR). */
  getInitialProps?: boolean;
  /** Exports `loader` (React Router SSR data loader). */
  loader?: boolean;
  /** Exports `action` (React Router form action). */
  action?: boolean;
  /** Uses Qwik `routeLoader$` / `routeAction$` / `server$` macros. */
  qwikServer?: boolean;
  /**
   * Framework-general runtime marker (semanticHints v1): where this module executes. Source plugins
   * derive it from their own conventions (TS: `'use server'`→`'server'`, `'use client'`→`'client'`;
   * a Blazor/other plugin maps its equivalents). Omitted when ambiguous (both or neither), because
   * the load-bearing `useServer`/`useClient` booleans remain authoritative — `runsOn` is an additive,
   * lossy-by-design convenience for non-JS frameworks that have no `use server`/`use client` directive.
   */
  runsOn?: 'server' | 'client';
  /**
   * Framework-general runtime marker (semanticHints v1): module exports a server-side data loader
   * (Next.js `getServerSideProps`/`getStaticProps`/`getInitialProps`, React Router `loader`, Blazor
   * `OnInitializedAsync`, …). Form actions/mutations (React Router `action`) are intentionally excluded.
   */
  dataLoader?: boolean;
}

/**
 * Web frameworks recognised by the built-in source plugins. The `WebFramework` alias is
 * intentionally an open string (same `(string & {})` trick as `KnownInfraKind` below) so external
 * plugins can declare a new framework (e.g. 'spring', 'aspnet', 'express') in `semanticHints` without
 * modifying the core types — backend-route layers read the neutral `routes` slot, not this value.
 */
export type KnownWebFramework = 'fastapi' | 'django' | 'drf';
export type WebFramework = KnownWebFramework | (string & {});

/**
 * Framework-general module hints written by source plugins and read by core/layer consumers.
 *
 * This is a public, versioned contract (semanticHints v1 — see `SEMANTIC_HINTS_VERSION` and the Zod
 * schema in `source-plugin/semantic-hints-schema.ts`).
 *
 * The slots differ in reach. `envVars`, `effectImports` and `webFramework` carry values any
 * ecosystem produces. `routes` and `hasRoutes` assume a framework that serves requests.
 * `conditionalRenders`, `security`, `ssr` and `ui` describe web and JavaScript shapes in their own
 * field types, and `runtimeActions.action` is a closed set of four AWS calls — a producer outside
 * that ecosystem filling it fails fact validation. `docs/plugin-authoring.md` holds the per-slot
 * table. Keep additions neutral rather than framework-specific, and say which reach a new slot has.
 */
export interface SemanticHints {
  hasRoutes?: boolean;
  routes?: RouteInfo[];
  conditionalRenders?: ConditionalRender[];
  envVars?: string[];
  runtimeActions?: RuntimeAction[];
  ui?: UiHints;
  security?: SecuritySignal[];
  /** SSR / runtime markers. Present only when at least one marker matches. */
  ssr?: SsrMarkers;
  /** Side-effect kinds conservatively inferred from unambiguous imports (e.g. Python `subprocess`,
   * `requests`). Lets source plugins without full content analysis feed the declared-`pure`
   * annotation consistency check honestly. `kind` follows the SideEffect vocabulary. */
  effectImports?: Array<{ kind: string; source: string }>;
  /** Web framework detected from imports/attributes. Open string: built-ins emit FastAPI / Django /
   * DRF, external plugins may declare any framework (Spring, ASP.NET, …) without a core-type change. */
  webFramework?: WebFramework;
}

/**
 * Known built-in IaC kinds. The InfraKind alias is intentionally an open string so external
 * plugins can introduce new kinds (e.g. 'pulumi', 'bicep') without modifying the core types.
 * The `(string & {})` trick preserves autocomplete for known values while accepting any string.
 */
export type KnownInfraKind =
  | 'aws-sam'
  | 'cloudformation'
  | 'kubernetes'
  | 'helm'
  | 'docker-compose'
  | 'dockerfile'
  | 'terraform'
  | 'vercel';
export type InfraKind = KnownInfraKind | (string & {});

export type KnownInfraResourceKind =
  | 'lambda'
  | 'queue'
  | 'topic'
  | 'table'
  | 'api'
  | 'bucket'
  | 'role'
  | 'secret'
  | 'k8s-deployment'
  | 'k8s-service'
  | 'k8s-crd'
  | 'helm-release'
  | 'vercel-function'
  | 'vercel-cron'
  | 'vercel-route'
  | 'other';
export type InfraResourceKind = KnownInfraResourceKind | (string & {});

export type KnownInfraTriggerType =
  | 'api'
  | 'sqs'
  /** Standalone EventBridge Rule with ScheduleExpression. */
  | 'schedule'
  /** Standalone EventBridge Rule with EventPattern (event-bus subscription). */
  | 'event-bus'
  /** AWS::Lambda::EventSourceMapping pointing at a DynamoDB Table stream. */
  | 'dynamodb-stream'
  /** AWS::Lambda::EventSourceMapping pointing at a Kinesis Stream. */
  | 'kinesis-stream'
  /** AWS::ApiGatewayV2::Route ($connect, $disconnect, $default, custom). */
  | 'websocket'
  | 'other';
export type InfraTriggerType = KnownInfraTriggerType | (string & {});

export interface InfraTrigger {
  name: string;
  type: InfraTriggerType;
  method?: string;
  path?: string;
  schedule?: string;
  /**
   * Logical id of the upstream resource that fires this trigger. Set for queue/stream sources
   * (SQS, DynamoDB stream, Kinesis), the API resource that owns a route, or the EventBridge
   * rule that targets the Lambda. Used by stage2 to derive `consumes` edges.
   */
  queueRef?: string;
}

/** Access a declaring resource holds on a referenced resource, read from grant verbs. */
export type InfraAccessMode = 'read' | 'write' | 'read-write';

export interface InfraEnvRef {
  varName: string;
  refType: 'ref' | 'getatt' | 'sub' | 'literal';
  targetLogicalId?: string;
  /**
   * Access granted to `targetLogicalId`, derived from the declaring resource's grant document
   * (policy-template name, inline `Statement` actions, or a referenced managed policy). Absent
   * means no grant was parsed for this target — consumers report that as unread, never as a mode.
   */
  access?: InfraAccessMode;
}

/**
 * Ecosystem label a plugin puts on the resources it emits.
 *
 * Open, like `InfraKind`: the listed members are what the built-ins use, and a plugin adds its own
 * by spelling it. The host stores and compares the string and never branches on its value — what a
 * provider means is said in declarations, not read from the name.
 */
export type KnownInfraProvider = 'aws' | 'k8s' | 'generic' | 'terraform' | 'vercel';
export type InfraProvider = KnownInfraProvider | (string & {});

export interface InfraResource {
  id: string;
  kind: InfraResourceKind;
  provider: InfraProvider;
  /**
   * Identity of this resource, computed by the plugin that emitted it.
   *
   * The plugin knows what makes one of its resources distinct; the host does not. `namespace` is the
   * stable identity domain (`aws-lambda`, `k8s`, `vercel`), `localKey` is opaque within it, and the
   * host mints the graph id from the pair with `makeResourceId`.
   */
  identity: ResourceIdentity;
  /** Fingerprint of this resource's IaC fragment only (not the whole template file). Used for runtime-resource annotation freshness. */
  contentHash: string;
  attributes: Record<string, string>;
  envVars?: string[];
  links?: string[];
  triggers?: InfraTrigger[];
  envRefs?: InfraEnvRef[];
}

export interface InfraModuleInfo {
  id: string;
  kind: InfraKind;
  filePath: string;
  relativeFilePath: string;
  contentHash: string;
  resources: InfraResource[];
}

/**
 * Producer output for ONE infra document: infra semantics only. An IaC parser emits this; the
 * engine stamps the mechanical / agnostic metadata — `id` (`infra:<kind>:<relPath>`), `filePath`,
 * `relativeFilePath`, and the module-level `contentHash` (raw-file fingerprint, computed once per
 * file like template artifacts) — when it assembles the full `InfraModuleInfo` in
 * `collectInfraModules`. Per-resource fingerprints (`InfraResource.contentHash`) stay
 * producer-owned: they fingerprint a specific resource fragment, which is infra semantics, not
 * file-level mechanics.
 */
export interface SemanticInfraDelta {
  kind: InfraKind;
  resources: InfraResource[];
}

/**
 * Declarative file selectors. The scanner first computes the union of all registered parsers'
 * fileMatch entries to decide which files are infra candidates at all. Then, per file, only
 * parsers whose fileMatch includes it (or which declare no fileMatch) get to run supports().
 *
 * A selector is also how specific the claim is. `fileNames` and `fileNamePatterns` name the file;
 * `extensions` names the format it is written in. When two parsers ask for different loaders on one
 * file, the one that named the file decides, and two claims of equal specificity are a refusal.
 */
export interface IaCFileMatch {
  /** Lowercased extensions including the leading dot, e.g. ['.yaml', '.yml']. */
  extensions?: string[];
  /** Exact base file names, e.g. ['Chart.yaml', 'vercel.json']. */
  fileNames?: string[];
  /** Regex patterns matched against the base file name. */
  fileNamePatterns?: RegExp[];
}

/**
 * Whether another parser may contribute from the same document.
 *
 * `shared` is the default: every parser that supports a document contributes, and the results merge.
 * `exclusive` says the document has one reading, so a second contribution beside it is a conflict
 * the build reports rather than a race the registration order settles.
 */
export const DOCUMENT_CLAIMS = ['shared', 'exclusive'] as const;
export type DocumentClaim = typeof DOCUMENT_CLAIMS[number];

export interface IaCParser {
  kind: InfraKind;
  /**
   * Declarative pre-filter. When present, the parser only sees files whose base name is
   * matched. When absent, the parser is invoked for every infra candidate file.
   */
  fileMatch?: IaCFileMatch;
  /**
   * Id of the document loader that decodes a claimed file before `supports`/`parse` see it. The
   * host provides `yaml`, `json` and `text`; a plugin registers further loaders with its descriptor.
   */
  loaderId: string;
  /** Whether a second parser may contribute from the same document. Defaults to `shared`. */
  claim?: DocumentClaim;
  supports(filePath: string, doc: unknown): boolean;
  /** Emit infra semantics (kind + resources) for one document. The engine assembles the full
   * `InfraModuleInfo` (id/filePath/relativeFilePath/module contentHash) at the Stage-1 boundary.
   * Returning `null` means this parser has nothing to say, and never silences the others. */
  parse(filePath: string, relPath: string, doc: unknown): SemanticInfraDelta | null;
}

/* ---------------------- IaC plugin registry metadata ---------------------- */

export interface InfraKindDomain {
  domainId: string;
  label: string;
  description: string;
}

export interface ResourceKindMeta {
  /** stage2 attempts to resolve the resource's `handler` attribute to a code module. */
  hasCodeHandler?: boolean;
}

/** Canonical entrypoint kinds a trigger projects into. The array is the single declaration; the
 *  type is derived from it, so a runtime validator reads the same list a consumer types against. */
export const TRIGGER_ENTRY_KINDS = [
  'api',
  'websocket',
  'queue-consumer',
  'schedule',
  'webhook',
  'unknown',
] as const;

export type TriggerEntryKind = typeof TRIGGER_ENTRY_KINDS[number];

export interface TriggerTypeMeta {
  /**
   * Stage2 emits a `consumes` edge from `trigger.queueRef` to the target lambda when this is
   * true (SQS, DynamoDB stream, Kinesis stream are the built-ins).
   */
  isStreamLike?: boolean;
  /** Default entrypoint label used by repovine trigger entrypoint projection. */
  entrypointKind?: TriggerEntryKind;
}
