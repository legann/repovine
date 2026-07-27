/**
 * Heuristic helpers shared by refactoring detectors:
 * - module shape classification (UI surface, build tooling, design system…)
 * - responsibility/feature key normalization
 * - policy/annotation lexical signals
 * - flow path traversal
 */

import type { RepositoryGraph, ModuleInfo, StoredAnnotation, GraphEdge } from '../../types.js';
import { domainLabelFromId, domainNodeId } from '../../graph/node-ids.js';
import { riskEntryTexts } from '../../annotations/format.js';
import { serializeSideEffect } from '../../annotations/side-effect-vocab.js';
// Side-effect import: the built-in source plugins must be registered before this module asks the
// registry which extensions to strip, so a responsibility key never carries one.
import '../../stage1/source/bootstrap.js';
import { getSourceIndexBasenames, stripSourceExtension } from '../../stage1/source/registry.js';

/**
 * JS-family module extensions written once: `.ts/.tsx/.js/.jsx` plus the `.mjs/.cjs/.mts/.cts`
 * variants the TypeScript plugin owns. Classifiers below read a name-plus-extension shape
 * (`users.repository.ts`), where the extension is the signal — the alternation must cover the
 * whole family or half of it classifies differently from the other half.
 */
const JS_EXT = '(?:[mc]?[jt]sx?)';
const CLIENT_SUFFIX_RE = new RegExp(`\\b\\w+-client\\.${JS_EXT}$`);
const SERVICE_SUFFIX_RE = new RegExp(`\\b(api|service|client|repository|repo|storage)\\.${JS_EXT}$`);
const APP_ROUTE_FILE_RE = new RegExp(`(^|/)app/.+/(page|route|layout)\\.${JS_EXT}$`);
const FEATURE_ENTRY_FILE_RE = new RegExp(`(^|/)features/[^/]+/(index|page|route|screen|view)\\.${JS_EXT}$`);
const GENERIC_CLIENT_FILE_RE = new RegExp(`(^|/)(api-client|http-client|env|environment)\\.${JS_EXT}$`);
const BARREL_FILE_RE = new RegExp(`^(index|public-api)\\.${JS_EXT}$`);
const STORAGE_SUFFIX_RE = new RegExp(`(repository|repo|storage|db)\\.${JS_EXT}$`);
const STATE_SUFFIX_RE = new RegExp(`(store|state|slice|atom|signal)\\.${JS_EXT}$`);

/**
 * True for an `imports` edge that represents runtime coupling — i.e. not a build-erased
 * `import type` (flagged `metadata.isTypeOnly` by the graph builder). Architecture detectors count
 * coupling through graph edges; excluding type-only edges keeps them consistent with the
 * `mod.imports`-based detectors, which already filter `imp.isTypeOnly`.
 */
export function isRuntimeImportEdge(edge: GraphEdge): boolean {
  return edge.kind === 'imports' && edge.metadata?.isTypeOnly !== true;
}

/** Runtime coupling into a module: `imports` in-edges that survive the build. */
export function runtimeFanIn(graph: RepositoryGraph, nodeId: string): number {
  return (graph.inEdges.get(nodeId) ?? []).filter(isRuntimeImportEdge).length;
}

/** Runtime coupling out of a module: `imports` out-edges that survive the build. */
export function runtimeFanOut(graph: RepositoryGraph, nodeId: string): number {
  return (graph.outEdges.get(nodeId) ?? []).filter(isRuntimeImportEdge).length;
}

// ── Module shape ──

/** Path tokens shared by api-handler classification and architecture detectors. */
export const API_HANDLER_PATH_TOKENS = [
  '/handlers/', '/handler/', '/lambdas/', '/lambda/', '/api/', '/routes/', '/route/',
  '/controllers/', '/controller/', '/endpoints/', '/endpoint/',
];

