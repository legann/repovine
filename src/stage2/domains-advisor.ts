import * as fs from 'node:fs';
import { compareCodeUnits } from '../platform/ordering.js';
import type { InfraResource, RepositoryGraph, RepositoryFactsSnapshot } from '../types.js';
import { isWitnessedNode } from '../graph/index.js';
import { domainsConfigFilePath } from '../paths.js';
import { makeRuntimeResourceId } from '../graph/make-runtime-resource-id.js';
import { matchesInfraResourceExclude } from './domains.js';
import { DomainsConfigSchema, type DomainsConfigFile } from './domains-schema.js';
import { domainSlug } from './domain-slug.js';
// Side-effect import: the built-in source plugins must be registered before this module asks the
import { hasKnownSourceExtension, stripSourceExtension } from '../plugin-host/source-set.js';
import { lastPathSegment } from '../platform/paths.js';

const INFRA_NOISE_SUFFIXES = [
  'Alarm',
  'LogGroup',
  'MetricFilter',
  'Dashboard',
  'Permission',
  'Policy',
  'RolePolicy',
  'Role',
] as const;

const INFRA_NOISE_SUFFIXES_LONGEST_FIRST = [...INFRA_NOISE_SUFFIXES]
  .sort((a, b) => b.length - a.length || compareCodeUnits(a, b));

export type DomainsSuggestionAxis =
  | 'infra.excludeSuffixes'
  | 'infra.excludePatterns'
  | 'basename.pascalCase'
  | 'domains';

export type DomainsSuggestionAddition =
  | {
      id: string;
      axis: 'infra.excludeSuffixes';
      value: string;
      count: number;
      labels: string[];
      reason: string;
    }
  | {
      id: string;
      /** Anchored-pattern variant: emitted when a suffix is *mixed* — some resources under it
       * carry load-bearing edges. A blanket suffix would hide the witnessed ones too, so the
       * advisor proposes an exact-match pattern (`^(A|B)$`) over the inert labels only. */
      axis: 'infra.excludePatterns';
      value: string;
      count: number;
      /** Inert labels covered by the pattern. */
      labels: string[];
      /** Witnessed labels deliberately left out of the pattern (kept visible). */
      spared: string[];
      reason: string;
    }
  | {
      id: string;
      axis: 'basename.pascalCase';
      value: 'reject';
      count: number;
      ratio: number;
      reason: string;
    }
  | {
      id: string;
      axis: 'domains';
      domain: string;
      paths: string[];
      count: number;
      reason: string;
    };

export interface DomainsSuggestion {
  additions: DomainsSuggestionAddition[];
  count: number;
  axes: DomainsSuggestionAxis[];
  declinedHidden: number;
  /** onDisk + every visible addition applied as an exclude (the "accept everything" preview). */
  mergedConfig: DomainsConfigFile;
  /** onDisk + the infra-noise additions applied as committed `infra.keep` markers (the symmetric
   * "keep everything" preview). Non-infra additions are no-ops here. */
  keepConfig: DomainsConfigFile;
}

export interface DomainsAdvisorDeclinedState {
  declined: string[];
}

