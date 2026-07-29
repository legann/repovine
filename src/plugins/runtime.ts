import type {
  DocumentLoader,
  PluginCapabilityName,
  PluginOwnerIdentity,
  ProjectionContributor,
  StampedDeclarationCatalog,
} from '@repovine/plugin-sdk';
import { compareCodeUnits } from '../platform/ordering.js';
import { refusal, type Refusal } from '../response/refusal.js';
import {
  DECLARATION_AMBIGUOUS_REFUSAL,
  DECLARATION_CONFLICT_REFUSAL,
} from '../stage1/refusal-kinds.js';
import type { ProjectionContributorRegistration } from '../stage2/projection/compose.js';
import {
  buildDeclarationCatalog,
  catalogAmbiguities,
  declarationCatalogIdentity,
  type DeclarationCatalog,
} from './declaration-catalog.js';

/**
 * Everything one build's plugin set contributes, assembled once per build.
 *
 * The two halves have different lifetimes and different transports. Declarations are data: they are
 * merged into a catalog that travels with the facts, across the Stage 2 worker boundary and into the
 * snapshot cache. Capabilities are code: loaders and projectors are functions, so they stay on the
 * side of the boundary that loaded them and are handed to composition as an argument.
 *
 * Nothing here is module state. A build that loaded an external plugin leaves no trace for the next
 * build in the same process, which is what makes an external build followed by a default build agree
 * with a cold default build.
 */

export interface RegisteredDocumentLoader {
  owner: PluginOwnerIdentity;
  loader: DocumentLoader;
}

/** One plugin's identity and what it declared, for reports and for the reuse fingerprint. */
export interface PluginRuntimeMember {
  owner: PluginOwnerIdentity;
  capabilities: readonly PluginCapabilityName[];
}

export interface PluginRuntime {
  members: PluginRuntimeMember[];
  catalog: DeclarationCatalog;
  contributors: ProjectionContributorRegistration[];
  loaders: RegisteredDocumentLoader[];
  /** What assembling the runtime refused: conflicting and unnarrowable declarations. */
  refusals: Refusal[];
}

export function emptyPluginRuntime(): PluginRuntime {
  return {
    members: [],
    catalog: buildDeclarationCatalog({ catalogs: [] }),
    contributors: [],
    loaders: [],
    refusals: [],
  };
}

export interface PluginRuntimeInput {
  plugins: ReadonlyArray<{
    owner: PluginOwnerIdentity;
    capabilities: readonly PluginCapabilityName[];
    declarations: StampedDeclarationCatalog;
    loaders?: readonly DocumentLoader[];
    projectors?: readonly ProjectionContributor[];
  }>;
  /** Catalog keys `plugins.retract` names. */
  retract?: readonly string[];
}

function ownerOrder(a: PluginOwnerIdentity, b: PluginOwnerIdentity): number {
  return compareCodeUnits(a.pluginId, b.pluginId);
}

/**
 * Assemble the runtime for one build.
 *
 * Input order is not preserved: members, loaders and contributors are sorted by owner and by their
 * own ids, so two configs that list the same plugins in different orders produce the same runtime.
 */
export function buildPluginRuntime(input: PluginRuntimeInput): PluginRuntime {
  const members = input.plugins
    .map(plugin => ({ owner: plugin.owner, capabilities: [...plugin.capabilities] }))
    .sort((a, b) => ownerOrder(a.owner, b.owner));

  const catalog = buildDeclarationCatalog({
    catalogs: input.plugins.map(plugin => plugin.declarations),
    ...(input.retract === undefined ? {} : { retract: input.retract }),
  });

  const loaders: RegisteredDocumentLoader[] = input.plugins
    .flatMap(plugin => (plugin.loaders ?? []).map(loader => ({ owner: plugin.owner, loader })))
    .sort((a, b) => compareCodeUnits(
      `${a.owner.pluginId}\0${a.loader.id}`,
      `${b.owner.pluginId}\0${b.loader.id}`,
    ));

  const contributors: ProjectionContributorRegistration[] = input.plugins
    .flatMap(plugin => (plugin.projectors ?? []).map(contributor => ({ owner: plugin.owner, contributor })))
    .sort((a, b) => compareCodeUnits(
      `${a.owner.pluginId}\0${a.contributor.id}`,
      `${b.owner.pluginId}\0${b.contributor.id}`,
    ));

  return { members, catalog, contributors, loaders, refusals: declarationRefusals(catalog) };
}

/**
 * What the merged catalog refused, as refusals a reader sees.
 *
 * A conflict means neither declaration is in force, and an ambiguity means a single-component lookup
 * has two answers and therefore gives none. Both change what the build knows, so both are published
 * rather than resolved by picking a side.
 */
function declarationRefusals(catalog: DeclarationCatalog): Refusal[] {
  const out: Refusal[] = [];
  for (const conflict of catalog.conflicts) {
    const owners = conflict.sides.map(side => side.declaredBy.packageName).join(' and ');
    out.push(refusal(
      'conflict',
      DECLARATION_CONFLICT_REFUSAL,
      `${owners} declared "${conflict.key}" with different effects, so neither declaration is in `
      + 'force. Make the declarations agree, or drop one from the plugin set.',
      { key: conflict.key, family: conflict.family, sides: conflict.sides },
    ));
  }
  for (const ambiguity of catalogAmbiguities(catalog)) {
    out.push(refusal(
      'conflict',
      DECLARATION_AMBIGUOUS_REFUSAL,
      `${ambiguity.keys.join(' and ')} both narrow onto "${ambiguity.component}" with different `
      + 'effects, so the lookup for it answers nothing. Make the declarations agree, or drop one.',
      { component: ambiguity.component, family: ambiguity.family, keys: ambiguity.keys },
    ));
  }
  return out;
}

/**
 * Identity of everything the runtime decides, for the snapshot-reuse fingerprint.
 *
 * Plugin versions, the merged catalog, loader ids and projector ids with their declared fact needs
 * all change what a build produces from unchanged source bytes, so a snapshot taken under one is not
 * reusable under another.
 */
export function pluginRuntimeIdentity(runtime: PluginRuntime): unknown {
  return {
    members: runtime.members.map(member => [
      member.owner.pluginId,
      member.owner.packageName,
      member.owner.packageVersion,
      [...member.capabilities].sort(compareCodeUnits),
    ]),
    catalog: declarationCatalogIdentity(runtime.catalog),
    loaders: runtime.loaders.map(entry => [entry.owner.pluginId, entry.loader.id]),
    projectors: runtime.contributors.map(entry => [
      entry.owner.pluginId,
      entry.contributor.id,
      (entry.contributor.requires ?? []).map(selector => [selector.schema, selector.field ?? null]),
    ]),
  };
}