const BACKEND_PACKAGE_RE = /@backend\b|^backend$|(?:^|[-/])(?:backend|server|bff|api-server)(?:$|[-/])/;
const FRONTEND_PACKAGE_RE = /@frontend\b|^frontend$|(?:^|[-/])(?:frontend|web|client-ui)(?:$|[-/])/;
const BACKEND_PATH_RE = /(^|\/)(server|servers|backend|bff|api|lambda|lambdas|functions)(\/|$)/;

function normalizeRelPath(mod: ModuleInfo): string {
  return mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
}

function pathHasToken(filePath: string, tokens: readonly string[]): boolean {
  const lower = filePath.toLowerCase();
  return tokens.some(t => lower.includes(t));
}

export function isBackendPackageName(packageName: string): boolean {
  return BACKEND_PACKAGE_RE.test(packageName.toLowerCase());
}

export function isFrontendPackageName(packageName: string): boolean {
  return FRONTEND_PACKAGE_RE.test(packageName.toLowerCase());
}

/** True when the module lives in a server/BFF context (package, path, or use server). */
export function isBackendContext(mod: ModuleInfo): boolean {
  if (mod.semanticHints?.ssr?.useServer) return true;
  return isBackendPackageName(mod.packageName) || BACKEND_PATH_RE.test(normalizeRelPath(mod));
}

/** HTTP/Lambda entry signals used by inferModuleKind and architecture boundary checks. */
export function hasHttpHandlerSignals(mod: ModuleInfo): boolean {
  const relPath = mod.relativeFilePath ?? '';
  const hints = mod.semanticHints;
  if (pathHasToken(relPath, API_HANDLER_PATH_TOKENS)) return true;
  if (hints?.routes?.some(route => route.kind === 'api')) return true;
  if ((hints?.runtimeActions?.length ?? 0) > 0) return true;
  return false;
}

export function isBuildOrToolingModule(relPath: string): boolean {
  const file = relPath.split('/').pop() ?? relPath;
  return /(^|\.)(vite|webpack|rollup|rspack|esbuild|tsup|jest|vitest|playwright|cypress|eslint|prettier|babel|postcss|tailwind|commitlint|storybook|typedoc|tsconfig)\.config\./.test(file)
    || /(^|\/)(vite|webpack|rollup|rspack|esbuild|tsup|jest|vitest|playwright|cypress|eslint|prettier|babel|postcss|tailwind|storybook)\.(config|setup)\./.test(relPath);
}

export function isFrontendSurfaceModule(mod: ModuleInfo): boolean {
  if (isBackendPackageName(mod.packageName) && mod.semanticHints?.ssr?.useClient !== true) {
    return false;
  }

  const rel = normalizeRelPath(mod);
  if (mod.semanticHints?.ssr?.useClient) return true;
  if (/\b(client|api|sdk|graphql|http|rest|rpc)-client\b/.test(rel) || CLIENT_SUFFIX_RE.test(rel)) {
    return false;
  }
  if (BACKEND_PATH_RE.test(rel) && mod.semanticHints?.ssr?.useClient !== true) {
    return false;
  }
  if (/(^|\/)(app|pages|routes|views|screens|components|features)(\/|$)/.test(rel)) return true;
  if (/(^|\/)(frontend|web|client-ui|ui)(\/|$)/.test(rel)) return true;
  return /\.(tsx|jsx|vue|svelte)$/.test(rel) && !BACKEND_PATH_RE.test(rel);
}

