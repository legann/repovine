import { canonicalJson } from '@repovine/plugin-sdk/internal';
import {
  PROJECTION_BUDGETS,
  checkProjectionRefs,
  makeResourceId,
  validateProjectionBatch,
} from '@repovine/plugin-sdk';
import type {
  AcceptedProjectionBatch,
  ContributionProvenance,
  EntrypointContribution,
  ExtensionRecord,
  NamespacedExtensionContribution,
  PluginOwnerIdentity,
  PluginProjectionBatch,
  ProjectionContributor,
  ReadonlyProjectionInput,
  RuntimeResourceContribution,
  SemanticLinkContribution,
} from '@repovine/plugin-sdk';
import type { EntrypointFragment } from '../../interpreter/types.js';
import type { GraphDelta, GraphEdge, GraphNode } from '../../types.js';
import { compareCodeUnits } from '../../platform/ordering.js';
import { refusal, type Refusal } from '../../response/refusal.js';
import {
  PROJECTION_BATCH_REJECTED_REFUSAL,
  PROJECTION_CONFLICT_REFUSAL,
  PROJECTION_CONTRIBUTOR_FAILED_REFUSAL,
} from '../../stage1/refusal-kinds.js';
import { subjectNodeId } from '../../graph/extension-store.js';
import { relationEdgeKind } from './relations.js';
import { projectedEntrypointId, toEntrypointFragment } from './entrypoints.js';

/**
 * The two-phase projection composer.
 *
 * Every enabled contributor runs against an immutable fact view before anything is applied, and its
 * batches are buffered. Only once every batch is in does the composer validate them, mint ids, build
 * one global reference index, settle references and conflicts against it, and finally apply — nodes
 * and resources first, then links, entrypoints and extensions.
 *
 * What that buys is order independence. A reference to a contribution made by a contributor that
 * runs later resolves exactly like one made by a contributor that ran earlier, because both are in
 * the index before any reference is read. Registration order decides nothing here, and there is no
 * contributor DAG: a contributor states the schemas it reads, never the producers it waits for.
 *
 * Atomicity is per batch — one module or one infrastructure document. A batch that fails validation,
 * carries a dangling reference, or collides with another plugin's contribution contributes nothing
 * at all, and leaves its contributor's other batches and every other contributor's work untouched.
 */

/** A contributor with the package identity the loader stamped on it. */
export interface ProjectionContributorRegistration {
  owner: PluginOwnerIdentity;
  contributor: ProjectionContributor;
}

export interface ProjectionCompositionInput {
  contributors: readonly ProjectionContributorRegistration[];
  input: ReadonlyProjectionInput;
  /** Module ids the graph already holds. A module reference resolves against these. */
  knownModuleIds: ReadonlySet<string>;
  /** Node ids the graph already holds. A minted resource id that collides with one is refused. */
  knownNodeIds: ReadonlySet<string>;
  /**
   * Runtime-resource ids the graph already holds. A resource reference resolves against these as a
   * module reference resolves against `knownModuleIds`: a projection points at what is there and
   * mints only what is not.
   */
  knownResourceIds?: ReadonlySet<string>;
}

export type BatchStatus = 'applied' | 'rejected';

export interface BatchOutcome {
  batchId: string;
  status: BatchStatus;
  /** Present on a rejection: what the batch did that the composer would not apply. */
  reason?: string;
}

export type ContributorStatus = 'applied' | 'skipped' | 'failed';

export interface ContributorOutcome {
  pluginId: string;
  contributorId: string;
  status: ContributorStatus;
  reason?: string;
  batches: BatchOutcome[];
}

export interface ProjectionCompositionResult {
  /** Nodes and edges to apply. Nodes are applied before edges by `applyValidated`. */
  delta: GraphDelta;
  entrypoints: EntrypointFragment[];
  extensions: ExtensionRecord[];
  /** Every contributor that ran, applied, skipped or failed, with its batch outcomes. */
  contributors: ContributorOutcome[];
  refusals: Refusal[];
}

export function emptyProjectionCompositionResult(): ProjectionCompositionResult {
  return { delta: { nodes: [], edges: [] }, entrypoints: [], extensions: [], contributors: [], refusals: [] };
}

/* --------------------------------- buffering --------------------------------- */

interface BufferedBatch {
  owner: PluginOwnerIdentity;
  contributorId: string;
  batch: PluginProjectionBatch;
  /** Set when the batch will not be applied; the outcome and the refusal carry it verbatim. */
  rejection?: string;
}

function batchIdentity(entry: BufferedBatch): string {
  return `${entry.owner.pluginId}\0${entry.contributorId}\0${entry.batch.batchId}`;
}

function batchOrder(a: BufferedBatch, b: BufferedBatch): number {
  return compareCodeUnits(batchIdentity(a), batchIdentity(b));
}

