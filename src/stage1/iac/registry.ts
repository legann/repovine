import type { IaCDocFormat, IaCParser } from '../../types.js';
import type { IaCPluginDescriptor } from '@repovine/plugin-sdk';

/**
 * Mutable registry of IaC parsers. Built-in parsers register themselves at module load
 * (see ./index.ts). External callers can register additional parsers via registerParser().
 *
 * Parser order matters: collectInfraModules picks the first parser whose supports() returns
 * true for a given (filePath, doc) pair, so more specific parsers should register before
 * broader ones.
 */
const parsers: IaCParser[] = [];

export function registerParser(parser: IaCParser): void {
  parsers.push(parser);
}

export function getParsers(): readonly IaCParser[] {
  return parsers;
}

/** Parsers registered by each IaC plugin id, so the loader can remove a plugin's parsers on
 *  `plugins.disable` / `plugins.defaults:false`. Kind/resource/trigger metadata is left registered:
 *  it is additive and inert when no parser emits the matching kind, and an external plugin may rely
 *  on a built-in's resource meta (e.g. lambda `hasCodeHandler`) even when that built-in is disabled. */
const parsersByPluginId = new Map<string, IaCParser[]>();

/**
 * Register a declarative IaC plugin descriptor (from `defineIaCPlugin`) as a unit: its parsers in
 * array order, then its kind/resource/trigger metadata. This is the engine-side counterpart to the
 * authoring factory — built-in bootstrap and the external loader both go through here, so a plugin
 * author never calls the individual `register*` functions directly (keeps the SDK boundary clean).
 */
export function registerIaCPlugin(descriptor: IaCPluginDescriptor): void {
  const owned = parsersByPluginId.get(descriptor.id) ?? [];
  for (const parser of descriptor.parsers) {
    registerParser(parser);
    owned.push(parser);
  }
  parsersByPluginId.set(descriptor.id, owned);
  for (const { kind, meta } of descriptor.kindDomains ?? []) registerInfraKindDomain(kind, meta);
  for (const { kind, meta } of descriptor.resourceKindMeta ?? []) registerResourceKindMeta(kind, meta);
  for (const { type, meta } of descriptor.triggerTypeMeta ?? []) registerTriggerTypeMeta(type, meta);
}

/** Remove all parsers registered by an IaC plugin id (loader: disable / defaults:false). Returns
 *  true when the plugin had registered parsers. Metadata is intentionally not removed (see above). */
export function unregisterIaCPlugin(id: string): boolean {
  const owned = parsersByPluginId.get(id);
  if (!owned || owned.length === 0) return false;
  for (const parser of owned) {
    const idx = parsers.indexOf(parser);
    if (idx !== -1) parsers.splice(idx, 1);
  }
  parsersByPluginId.delete(id);
  return true;
}

/** Ids of IaC plugins that currently have registered parsers, in first-registration order. */
export function getRegisteredIaCPluginIds(): string[] {
  return [...parsersByPluginId.keys()];
}

/** Clear all registered parsers and per-plugin tracking (kind/resource/trigger metadata is left in
 *  place — it is additive/inert). The loader uses this via the IaC bootstrap to rebuild a clean
 *  built-in baseline before applying `plugins.{defaults,add,disable}` on each build. */
export function resetIaCParsers(): void {
  parsers.splice(0, parsers.length);
  parsersByPluginId.clear();
}

/** Test-only: replace all registered parsers. Returns a restore callback. */
export function setParsersForTest(next: IaCParser[]): () => void {
  const prev = parsers.splice(0, parsers.length, ...next);
  return () => {
    parsers.splice(0, parsers.length, ...prev);
  };
}

/** Return true when (base, ext) is matched by parser.fileMatch, or parser has no fileMatch. */
export function parserMatchesFile(parser: IaCParser, base: string, ext: string): boolean {
  const fm = parser.fileMatch;
  if (!fm) return true;
  if (fm.fileNames?.includes(base)) return true;
  if (fm.extensions?.includes(ext)) return true;
  if (fm.fileNamePatterns?.some(re => re.test(base))) return true;
  return false;
}

/** True when at least one registered parser claims this file via its fileMatch. */
export function isInfraCandidate(base: string, ext: string): boolean {
  for (const p of parsers) {
    if (parserMatchesFile(p, base, ext)) return true;
  }
  return false;
}

/**
 * Pick the loader format for a file based on the first parser whose fileMatch claims it.
 * Returns undefined if no parser with a docFormat claims the file — callers fall back to the
 * legacy extension-based guess.
 */
export function pickDocFormatForFile(base: string, ext: string): IaCDocFormat | undefined {
  for (const p of parsers) {
    if (!p.docFormat) continue;
    if (parserMatchesFile(p, base, ext)) return p.docFormat;
  }
  return undefined;
}

/* ---------------------- InfraKind → graph domain registry ---------------------- */

export interface InfraKindDomain {
  domainId: string;
  label: string;
  description: string;
}

const kindDomains = new Map<string, InfraKindDomain>();

export function registerInfraKindDomain(kind: string, meta: InfraKindDomain): void {
  kindDomains.set(kind, meta);
}

/**
 * Resolve a kind to a graph domain. Unknown kinds are mapped to a conventional
 * `domain:infra-<kind>` so new plugins always land in their own bucket instead of silently
 * falling through to a hardcoded default (which used to send everything to infra-sam).
 */
export function getInfraKindDomain(kind: string): InfraKindDomain {
  const explicit = kindDomains.get(kind);
  if (explicit) return explicit;
  const domainId = `domain:infra-${kind}`;
  return {
    domainId,
    label: `infra-${kind}`,
    description: `Domain: infra-${kind} (IaC ${kind})`,
  };
}

/** All explicitly registered (kind, domain) pairs — used to seed graph domain nodes. */
export function getAllRegisteredKindDomains(): Array<{ kind: string; meta: InfraKindDomain }> {
  return [...kindDomains.entries()].map(([kind, meta]) => ({ kind, meta }));
}

/* ---------------------- InfraResourceKind metadata ---------------------- */

export interface ResourceKindMeta {
  /** stage2 attempts to resolve the resource's `handler` attribute to a code module. */
  hasCodeHandler?: boolean;
}

const resourceKindMeta = new Map<string, ResourceKindMeta>();

export function registerResourceKindMeta(kind: string, meta: ResourceKindMeta): void {
  resourceKindMeta.set(kind, meta);
}

export function getResourceKindMeta(kind: string): ResourceKindMeta | undefined {
  return resourceKindMeta.get(kind);
}

/* ---------------------- InfraTrigger type metadata ---------------------- */

export type TriggerEntryKind =
  | 'api'
  | 'websocket'
  | 'queue-consumer'
  | 'schedule'
  | 'webhook'
  | 'unknown';

export interface TriggerTypeMeta {
  /**
   * Stage2 emits a `consumes` edge from `trigger.queueRef` to the target lambda when this is
   * true (SQS, DynamoDB stream, Kinesis stream are the built-ins).
   */
  isStreamLike?: boolean;
  /** Default entrypoint label used by mcp/handlers.triggerEntryKind. */
  entrypointKind?: TriggerEntryKind;
}

const triggerTypeMeta = new Map<string, TriggerTypeMeta>();

export function registerTriggerTypeMeta(type: string, meta: TriggerTypeMeta): void {
  triggerTypeMeta.set(type, meta);
}

export function getTriggerTypeMeta(type: string): TriggerTypeMeta | undefined {
  return triggerTypeMeta.get(type);
}