export function readDomainsConfigFile(repoRoot: string): DomainsConfigFile {
  const filePath = domainsConfigFilePath(repoRoot);
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = DomainsConfigSchema.safeParse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function formatDomainsConfigFile(config: DomainsConfigFile): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function collectSuffixHistogram(snapshot: RepositoryFactsSnapshot): Record<string, number> {
  const labelsBySuffix = collectSuffixLabels(snapshot);
  return Object.fromEntries(Object.entries(labelsBySuffix).map(([suffix, labels]) => [suffix, labels.length]));
}

export function collectSuffixLabels(snapshot: RepositoryFactsSnapshot): Record<string, string[]> {
  const labelsBySuffix: Record<string, string[]> = {};
  for (const infraMod of snapshot.infraModules ?? []) {
    for (const resource of infraMod.resources) {
      for (const suffix of INFRA_NOISE_SUFFIXES_LONGEST_FIRST) {
        if (!resource.id.endsWith(suffix)) continue;
        (labelsBySuffix[suffix] ??= []).push(resource.id);
        break;
      }
    }
  }
  // Dedup: a logical resource id can appear in more than one infra module (e.g. a resource declared
  // in both a nested and a parent stack), and we suggest/anchor by label, so each label counts once.
  return Object.fromEntries(
    Object.entries(labelsBySuffix).map(([suffix, labels]) => [suffix, [...new Set(labels)].sort((a, b) => compareCodeUnits(a, b))]),
  );
}

export function computeDomainsSuggestion(
  snapshot: RepositoryFactsSnapshot,
  graph: RepositoryGraph,
  onDisk: DomainsConfigFile = readDomainsConfigFile(snapshot.repoRoot),
  declined: DomainsAdvisorDeclinedState = { declined: [] },
): DomainsSuggestion {
  const declinedIds = new Set(declined.declined);
  const additions: DomainsSuggestionAddition[] = [];

  for (const addition of computeInfraSuffixSuggestions(snapshot, onDisk, graph)) {
    additions.push(addition);
  }
  const basenameAddition = computeBasenameSuggestion(snapshot, onDisk);
  if (basenameAddition) additions.push(basenameAddition);
  for (const addition of computeInfraDomainPathSuggestions(snapshot, onDisk)) {
    additions.push(addition);
  }

  const visible = additions.filter(addition => !declinedIds.has(addition.id));
  const axes = [...new Set(visible.map(addition => addition.axis))];
  return {
    additions: visible,
    count: visible.length,
    axes,
    declinedHidden: additions.length - visible.length,
    mergedConfig: applyDomainsSuggestion(onDisk, visible),
    keepConfig: applyDomainsKeep(onDisk, visible),
  };
}

export function applyDomainsSuggestion(
  onDisk: DomainsConfigFile = {},
  accepted: DomainsSuggestionAddition[],
): DomainsConfigFile {
  const next: DomainsConfigFile = structuredClone(onDisk);
  for (const addition of accepted) {
    if (addition.axis === 'infra.excludeSuffixes') {
      next.infra ??= {};
      next.infra.excludeSuffixes = unionStrings(next.infra.excludeSuffixes, [addition.value]);
      continue;
    }
    if (addition.axis === 'infra.excludePatterns') {
      next.infra ??= {};
      next.infra.excludePatterns = unionStrings(next.infra.excludePatterns, [addition.value]);
      continue;
    }
    if (addition.axis === 'basename.pascalCase') {
      next.basename ??= {};
      if (next.basename.pascalCase === undefined) next.basename.pascalCase = addition.value;
      continue;
    }
    if (addition.axis === 'domains') {
      next.domains ??= {};
      if (next.domains[addition.domain] !== undefined) continue;
      next.domains[addition.domain] = { paths: addition.paths };
    }
  }
  return next;
}

/**
 * Symmetric counterpart of {@link applyDomainsSuggestion}: instead of excluding a suggestion, write
 * a committed `infra.keep` marker so the resource stays materialized AND the advisor stops proposing
 * it. Suffix suggestions map to `keep.suffixes`, pattern suggestions to `keep.patterns`; non-infra
 * axes have no keep semantics and are ignored.
 */
export function applyDomainsKeep(
  onDisk: DomainsConfigFile = {},
  kept: DomainsSuggestionAddition[],
): DomainsConfigFile {
  const next: DomainsConfigFile = structuredClone(onDisk);
  for (const addition of kept) {
    if (addition.axis === 'infra.excludeSuffixes') {
      next.infra ??= {};
      next.infra.keep ??= {};
      next.infra.keep.suffixes = unionStrings(next.infra.keep.suffixes, [addition.value]);
      continue;
    }
    if (addition.axis === 'infra.excludePatterns') {
      next.infra ??= {};
      next.infra.keep ??= {};
      next.infra.keep.patterns = unionStrings(next.infra.keep.patterns, [addition.value]);
      continue;
    }
  }
  return next;
}

/**
 * True when the graph materialized this resource and some load-bearing edge touches it. A resource
 * absent from the graph, or carrying only `contains`/`tagged`, is inert.
 */
function isResourceWitnessed(graph: RepositoryGraph, res: InfraResource): boolean {
  return isWitnessedNode(graph, makeRuntimeResourceId(res));
}

/** Lookup from resource id (the suffix-label) back to the InfraResource, to recover provider/kind. */
function collectResourcesById(snapshot: RepositoryFactsSnapshot): Map<string, InfraResource> {
  const byId = new Map<string, InfraResource>();
  for (const infraMod of snapshot.infraModules ?? []) {
    for (const res of infraMod.resources) {
      if (!byId.has(res.id)) byId.set(res.id, res);
    }
  }
  return byId;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Witness-aware infra-noise advisor: only ever proposes hiding resources that no load-bearing
 * edge witnesses. A suffix that is entirely inert plumbing gets a blanket `excludeSuffixes`; a
 * *mixed* suffix (some resources are witnessed, e.g. managed `Policy` carrying `uses_env`) never
 * gets a blanket suffix — instead an anchored `excludePatterns` over the inert labels only, so the
 * witnessed ones stay in the graph. Threshold: at least 2 inert labels worth hiding.
 */
function computeInfraSuffixSuggestions(
  snapshot: RepositoryFactsSnapshot,
  onDisk: DomainsConfigFile,
  graph: RepositoryGraph,
): DomainsSuggestionAddition[] {
  // When the builder-level witness gate is on, inert resources are pruned at build time — proposing
  // to exclude them would be redundant noise, so the advisor stays quiet about infra noise entirely.
  if (onDisk.infra?.pruneInert) return [];

  const existingSuffixes = new Set(onDisk.infra?.excludeSuffixes ?? []);
  const existingPatterns = new Set(onDisk.infra?.excludePatterns ?? []);
  const keepSuffixes = onDisk.infra?.keep?.suffixes;
  const keepPatterns = onDisk.infra?.keep?.patterns;
  const hasKeep = (keepSuffixes && keepSuffixes.length > 0) || (keepPatterns && keepPatterns.length > 0);
  const isKept = (label: string): boolean =>
    hasKeep ? matchesInfraResourceExclude(label, keepSuffixes, keepPatterns) : false;
  const labelsBySuffix = collectSuffixLabels(snapshot);
  const resourcesById = collectResourcesById(snapshot);

  const additions: DomainsSuggestionAddition[] = [];
  for (const [suffix, labels] of Object.entries(labelsBySuffix)) {
    if (existingSuffixes.has(suffix)) continue;

    const inert: string[] = [];
    const witnessed: string[] = [];
    let keptCount = 0;
    for (const label of labels) {
      const res = resourcesById.get(label);
      if (res && isResourceWitnessed(graph, res)) { witnessed.push(label); continue; }
      // Committed keep: the label stays materialized and is never suggested. Its presence also
      // forbids a blanket suffix (which would drop it), forcing the narrower pattern branch.
      if (isKept(label)) { keptCount += 1; continue; }
      inert.push(label);
    }
    if (inert.length < 2) continue;

    if (witnessed.length === 0 && keptCount === 0) {
      // Whole suffix is inert plumbing — a blanket suffix exclude is safe.
      additions.push({
        id: `infra.excludeSuffixes:${suffix}`,
        axis: 'infra.excludeSuffixes',
        value: suffix,
        count: inert.length,
        labels: inert,
        reason: `${inert.length} infra resource label(s) end with ${suffix} and carry no load-bearing edges: ${inert.join(', ')}`,
      });
      continue;
    }

    // Mixed suffix: spare the witnessed resources, propose a pattern over inert labels only.
    const pattern = `^(${inert.map(escapeRegex).join('|')})$`;
    if (existingPatterns.has(pattern)) continue;
    additions.push({
      id: `infra.excludePatterns:${pattern}`,
      axis: 'infra.excludePatterns',
      value: pattern,
      count: inert.length,
      labels: inert,
      spared: witnessed,
      reason: `${inert.length} inert ${suffix} label(s) with no load-bearing edges: ${inert.join(', ')}; spared ${witnessed.length} witnessed: ${witnessed.join(', ')}`,
    });
  }

  return additions.sort((a, b) => b.count - a.count || compareCodeUnits(a.id, b.id));
}

function computeBasenameSuggestion(
  snapshot: RepositoryFactsSnapshot,
  onDisk: DomainsConfigFile,
): DomainsSuggestionAddition | undefined {
  if (onDisk.basename?.pascalCase !== undefined) return undefined;
  const codeModules = snapshot.modules.filter(mod => hasKnownSourceExtension(mod.pkgRelPath));
  if (codeModules.length === 0) return undefined;
  const pascalCase = codeModules.filter(mod => {
    const basename = stripSourceExtension(lastPathSegment(mod.pkgRelPath));
    return /^[A-Z]/.test(basename);
  }).length;
  const ratio = pascalCase / codeModules.length;
  if (pascalCase < 12 || ratio < 0.25) return undefined;
  return {
    id: 'basename.pascalCase:reject',
    axis: 'basename.pascalCase',
    value: 'reject',
    count: pascalCase,
    ratio: Number(ratio.toFixed(3)),
    reason: `${pascalCase} PascalCase module basename(s) look like component/class files`,
  };
}

function computeInfraDomainPathSuggestions(
  snapshot: RepositoryFactsSnapshot,
  onDisk: DomainsConfigFile,
): DomainsSuggestionAddition[] {
  const existingDomains = new Set(Object.keys(onDisk.domains ?? {}));
  const existingPaths = new Set(Object.values(onDisk.domains ?? {}).flatMap(entry => entry.paths ?? []));
  const counts = new Map<string, number>();
  for (const infraMod of snapshot.infraModules ?? []) {
    const parts = infraMod.repoRelPath.split('/').filter(Boolean);
    if (parts[0] !== 'infrastructure' || !parts[1]) continue;
    const folder = domainSlug(parts[1]);
    if (!folder) continue;
    counts.set(`infra-${folder}`, (counts.get(`infra-${folder}`) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([domain, count]) => {
      const folder = domain.replace(/^infra-/, '');
      return count >= 2 && !existingDomains.has(domain) && !existingPaths.has(`^infrastructure/${folder}`);
    })
    .sort((a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]))
    .map(([domain, count]) => {
      const folder = domain.replace(/^infra-/, '');
      return {
        id: `domains:${domain}:^infrastructure/${folder}`,
        axis: 'domains' as const,
        domain,
        paths: [`^infrastructure/${folder}`],
        count,
        reason: `${count} infra module(s) live under infrastructure/${folder}`,
      };
    });
}

function unionStrings(existing: string[] | undefined, additions: string[]): string[] {
  return [...new Set([...(existing ?? []), ...additions])];
}