function provenanceOf(entry: BufferedBatch): ContributionProvenance {
  return {
    pluginId: entry.owner.pluginId,
    packageName: entry.owner.packageName,
    packageVersion: entry.owner.packageVersion,
    contributorId: entry.contributorId,
    batchId: entry.batch.batchId,
  };
}

/* --------------------------------- per-batch validation --------------------------------- */

/** Duplicate local keys inside one batch, or undefined when every key is unique. */
function duplicateLocalKey(batch: PluginProjectionBatch): string | undefined {
  const resources = new Set<string>();
  for (const resource of batch.delta.resources ?? []) {
    const key = canonicalJson([resource.namespace, resource.localKey]);
    if (resources.has(key)) {
      return `resource ${resource.namespace}/${resource.localKey} is declared twice in one batch`;
    }
    resources.add(key);
  }
  const extensions = new Set<string>();
  for (const extension of batch.delta.extensions ?? []) {
    const key = canonicalJson([extension.schema, extension.localKey]);
    if (extensions.has(key)) {
      return `extension ${extension.schema}/${extension.localKey} is declared twice in one batch`;
    }
    extensions.add(key);
  }
  return undefined;
}

/** A minted resource id the graph already holds, or undefined when every id is new. */
function collidingResourceId(
  batch: PluginProjectionBatch,
  knownNodeIds: ReadonlySet<string>,
): string | undefined {
  for (const resource of batch.delta.resources ?? []) {
    const id = makeResourceId({ namespace: resource.namespace, localKey: resource.localKey });
    if (knownNodeIds.has(id)) {
      return `resource id "${id}" is already in the graph; a projected resource mints an id, it does not claim one`;
    }
  }
  return undefined;
}

/* --------------------------------- contribution keys --------------------------------- */

/**
 * Key and content of every contribution that can name the same thing twice.
 *
 * The key is what makes two contributions the same thing; the content is what they say about it.
 * Equal key and equal content is one contribution with two owners. Equal key and different content
 * is a conflict.
 */
interface Keyed {
  key: string;
  content: string;
  noun: string;
}

function keyedResource(contribution: RuntimeResourceContribution): Keyed {
  return {
    key: canonicalJson(['resource', contribution.namespace, contribution.localKey]),
    content: canonicalJson({
      provider: contribution.provider,
      kind: contribution.kind,
      label: contribution.label ?? null,
      contentHash: contribution.contentHash,
      attributes: contribution.attributes ?? null,
      envVars: contribution.envVars ?? null,
    }),
    noun: 'runtime resource',
  };
}

function keyedEntrypoint(contribution: EntrypointContribution): Keyed {
  return {
    key: canonicalJson(['entrypoint', projectedEntrypointId(contribution)]),
    content: canonicalJson({ label: contribution.label ?? null }),
    noun: 'entrypoint',
  };
}

function keyedExtension(pluginId: string, contribution: NamespacedExtensionContribution): Keyed {
  return {
    key: canonicalJson(['extension', pluginId, contribution.schema, contribution.localKey]),
    content: canonicalJson({
      subjectRef: contribution.subjectRef ?? null,
      payload: contribution.payload,
    }),
    noun: 'extension',
  };
}

/** Every keyed contribution one batch carries, in the order the batch spells them. */
function keyedContributions(entry: BufferedBatch): Keyed[] {
  const out: Keyed[] = [];
  for (const resource of entry.batch.delta.resources ?? []) out.push(keyedResource(resource));
  for (const entrypoint of entry.batch.delta.entrypoints ?? []) out.push(keyedEntrypoint(entrypoint));
  for (const extension of entry.batch.delta.extensions ?? []) {
    out.push(keyedExtension(entry.owner.pluginId, extension));
  }
  return out;
}

/* --------------------------------- emission --------------------------------- */

function resourceNode(contribution: RuntimeResourceContribution): GraphNode {
  return {
    id: makeResourceId({ namespace: contribution.namespace, localKey: contribution.localKey }),
    type: 'runtime-resource',
    label: contribution.label ?? contribution.localKey,
    description: `${contribution.provider} ${contribution.kind}`,
    data: {
      kind: contribution.kind,
      provider: contribution.provider,
      contentHash: contribution.contentHash,
      ...(contribution.attributes === undefined ? {} : { attributes: contribution.attributes }),
      ...(contribution.envVars === undefined ? {} : { envVars: contribution.envVars }),
    },
  };
}

/** An extension is not a graph node, so a link that ends on one has no edge to draw. */
function linkEdge(contribution: SemanticLinkContribution): GraphEdge | undefined {
  const from = subjectNodeId(contribution.from);
  const to = subjectNodeId(contribution.to);
  if (from === undefined || to === undefined) return undefined;
  return { from, to, kind: relationEdgeKind(contribution.relation) };
}