export function isUiCouplingSourceModule(mod: ModuleInfo): boolean {
  if (!isFrontendSurfaceModule(mod)) return false;
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  if (isBuildOrToolingModule(rel) || isPureTypesModule(mod)) return false;
  if (/(^|\/)features\/[^/]+\/(domain|domains|application|services?|api|data|repositories?|infrastructure|infra|stores?)(\/|$)/.test(rel)) return false;
  if (/(^|\/)(domain|domains|application|services?|api|server|backend|lambda|functions|repositories?|infrastructure|infra)(\/|$)/.test(rel)) return false;
  if (/(^|\/)(stores?|state)(\/|$)/.test(rel)) return false;
  if (SERVICE_SUFFIX_RE.test(rel)) return false;
  return /(^|\/)(app|pages|routes|views|screens|components|contexts?|providers?|hooks?|layouts?|platform)(\/|$)/.test(rel)
    || mod.exports.some(exp => exp.kind !== 'type' && exp.kind !== 'interface' && /^(use[A-Z]|[A-Z])/.test(exp.name))
    || /\.(tsx|jsx|vue|svelte)$/.test(rel)
    || mod.semanticHints?.ssr?.useClient === true;
}

export function isDesignSystemPrimitive(mod: ModuleInfo): boolean {
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)features\/[^/]+\//.test(rel)) return false;
  if (!/(^|\/)(components|ui|design-system|primitives)(\/|$)/.test(rel)) return false;
  // Count each export at most once: a name can match both the component predicate (starts uppercase)
  // and the hook/utility predicate (e.g. `PriceVariant`). Summing the two filters double-counted it and
  // could clear the 70% bar with fewer than 70% of exports actually qualifying.
  const qualifyingExports = mod.exports.filter(e =>
    e.kind === 'component'
    || /^[A-Z]/.test(e.name)
    || /^(use[A-Z]|cn$|cx$|cva$|.*Class(Name)?s?$|.*Variant(s)?)$/.test(e.name),
  ).length;
  return mod.exports.length > 0 && qualifyingExports >= Math.ceil(mod.exports.length * 0.7);
}

export function isRouteOrScreenEntryModule(mod: ModuleInfo): boolean {
  if (isBuildOrToolingModule(mod.relativeFilePath.replace(/\\/g, '/').toLowerCase())) return false;
  if (!isFrontendSurfaceModule(mod)) return false;
  if (mod.semanticHints?.hasRoutes || mod.semanticHints?.routes?.length) return true;
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(pages|routes|views|screens)(\/|$)/.test(rel)) return true;
  if (APP_ROUTE_FILE_RE.test(rel)) return true;
  return FEATURE_ENTRY_FILE_RE.test(rel);
}

export function isComponentLikeFlowEntryModule(mod: ModuleInfo): boolean {
  if (isBuildOrToolingModule(mod.relativeFilePath.replace(/\\/g, '/').toLowerCase())) return false;
  if (!isFrontendSurfaceModule(mod)) return false;
  if (isDesignSystemPrimitive(mod)) return false;
  return mod.exports.some(e => e.kind === 'component' || /^[A-Z]/.test(e.name));
}

export function isFrontendFlowEntryModule(mod: ModuleInfo, includeComponentEntrypoints: boolean): boolean {
  return isRouteOrScreenEntryModule(mod) || (includeComponentEntrypoints && isComponentLikeFlowEntryModule(mod));
}

export function isConvergenceTargetModule(mod: ModuleInfo, entryPackages: Set<string>): boolean {
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  if (isBuildOrToolingModule(rel) || isDesignSystemPrimitive(mod)) return false;
  const pkgId = `pkg:${mod.packageName}`;
  if (!entryPackages.has(pkgId)) return true;
  return /(^|\/)(shared|domain|domains|model|models|validation|validators|rules|policy|policies|schema|schemas|store|stores|services|utils|lib)(\/|$)/.test(rel)
    || /(rules?|policy|validator|validation|mapper|mapping|normaliz|transform|schema|model|store|service|repository|repo|adapter)/.test(rel);
}

export function convergenceTargetGroupKey(mod: ModuleInfo): string {
  const rel = stripSourceExtension(mod.relativeFilePath.replace(/\\/g, '/').toLowerCase());
  const sharedMatch = rel.match(/^(.*?\/)?(shared|lib)\/(store|stores|config|constants)\/(.+)$/);
  if (sharedMatch) {
    const tail = sharedMatch[4].split('/');
    const parent = tail.length > 1 ? tail[0] : '*';
    return `pkg:${mod.packageName}:${sharedMatch[2]}/${sharedMatch[3]}/${parent}/*`;
  }
  return mod.id;
}

