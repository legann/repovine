import { z } from 'zod';
import { zJsonValue } from './json.js';
import { schemaIdOwner } from './ids.js';
import { SEMANTIC_LINK_RELATIONS } from './projection.js';
import type {
  PluginProjectionBatch,
  ProjectionRef,
} from './projection.js';

/**
 * Runtime validation and size limits for the projection contract.
 *
 * Plugin output is untrusted input: it is validated before anything is applied, and an unknown
 * field, a raw node id, a forged extension owner or an oversized delta is a refusal with an owner
 * attached rather than a silently accepted contribution.
 */

/**
 * Contribution limits, enforced per batch.
 *
 * A batch stands for one module or one infrastructure document, so these ceilings are far above any
 * honest producer — the largest repository measured on this engine carries ~228k graph nodes across
 * ~1300 packages. They exist to make a runaway plugin a diagnosable refusal instead of an
 * out-of-memory build.
 */
export const PROJECTION_BUDGETS = Object.freeze({
  maxBatchesPerContributor: 100_000,
  maxResourcesPerBatch: 2_000,
  maxLinksPerBatch: 5_000,
  maxEntrypointsPerBatch: 2_000,
  maxExtensionsPerBatch: 2_000,
  /** `JSON.stringify` length of one extension payload. */
  maxExtensionPayloadChars: 65_536,
  maxAttributesPerResource: 200,
  /** Any single string a plugin spells in a contribution: key, path, label, attribute value. */
  maxStringLength: 4_096,
});

const zId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must match [A-Za-z0-9][A-Za-z0-9._-]*');

const zSchemaId = z
  .string()
  .min(1)
  .max(160)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*@[1-9][0-9]*$/,
    'must be spelled "<owner>/<name>@<version>"',
  );

const zText = z.string().min(1).max(PROJECTION_BUDGETS.maxStringLength);

/**
 * An opaque key a plugin computes in its own ecosystem's terms. It may carry `/` and `.`; it may
 * not be a minted node id, because identity components are the input to minting, not its output.
 */
const zLocalKey = z
  .string()
  .min(1)
  .max(PROJECTION_BUDGETS.maxStringLength)
  .refine(v => !/^(resource|mod|entrypoint|template|domain|pkg):/.test(v), {
    message: 'localKey is an identity component, not a minted node id',
  });

const zModuleRef = z.strictObject({ type: z.literal('module'), moduleId: zText });
const zResourceRef = z.strictObject({
  type: z.literal('resource'),
  namespace: zId,
  localKey: zLocalKey,
});
const zExtensionRef = z.strictObject({
  type: z.literal('extension'),
  pluginId: zId,
  schema: zSchemaId,
  localKey: zLocalKey,
});

export const zProjectionRef = z.discriminatedUnion('type', [zModuleRef, zResourceRef, zExtensionRef]);

export const zProjectionFactSelector = z.strictObject({
  schema: zSchemaId,
  field: zText.optional(),
});

const zRuntimeResourceContribution = z.strictObject({
  namespace: zId,
  localKey: zLocalKey,
  provider: zId,
  kind: zText,
  label: zText.optional(),
  contentHash: zText,
  attributes: z.record(zText, z.string().max(PROJECTION_BUDGETS.maxStringLength))
    .refine(v => Object.keys(v).length <= PROJECTION_BUDGETS.maxAttributesPerResource, {
      message: `at most ${PROJECTION_BUDGETS.maxAttributesPerResource} attributes`,
    })
    .optional(),
  envVars: z.array(zText).max(PROJECTION_BUDGETS.maxAttributesPerResource).optional(),
});

const zSemanticLinkContribution = z.strictObject({
  from: zProjectionRef,
  to: zProjectionRef,
  relation: z.enum(SEMANTIC_LINK_RELATIONS),
  because: zText.optional(),
});

const zEntrypointContribution = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('api-route'),
    moduleRef: zModuleRef,
    path: zText,
    method: zText,
    label: zText.optional(),
  }),
  z.strictObject({
    kind: z.literal('file-route'),
    moduleRef: zModuleRef,
    path: zText,
    fileType: zText,
    method: zText.optional(),
    label: zText.optional(),
  }),
  z.strictObject({
    kind: z.literal('ui-route'),
    moduleRef: zModuleRef,
    path: zText,
    label: zText.optional(),
  }),
  z.strictObject({
    kind: z.literal('conditional-render'),
    moduleRef: zModuleRef,
    component: zText,
    label: zText.optional(),
  }),
  z.strictObject({
    kind: z.literal('resource-trigger'),
    resourceRef: zResourceRef,
    triggerKind: zText,
    discriminator: zText,
    handlerRef: zModuleRef.optional(),
    label: zText.optional(),
  }),
]);

const zNamespacedExtensionContribution = z.strictObject({
  schema: zSchemaId,
  localKey: zLocalKey,
  subjectRef: zProjectionRef.optional(),
  payload: zJsonValue.refine(
    v => JSON.stringify(v).length <= PROJECTION_BUDGETS.maxExtensionPayloadChars,
    { message: `payload exceeds ${PROJECTION_BUDGETS.maxExtensionPayloadChars} JSON characters` },
  ),
});

/**
 * Discriminator values the entrypoint schema actually accepts, read back off the union.
 *
 * The canonical list a consumer types against is `ENTRYPOINT_CONTRIBUTION_KINDS`; this one is
 * derived from the validator, so a totality check compares two independently written sources rather
 * than a list against itself.
 */
