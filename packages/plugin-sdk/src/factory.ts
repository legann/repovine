/**
 * Plugin-SDK authoring factories.
 *
 * These are the ONLY supported way to author a plugin — built-ins go through them exactly as a
 * third-party plugin would (the dogfood litmus). They stamp the contract `apiVersion` and,
 * for IaC, bundle parsers + registry metadata into one declarative descriptor so a plugin never
 * imports the engine registry directly.
 */

import type { SourcePlugin } from './source-plugin/types.js';
import type { IaCParser, InfraKindDomain, ResourceKindMeta, TriggerTypeMeta } from './types.js';
import type { DocumentLoader } from './plugin/document-loader.js';
import { PLUGIN_API_VERSION } from './runtime.js';
import type { PluginRequirements, PluginAvailability } from './runtime.js';

/**
 * Author a source plugin. Runtime identity except it stamps the contract `apiVersion` when the spec
 * does not set one. The single authoring entry point for source/ecosystem plugins.
 */
export function defineSourcePlugin(spec: SourcePlugin): SourcePlugin {
  return { apiVersion: PLUGIN_API_VERSION, ...spec };
}

/**
 * Typed authoring anchor for a single IaC parser. Runtime identity; exists so a parser object is
 * written against the public `IaCParser` contract (and shows intent) rather than an ad-hoc literal.
 */
export function defineIaCParser(parser: IaCParser): IaCParser {
  return parser;
}

/**
 * Declarative descriptor for an IaC plugin: one or more parsers plus the kind/resource/trigger
 * metadata those parsers rely on. The engine registers the descriptor as a unit (bootstrap today,
 * the loader later), so a plugin author never calls `registerParser`/`registerInfraKindDomain`
 * directly. This keeps the IaC authoring surface symmetric with source plugins (one declarative
 * object) and the SDK boundary clean.
 */
export interface IaCPluginDescriptor {
  /** Stable plugin id, e.g. 'sam', 'helm'. Used for diagnostics and (later) disable/dedup. */
  id: string;
  /** Contract major; stamped by `defineIaCPlugin`. The loader refuses a mismatched major. */
  apiVersion?: number;
  requires?: PluginRequirements;
  available?(): PluginAvailability | Promise<PluginAvailability>;
  /** Parsers this plugin contributes. Every parser that supports a document is offered it, so the
   *  array is an inventory rather than a precedence list. */
  parsers: IaCParser[];
  /** Document loaders this plugin brings, beyond the `yaml`/`json`/`text` the host provides. Two
   *  plugins registering one loader id is a conflict, not an overwrite. */
  loaders?: DocumentLoader[];
  /** InfraKind → graph-domain registrations this plugin owns. */
  kindDomains?: Array<{ kind: string; meta: InfraKindDomain }>;
  /** InfraResourceKind → metadata (e.g. lambda hasCodeHandler) this plugin contributes. */
  resourceKindMeta?: Array<{ kind: string; meta: ResourceKindMeta }>;
  /** InfraTriggerType → metadata (entrypoint kind, stream-like) this plugin contributes. */
  triggerTypeMeta?: Array<{ type: string; meta: TriggerTypeMeta }>;
}

/**
 * Author an IaC plugin (parsers + metadata) as one declarative unit. Stamps the contract
 * `apiVersion`. The returned descriptor is handed to the engine for registration.
 */
export function defineIaCPlugin(descriptor: IaCPluginDescriptor): IaCPluginDescriptor {
  return { apiVersion: PLUGIN_API_VERSION, ...descriptor };
}