export function isGenericConvergenceTarget(mod: ModuleInfo): boolean {
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  return /(^|\/)(shared|lib)\/(config|constants|store|stores)(\/|$)/.test(rel)
    || /(^|\/)(config|constants|store|stores)\/(index|types?|slices?)(\.[^.]+)?$/.test(rel)
    || GENERIC_CLIENT_FILE_RE.test(rel);
}

export function isStaticPageLikeModule(mod: ModuleInfo): boolean {
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  const file = rel.split('/').pop() ?? rel;
  return /(^|\/)(pages|routes|views|screens)\//.test(rel)
    && /(landing|legal|privacy|pricing|terms|how-to|shell|stub|last-updated|public)/.test(file);
}

export function isPureTypesModule(mod: ModuleInfo): boolean {
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  if (!/(^|\/)(types?|models?|interfaces?)(\.[^.]+)?$/.test(rel.split('/').pop() ?? rel)) return false;
  if (/(schema|validator|validation|rules?|policy|permission|authz|access)/.test(rel)) return false;
  return mod.exports.length > 0 && mod.exports.every(exp =>
    /^(type|interface|enum)$/i.test(exp.kind)
    || /(?:Type|Types|Props|Config|State|Data|Model|Dto|Payload|Response|Request)$/.test(exp.name),
  );
}

export function isBarrelLikeModule(mod: ModuleInfo): boolean {
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  const file = rel.split('/').pop() ?? rel;
  if (!BARREL_FILE_RE.test(file)) return false;
  return mod.exports.length === 0 || mod.exports.every(exp => exp.lineRange.end - exp.lineRange.start <= 1);
}

export type CoupledTargetRole = 'domain' | 'api' | 'storage' | 'server' | 'state' | 'feature';

export function coupledTargetRole(mod: ModuleInfo): CoupledTargetRole | undefined {
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(server|servers|backend|lambda|lambdas|functions)(\/|$)/.test(rel)) return 'server';
  if (/(^|\/)(api|apis|graphql|trpc|rpc|rest)(\/|$)/.test(rel) || /(?:api|graphql|trpc|rpc|rest)[-.](client|service)\./.test(rel)) return 'api';
  if (/(^|\/)(storage|db|database|repositories?|repository|persistence)(\/|$)/.test(rel) || STORAGE_SUFFIX_RE.test(rel)) return 'storage';
  if (/(^|\/)(domain|domains|model|models|rules?|polic(?:y|ies)|validators?|validation)(\/|$)/.test(rel)) return 'domain';
  if (/(^|\/)(stores?|state)(\/|$)/.test(rel) || STATE_SUFFIX_RE.test(rel)) return 'state';
  if (/(^|\/)features\/[^/]+/.test(rel)) return 'feature';
  return undefined;
}

export function uiCouplingTargetRole(mod: ModuleInfo): Exclude<CoupledTargetRole, 'feature'> | undefined {
  const role = coupledTargetRole(mod);
  return role === 'feature' ? undefined : role;
}

export function isFrontendServiceWrapperCandidate(mod: ModuleInfo): boolean {
  const hint = mod.semanticHints?.ui?.serviceWrapper;
  if (!hint?.candidate) return false;
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  if (isBuildOrToolingModule(rel) || isPureTypesModule(mod) || isBarrelLikeModule(mod)) return false;
  if (/(^|\/)(types?|interfaces?|models?)(\/|$)/.test(rel)) return false;
  const exportCount = mod.exports.filter(exp => exp.name !== 'default').length || mod.exports.length;
  if (exportCount > 6) return false;
  return true;
}