export const ENTRYPOINT_SCHEMA_KINDS: readonly string[] = Object.freeze(
  zEntrypointContribution.options.map(option => option.shape.kind.value as string),
);

export const zPluginProjectionDelta = z.strictObject({
  resources: z.array(zRuntimeResourceContribution).max(PROJECTION_BUDGETS.maxResourcesPerBatch).optional(),
  links: z.array(zSemanticLinkContribution).max(PROJECTION_BUDGETS.maxLinksPerBatch).optional(),
  entrypoints: z.array(zEntrypointContribution).max(PROJECTION_BUDGETS.maxEntrypointsPerBatch).optional(),
  extensions: z.array(zNamespacedExtensionContribution).max(PROJECTION_BUDGETS.maxExtensionsPerBatch).optional(),
});

export const zPluginProjectionBatch = z.strictObject({
  batchId: zText,
  delta: zPluginProjectionDelta,
});

export type ProjectionValidation =
  | { ok: true; batch: PluginProjectionBatch }
  | { ok: false; error: string };

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid batch';
  const where = issue.path.join('.');
  return where ? `${where}: ${issue.message}` : issue.message;
}

/**
 * Validate one batch on its own: shape, spelling and budgets.
 *
 * Pass `pluginId` to also enforce extension ownership — a plugin publishes under its own schema
 * owner and reaches another owner's records through a reference, never by writing under their name.
 * Cross-batch questions (does this reference resolve?) are `checkProjectionRefs`.
 */
export function validateProjectionBatch(
  value: unknown,
  opts: { pluginId?: string } = {},
): ProjectionValidation {
  const parsed = zPluginProjectionBatch.safeParse(value);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const batch = parsed.data as PluginProjectionBatch;

  if (opts.pluginId !== undefined) {
    for (const extension of batch.delta.extensions ?? []) {
      const owner = schemaIdOwner(extension.schema);
      if (owner !== opts.pluginId) {
        return {
          ok: false,
          error: `extension schema "${extension.schema}" is owned by "${owner}", not by "${opts.pluginId}"`,
        };
      }
    }
  }
  return { ok: true, batch };
}

/* ------------------------------- reference resolution ------------------------------- */

/** One batch as accepted from a named contributor. */
export interface AcceptedProjectionBatch {
  pluginId: string;
  contributorId: string;
  batch: PluginProjectionBatch;
}

export type ProjectionRefProblemReason = 'unknown-module' | 'unknown-resource' | 'unknown-extension';

export interface ProjectionRefProblem {
  pluginId: string;
  contributorId: string;
  batchId: string;
  ref: ProjectionRef;
  reason: ProjectionRefProblemReason;
}

function resourceIndexKey(namespace: string, localKey: string): string {
  return JSON.stringify([namespace, localKey]);
}

function extensionIndexKey(pluginId: string, schema: string, localKey: string): string {
  return JSON.stringify([pluginId, schema, localKey]);
}

/**
 * Resolve every reference in a set of accepted batches against the index built from all of them.
 *
 * The index is global and built first, so a reference to a contribution made by a later contributor
 * resolves exactly like one made by an earlier contributor: registration order is not an input.
 */
export function checkProjectionRefs(input: {
  accepted: readonly AcceptedProjectionBatch[];
  knownModuleIds: ReadonlySet<string>;
}): ProjectionRefProblem[] {
  const resources = new Set<string>();
  const extensions = new Set<string>();
  for (const { pluginId, batch } of input.accepted) {
    for (const resource of batch.delta.resources ?? []) {
      resources.add(resourceIndexKey(resource.namespace, resource.localKey));
    }
    for (const extension of batch.delta.extensions ?? []) {
      extensions.add(extensionIndexKey(pluginId, extension.schema, extension.localKey));
    }
  }

  const problems: ProjectionRefProblem[] = [];
  const check = (owner: AcceptedProjectionBatch, ref: ProjectionRef): void => {
    const reason: ProjectionRefProblemReason | undefined =
      ref.type === 'module'
        ? (input.knownModuleIds.has(ref.moduleId) ? undefined : 'unknown-module')
        : ref.type === 'resource'
          ? (resources.has(resourceIndexKey(ref.namespace, ref.localKey)) ? undefined : 'unknown-resource')
          : (extensions.has(extensionIndexKey(ref.pluginId, ref.schema, ref.localKey)) ? undefined : 'unknown-extension');
    if (reason === undefined) return;
    problems.push({
      pluginId: owner.pluginId,
      contributorId: owner.contributorId,
      batchId: owner.batch.batchId,
      ref,
      reason,
    });
  };

  for (const owner of input.accepted) {
    const { delta } = owner.batch;
    for (const link of delta.links ?? []) {
      check(owner, link.from);
      check(owner, link.to);
    }
    for (const entrypoint of delta.entrypoints ?? []) {
      if (entrypoint.kind === 'resource-trigger') {
        check(owner, entrypoint.resourceRef);
        if (entrypoint.handlerRef) check(owner, entrypoint.handlerRef);
      } else {
        check(owner, entrypoint.moduleRef);
      }
    }
    for (const extension of delta.extensions ?? []) {
      if (extension.subjectRef) check(owner, extension.subjectRef);
    }
  }
  return problems;
}
