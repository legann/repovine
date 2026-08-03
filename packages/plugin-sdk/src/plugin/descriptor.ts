import type { PluginRequirements, PluginAvailability } from '../runtime.js';
import type { SourcePlugin } from '../source-plugin/types.js';
import type { IaCParser, InfraKindDomain } from '../types.js';
import type { DocumentLoader } from './document-loader.js';
import type { ProjectionContributor } from './projection.js';
import { pluginContractIdProblem } from './ids.js';

/**
 * The executable half of a plugin package: the default export of its entry module.
 *
 * Declarations are read from the manifest without running code; capabilities are code and run only
 * while the plugin is enabled and its prerequisites are present. `requires` and `available` are one
 * lifecycle for every capability, so a missing Python or Go toolchain produces one actionable
 * message instead of a failure per file.
 *
 * A bundled first-party plugin and an independently installed one use this same descriptor, the
 * same loader and the same validation. Being shipped in the box is packaging, not privilege.
 */
export interface PluginRuntimeDescriptor {
  /** Must equal the manifest `id`; the host refuses the package when the two disagree. */
  id: string;
  requires?: PluginRequirements;
  available?(): PluginAvailability | Promise<PluginAvailability>;
  capabilities: PluginCapabilities;
}

export interface PluginCapabilities {
  source?: SourceRuntimeCapability;
  iac?: IaCRuntimeCapability;
  loaders?: readonly DocumentLoader[];
  projectors?: readonly ProjectionContributor[];
}

/**
 * The full discovery/extraction bundle for one language or ecosystem: `discover`, `extract`, file
 * and package matching, and the declarative language metadata behind them.
 *
 * Identity and lifecycle are lifted to the descriptor, so the capability carries handlers rather
 * than repeating who the plugin is. The nested `capabilities` field inside it is the source
 * plugin's own declarative language metadata, distinct from this descriptor's capability set.
 */
export type SourceRuntimeCapability = Omit<
  SourcePlugin,
  'id' | 'apiVersion' | 'requires' | 'available'
>;

export interface IaCRuntimeCapability {
  parsers: readonly IaCParser[];
  /**
   * Graph domain each infra kind these parsers emit belongs to.
   *
   * Metadata about what the parsers beside it produce, so it sits with them rather than in the
   * manifest: a kind with no parser to emit it names a domain nothing reaches. A kind with no entry
   * here gets the host's derived `domain:infra-<kind>`.
   */
  kindDomains?: ReadonlyArray<{ kind: string; meta: InfraKindDomain }>;
}

/**
 * Author a plugin. A typed anchor: the manifest carries `apiVersion`, so there is nothing to stamp
 * here and the descriptor a plugin exports is exactly the object it wrote.
 */
export function definePlugin(descriptor: PluginRuntimeDescriptor): PluginRuntimeDescriptor {
  return descriptor;
}

export type DescriptorValidation =
  | { ok: true; descriptor: PluginRuntimeDescriptor; declared: readonly PluginCapabilityName[] }
  | { ok: false; error: string };

export const PLUGIN_CAPABILITY_NAMES = ['source', 'iac', 'loaders', 'projectors'] as const;
export type PluginCapabilityName = typeof PLUGIN_CAPABILITY_NAMES[number];

function isFunction(value: unknown): boolean {
  return typeof value === 'function';
}

/**
 * Structurally validate a descriptor imported from an untrusted package.
 *
 * Capabilities are functions, so this checks the shape a caller will actually invoke rather than
 * parsing a JSON schema over it. Behaviour is checked by the conformance kit and by the output
 * validators at the fact and projection boundaries.
 */
export function validatePluginRuntimeDescriptor(value: unknown): DescriptorValidation {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'default export is not a plugin descriptor object' };
  }
  const descriptor = value as Partial<PluginRuntimeDescriptor>;

  const idProblem = pluginContractIdProblem(descriptor.id, 'descriptor id');
  if (idProblem) return { ok: false, error: idProblem };

  if (descriptor.available !== undefined && !isFunction(descriptor.available)) {
    return { ok: false, error: 'available must be a function when present' };
  }
  const capabilities = descriptor.capabilities;
  if (typeof capabilities !== 'object' || capabilities === null) {
    return { ok: false, error: 'descriptor is missing a capabilities object' };
  }

  const declared: PluginCapabilityName[] = [];

  if (capabilities.source !== undefined) {
    const source = capabilities.source;
    if (!isFunction(source.discover) || !isFunction(source.extract)) {
      return { ok: false, error: 'capabilities.source must provide discover() and extract()' };
    }
    declared.push('source');
  }

  if (capabilities.iac !== undefined) {
    const parsers = capabilities.iac.parsers;
    if (!Array.isArray(parsers) || parsers.length === 0) {
      return { ok: false, error: 'capabilities.iac must provide a non-empty parsers array' };
    }
    if (!parsers.every(parser => isFunction(parser.supports) && isFunction(parser.parse))) {
      return { ok: false, error: 'every capabilities.iac parser must provide supports() and parse()' };
    }
    const kindDomains = capabilities.iac.kindDomains;
    if (kindDomains !== undefined) {
      if (!Array.isArray(kindDomains)) {
        return { ok: false, error: 'capabilities.iac.kindDomains must be an array when present' };
      }
      for (const entry of kindDomains) {
        if (typeof entry?.kind !== 'string' || entry.kind.length === 0) {
          return { ok: false, error: 'every capabilities.iac.kindDomains entry needs a non-empty kind' };
        }
        if (typeof entry.meta?.domainId !== 'string' || typeof entry.meta.label !== 'string') {
          return {
            ok: false,
            error: `capabilities.iac.kindDomains entry "${entry.kind}" needs meta.domainId and meta.label`,
          };
        }
      }
    }
    declared.push('iac');
  }

  if (capabilities.loaders !== undefined) {
    const loaders = capabilities.loaders;
    if (!Array.isArray(loaders) || loaders.length === 0) {
      return { ok: false, error: 'capabilities.loaders must be a non-empty array when present' };
    }
    for (const loader of loaders) {
      const problem = pluginContractIdProblem(loader?.id, 'loader id');
      if (problem) return { ok: false, error: problem };
      if (!isFunction(loader.load)) return { ok: false, error: `loader "${loader.id}" is missing load()` };
    }
    declared.push('loaders');
  }

  if (capabilities.projectors !== undefined) {
    const projectors = capabilities.projectors;
    if (!Array.isArray(projectors) || projectors.length === 0) {
      return { ok: false, error: 'capabilities.projectors must be a non-empty array when present' };
    }
    for (const projector of projectors) {
      const problem = pluginContractIdProblem(projector?.id, 'projector id');
      if (problem) return { ok: false, error: problem };
      if (!isFunction(projector.project)) {
        return { ok: false, error: `projector "${projector.id}" is missing project()` };
      }
    }
    declared.push('projectors');
  }

  if (declared.length === 0) {
    return { ok: false, error: 'descriptor declares no capability' };
  }
  return { ok: true, descriptor: descriptor as PluginRuntimeDescriptor, declared };
}