export function frontendDataAccessTargetKey(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const cleaned = target
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/\?.*$/, '')
    .replace(/\/:[^/]+/g, '/:param')
    .replace(/\/\$\{[^}]+\}/g, '/:param')
    .replace(/\/[0-9a-f-]{8,}(?=\/|$)/ig, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/+$/, '');
  if (!cleaned || cleaned === '/') return undefined;
  return cleaned;
}

// ── Key/path normalization ──

export function normalizeResponsibilityKey(labelOrPath: string): string {
  const basename = labelOrPath.replace(/\\/g, '/').split('/').pop();
  // The key reaches the agent inside a finding id and title. Stripping through the source-plugin
  // registry keeps `__init__.py` and `index.ts` reducing the same way, so a duplicate-responsibility
  // finding is never named after a file extension or after a package marker.
  const stripped = basename !== undefined ? stripSourceExtension(basename) : labelOrPath;
  const base = getSourceIndexBasenames().includes(stripped.toLowerCase()) ? '' : stripped;
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/\b(index|types?|schemas?|models?|utils?|helpers?)\b/g, '')
    .replace(/\b(service|manager|controller|handler|repository|repo|client|adapter|provider|api|view|page|component|hook)\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function maxModuleLine(mod: ModuleInfo | undefined): number {
  return mod?.exports.reduce((max, exp) => Math.max(max, exp.lineRange.end), 0) ?? 0;
}

export function rootDomainId(graph: RepositoryGraph, domainId: string): string {
  let current = domainId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const node = graph.nodes.get(current);
    if (node?.type === 'domain' && node.data?.parent) {
      const parentId = domainNodeId(domainLabelFromId(node.data.parent));
      if (graph.nodes.get(parentId)?.type === 'domain') {
        current = parentId;
        continue;
      }
    }
    const withoutPrefix = domainLabelFromId(current);
    const slashIdx = withoutPrefix.indexOf('/');
    if (slashIdx > 0) {
      const parentId = domainNodeId(withoutPrefix.slice(0, slashIdx));
      if (graph.nodes.get(parentId)?.type === 'domain') {
        current = parentId;
        continue;
      }
    }
    return current;
  }
  return current;
}

export function frontendFeatureKey(mod: ModuleInfo): string | undefined {
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  const featureMatch = rel.match(/(^|\/)features\/([^/]+)/);
  if (featureMatch) return `feature:${featureMatch[2]}`;
  const routeMatch = rel.match(/(^|\/)(pages|routes|views|screens)\/([^/.]+)/);
  if (routeMatch) return `${routeMatch[2]}:${routeMatch[3]}`;
  const appMatch = rel.match(/(^|\/)app\/([^/]+)/);
  if (appMatch) return `app:${appMatch[2]}`;
  const platformMatch = rel.match(/(^|\/)platform\/([^/]+)/);
  if (platformMatch) return `platform:${platformMatch[2]}`;
  if (/(^|\/)(shared|components|ui|lib)(\/|$)/.test(rel)) return undefined;
  return `pkg:${mod.packageName}`;
}