/* --------------------------------- the pipeline --------------------------------- */

export function composeProjections(input: ProjectionCompositionInput): ProjectionCompositionResult {
  const registrations = [...input.contributors].sort((a, b) => compareCodeUnits(
    `${a.owner.pluginId}\0${a.contributor.id}`,
    `${b.owner.pluginId}\0${b.contributor.id}`,
  ));
  if (registrations.length === 0) return emptyProjectionCompositionResult();

  const refusals: Refusal[] = [];
  const outcomes = new Map<string, ContributorOutcome>();
  const buffered: BufferedBatch[] = [];

  // 1-2. Run every contributor against the immutable view and buffer its batches. A contributor
  // that throws is attributed and loses only its own output.
  for (const { owner, contributor } of registrations) {
    const outcome: ContributorOutcome = {
      pluginId: owner.pluginId,
      contributorId: contributor.id,
      status: 'skipped',
      batches: [],
    };
    outcomes.set(`${owner.pluginId}\0${contributor.id}`, outcome);

    const fail = (reason: string, message: string, refusalReason: Refusal['reason']): void => {
      outcome.status = 'failed';
      outcome.reason = reason;
      refusals.push(refusal(refusalReason, PROJECTION_CONTRIBUTOR_FAILED_REFUSAL, message, {
        pluginId: owner.pluginId,
        contributorId: contributor.id,
      }));
    };

    let batches: readonly PluginProjectionBatch[];
    try {
      batches = contributor.project(input.input);
    } catch (e) {
      const reason = (e as Error).message;
      fail(
        reason,
        `Projector "${contributor.id}" of plugin "${owner.pluginId}" threw while projecting: ${reason}. `
        + 'Everything it would have contributed is absent from the graph.',
        'incomplete',
      );
      continue;
    }

    if (!Array.isArray(batches)) {
      fail(
        'project() did not return an array of batches',
        `Projector "${contributor.id}" of plugin "${owner.pluginId}" returned no batch array, so it `
        + 'contributed nothing. Return an array of batches, empty when there is nothing to add.',
        'incomplete',
      );
      continue;
    }

    if (batches.length > PROJECTION_BUDGETS.maxBatchesPerContributor) {
      fail(
        `returned ${batches.length} batches, over the ${PROJECTION_BUDGETS.maxBatchesPerContributor} budget`,
        `Projector "${contributor.id}" of plugin "${owner.pluginId}" returned ${batches.length} batches, `
        + `over the ${PROJECTION_BUDGETS.maxBatchesPerContributor} allowed, so none was applied.`,
        'rejected-by-policy',
      );
      continue;
    }

    for (const batch of batches) buffered.push({ owner, contributorId: contributor.id, batch });
  }

  buffered.sort(batchOrder);

  // 3. Validate each batch on its own: shape, spelling, budgets, extension ownership, local-key
  // uniqueness, a batch id used twice, and a minted id the graph already holds.
  const seen = new Set<string>();
  for (const entry of buffered) {
    const validated = validateProjectionBatch(entry.batch, { pluginId: entry.owner.pluginId });
    if (!validated.ok) {
      entry.rejection = validated.error;
      continue;
    }
    if (seen.has(batchIdentity(entry))) {
      entry.rejection = `batchId "${entry.batch.batchId}" is used twice by one contributor`;
      continue;
    }
    seen.add(batchIdentity(entry));
    entry.rejection = duplicateLocalKey(entry.batch) ?? collidingResourceId(entry.batch, input.knownNodeIds);
  }

  // 4-6. Mint ids, index every surviving batch, and settle references and conflicts against that one
  // index. Each round only rejects, so `live` strictly shrinks and the loop terminates; a batch
  // dropped here can take another batch's reference target with it, and the next round sees that.
  for (;;) {
    const live = buffered.filter(entry => entry.rejection === undefined);
    const accepted: AcceptedProjectionBatch[] = live.map(entry => ({
      pluginId: entry.owner.pluginId,
      contributorId: entry.contributorId,
      batch: entry.batch,
    }));

    const problems = checkProjectionRefs({
      accepted,
      knownModuleIds: input.knownModuleIds,
      ...(input.knownResourceIds === undefined ? {} : { knownResourceIds: input.knownResourceIds }),
    });
    if (problems.length > 0) {
      for (const problem of problems) {
        const entry = live.find(candidate =>
          candidate.owner.pluginId === problem.pluginId
          && candidate.contributorId === problem.contributorId
          && candidate.batch.batchId === problem.batchId);
        if (entry && entry.rejection === undefined) {
          entry.rejection = `${problem.reason}: reference ${canonicalJson(problem.ref)} resolves to nothing`;
        }
      }
      continue;
    }

    const byKey = new Map<string, Array<{ keyed: Keyed; origin: BufferedBatch }>>();
    for (const entry of live) {
      for (const keyed of keyedContributions(entry)) {
        const bucket = byKey.get(keyed.key);
        if (bucket) bucket.push({ keyed, origin: entry });
        else byKey.set(keyed.key, [{ keyed, origin: entry }]);
      }
    }

    let conflicted = false;
    for (const key of [...byKey.keys()].sort(compareCodeUnits)) {
      const bucket = [...byKey.get(key)!].sort((a, b) => batchOrder(a.origin, b.origin));
      if (new Set(bucket.map(item => item.keyed.content)).size <= 1) continue;
      conflicted = true;
      refusals.push(refusal(
        'conflict',
        PROJECTION_CONFLICT_REFUSAL,
        `Two contributions named one ${bucket[0].keyed.noun} and said different things about it, so `
        + 'neither batch was applied. Make the contributions identical or give them separate keys.',
        {
          key,
          sides: bucket.map(item => ({
            pluginId: item.origin.owner.pluginId,
            contributorId: item.origin.contributorId,
            batchId: item.origin.batch.batchId,
            content: item.keyed.content,
          })),
        },
      ));
      for (const item of bucket) {
        if (item.origin.rejection === undefined) {
          item.origin.rejection =
            `${item.keyed.noun} under key ${key} disagrees with another contribution under the same key`;
        }
      }
    }
    if (conflicted) continue;
    break;
  }

  // 7. Apply in a stable order: nodes and resources first, then links, entrypoints and extensions.
  // Every surviving key now carries one content, so this pass only merges provenance.
  const live = buffered.filter(entry => entry.rejection === undefined);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fragments: EntrypointFragment[] = [];
  const records: ExtensionRecord[] = [];
  const emitted = new Set<string>();

  for (const entry of live) {
    for (const resource of entry.batch.delta.resources ?? []) {
      const { key } = keyedResource(resource);
      if (emitted.has(key)) continue;
      emitted.add(key);
      nodes.push(resourceNode(resource));
    }
  }
  for (const entry of live) {
    for (const link of entry.batch.delta.links ?? []) {
      const edge = linkEdge(link);
      if (edge) edges.push(edge);
    }
  }
  for (const entry of live) {
    for (const entrypoint of entry.batch.delta.entrypoints ?? []) {
      const { key } = keyedEntrypoint(entrypoint);
      if (emitted.has(key)) continue;
      emitted.add(key);
      fragments.push(toEntrypointFragment(entrypoint));
    }
  }
  for (const entry of live) {
    for (const extension of entry.batch.delta.extensions ?? []) {
      const { key } = keyedExtension(entry.owner.pluginId, extension);
      if (emitted.has(key)) continue;
      emitted.add(key);
      records.push({
        pluginId: entry.owner.pluginId,
        schema: extension.schema,
        localKey: extension.localKey,
        ...(extension.subjectRef === undefined ? {} : { subjectRef: extension.subjectRef }),
        payload: extension.payload,
        provenance: provenanceOf(entry),
      });
    }
  }

  // Record what each contributor achieved, and turn every rejection into a refusal a reader sees.
  for (const entry of buffered) {
    const outcome = outcomes.get(`${entry.owner.pluginId}\0${entry.contributorId}`);
    if (!outcome) continue;
    if (entry.rejection === undefined) {
      outcome.batches.push({ batchId: entry.batch.batchId, status: 'applied' });
      continue;
    }
    outcome.batches.push({ batchId: entry.batch.batchId, status: 'rejected', reason: entry.rejection });
    refusals.push(refusal(
      'rejected-by-policy',
      PROJECTION_BATCH_REJECTED_REFUSAL,
      `Batch "${entry.batch.batchId}" from projector "${entry.contributorId}" of plugin `
      + `"${entry.owner.pluginId}" was refused whole: ${entry.rejection}. Nothing it carried is in the graph.`,
      { pluginId: entry.owner.pluginId, contributorId: entry.contributorId, batchId: entry.batch.batchId },
    ));
  }

  for (const outcome of outcomes.values()) {
    if (outcome.status === 'failed') continue;
    if (outcome.batches.some(batch => batch.status === 'applied')) {
      outcome.status = 'applied';
      continue;
    }
    outcome.status = 'skipped';
    outcome.reason = outcome.batches.length === 0
      ? 'contributed no batch'
      : `every one of its ${outcome.batches.length} batches was refused`;
  }

  return {
    delta: { nodes, edges },
    entrypoints: fragments,
    extensions: records,
    contributors: [...outcomes.values()].sort((a, b) => compareCodeUnits(
      `${a.pluginId}\0${a.contributorId}`,
      `${b.pluginId}\0${b.contributorId}`,
    )),
    refusals,
  };
}