export function stateModuleKind(mod: ModuleInfo): string | undefined {
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  const exportNames = mod.exports.map(e => e.name).join(' ');
  if (/(^|\/)(contexts?|providers?)(\/|$)/.test(rel) || /Context|Provider/.test(exportNames)) return 'context';
  if (/(^|\/)(stores?|state)(\/|$)/.test(rel) || /store|Store|State/.test(exportNames)) return 'store';
  if (/(^|\/)hooks?\//.test(rel) || mod.exports.some(e => /^use[A-Z]/.test(e.name))) return 'hook';
  if (/(reducer|atom|signal|machine|slice)\b/.test(rel) || /(Reducer|Atom|Signal|Machine|Slice)/.test(exportNames)) return 'state-helper';
  return undefined;
}

export function exportedNamesText(mod: ModuleInfo): string {
  return mod.exports.map(e => e.name).join(' ');
}

// ── Annotation/policy lexical signals ──

export function annotationText(ann: StoredAnnotation | undefined): string {
  if (!ann) return '';
  const sem = ann.annotation;
  return [
    sem.summary,
    ...Object.keys(sem.keyExports ?? {}),
    ...Object.values(sem.keyExports ?? {}),
    ...(sem.assumptions ?? []),
    ...(sem.sideEffects?.map(serializeSideEffect) ?? []),
    ...riskEntryTexts(sem.risks),
    ...(sem.patterns ?? []),
    sem.flowDescription,
    ...(sem.invariants ?? []),
    ...(sem.extensionPoints ?? []),
    typeof sem.integrationPoints === 'string' ? sem.integrationPoints : Object.values(sem.integrationPoints ?? {}).join(' '),
    typeof sem.stateShape === 'string' ? sem.stateShape : Object.values(sem.stateShape ?? {}).join(' '),
    typeof sem.dataFlow === 'string' ? sem.dataFlow : Object.values(sem.dataFlow ?? {}).join(' '),
    ...Object.keys(sem.envDependencies ?? {}),
    ...Object.values(sem.envDependencies ?? {}),
  ].filter(Boolean).join(' ');
}

export function policySubjectKey(mod: ModuleInfo): string {
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  const exportText = exportedNamesText(mod);
  const feature = frontendFeatureKey(mod)?.replace(/^[^:]+:/, '') ?? '';
  const featureWords = feature
    ? [feature, feature.replace(/s$/, '')].filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    : [];
  const featurePattern = featureWords.length > 0 ? new RegExp(`\\b(${featureWords.join('|')})\\b`, 'ig') : undefined;
  const text = `${rel} ${exportText}`
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(featurePattern ?? /$^/, ' ')
    .replace(/\b(validate|validator|validation|can|may|should|has|is|allowed|authorize|authz|access|permission|policy|rules?|map|mapper|mapping|transform|normalize|serialize|deserialize|format|schema|model|type|types|config|props|state|data|dto|payload|response|request|build|create|get|set|use)\b/g, ' ');
  const parts = text
    .split(/[^a-z0-9]+/)
    .filter(part => part.length >= 4 && !/^(src|features|pages|routes|views|screens|components|hooks|utils|helpers|services|domain|shared|client|public|index|default)$/.test(part));
  return parts.slice(0, 2).join('-') || 'general';
}

export function policyTokens(mod: ModuleInfo, ann?: StoredAnnotation): string[] {
  const rel = mod.relativeFilePath.replace(/\\/g, '/').toLowerCase();
  if (isStaticPageLikeModule(mod) || isPureTypesModule(mod)) return [];
  const exportText = exportedNamesText(mod);
  const lowerExportText = exportText.toLowerCase();
  const annTextLower = annotationText(ann).toLowerCase();
  const tokens = new Set<string>();
  const combined = `${rel} ${lowerExportText} ${annTextLower}`;
  const pathHas = (pattern: RegExp): boolean => pattern.test(rel);
  const exportHas = (pattern: RegExp): boolean => pattern.test(exportText);
  const annotationHas = (pattern: RegExp): boolean => pattern.test(annTextLower);

  if (pathHas(/(^|\/)(validation|validators?)(\/|\.|$)/) || exportHas(/\b(validate[A-Z0-9_]|parse[A-Z0-9_]|assert[A-Z0-9_]|refine[A-Z0-9_]|.*Validator$)/)) {
    tokens.add('validation');
  }
  if (
    pathHas(/(^|\/)(permissions?|roles?|authz|access|policies|policy|rules)(\/|\.|$)/)
    || exportHas(/\b(can[A-Z0-9_]|may[A-Z0-9_]|is[A-Z0-9_]*Allowed|authorize[A-Z0-9_]|has[A-Z0-9_]*Access|.*Permission(s)?$|.*Role(s)?$)/)
    || annotationHas(/\b(permission|authorization|access policy|role based|eligibility rule)\b/)
  ) {
    tokens.add('permissions');
  }
  if (
    pathHas(/(^|\/)(rules?|policies|policy|eligibility|decisions?)(\/|\.|$)/)
    || exportHas(/\b(should[A-Z0-9_]|check[A-Z0-9_]|verify[A-Z0-9_]|is[A-Z0-9_]*Eligible|.*Rule(s)?$|.*Policy$)/)
    || annotationHas(/\b(domain invariant|business rule|eligibility|policy decision)\b/)
  ) {
    tokens.add('policy-rules');
  }
  if (pathHas(/(^|\/)(mappers?|mapping|transforms?|normalizers?|serializers?|formatters?)(\/|\.|$)/) || exportHas(/\b(map[A-Z0-9_]|normalize[A-Z0-9_]|transform[A-Z0-9_]|serialize[A-Z0-9_]|deserialize[A-Z0-9_]|format[A-Z0-9_])/)) {
    tokens.add('mapping-transform');
  }
  if (
    pathHas(/(^|\/)(schemas?|parsers?|guards?)(\/|\.|$)/)
    || exportHas(/\b([A-Z0-9_].*Schema|.*Parser|.*Guard|parse[A-Z0-9_]|assert[A-Z0-9_]|is[A-Z0-9_].*)/)
    || annotationHas(/\b(zod schema|runtime schema|parser|type guard)\b/)
  ) {
    tokens.add('schema-model');
  }
  if (tokens.size === 0 && /(validat|validator|permission|authorize|authz|access policy|business rule|eligib|mapping|normaliz|schema|type guard)/.test(combined)) {
    tokens.add('policy-rules');
  }
  return [...tokens];
}

// ── Flow path traversal ──

export function flowPrepKeys(modulesById: Map<string, ModuleInfo>, pathIds: string[], targetId: string): string[] {
  const keys = new Set<string>();
  for (const id of pathIds.slice(1, -1)) {
    if (id === targetId) continue;
    const mod = modulesById.get(id);
    if (!mod) continue;
    const key = normalizeResponsibilityKey(mod.relativeFilePath);
    if (!key || key.length < 3) continue;
    if (/(map|mapper|mapping|valid|rules?|policy|normaliz|transform|schema|model|store|service|adapter|config|prepare|format)/.test(key)) {
      keys.add(key);
    }
  }
  return [...keys];
}

export function findFlowPaths(
  graph: RepositoryGraph,
  modulesById: Map<string, ModuleInfo>,
  startId: string,
  scopedModuleIds: Set<string>,
  maxDepth = 5,
): Array<{ targetId: string; path: string[] }> {
  const out: Array<{ targetId: string; path: string[] }> = [];
  const queue: Array<{ id: string; path: string[] }> = [{ id: startId, path: [startId] }];
  const seenAtDepth = new Map<string, number>([[startId, 0]]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = current.path.length - 1;
    if (depth >= maxDepth) continue;
    for (const edge of graph.outEdges.get(current.id) ?? []) {
      if (!isRuntimeImportEdge(edge)) continue;
      if (!scopedModuleIds.has(edge.to)) continue;
      const targetMod = modulesById.get(edge.to);
      if (!targetMod) continue;
      if (isBuildOrToolingModule(targetMod.relativeFilePath.replace(/\\/g, '/').toLowerCase()) || isDesignSystemPrimitive(targetMod)) continue;
      const nextPath = [...current.path, edge.to];
      out.push({ targetId: edge.to, path: nextPath });
      const previousDepth = seenAtDepth.get(edge.to);
      if (previousDepth != null && previousDepth <= depth + 1) continue;
      seenAtDepth.set(edge.to, depth + 1);
      queue.push({ id: edge.to, path: nextPath });
    }
  }
  return out;
}
