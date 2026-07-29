import { z } from 'zod';
import { TRIGGER_ENTRY_KINDS } from '../types.js';
import type { TriggerEntryKind } from '../types.js';

/**
 * The declarative half of a plugin package: JSON facts the host reads from `package.json#repovine`
 * before it imports any plugin code.
 *
 * Declarations and capabilities have different lifetimes on purpose. Capabilities are code and live
 * only while the plugin is enabled and available; declarations are data and survive a disabled
 * capability, so turning a parser off does not silently drop the pruning facts that keep a scan
 * bounded. A fact leaves the catalog when its package is absent or a config retraction names it.
 *
 * `declaredBy` is absent from every declared shape below. The host stamps ownership from package
 * identity, so a payload that spells `declaredBy` itself is refused by the strict schemas.
 */

/**
 * Roles the host knows how to act on. Adding one is new general mechanics, not a new ecosystem.
 *
 * - `dependencies`: vendored third-party code (`node_modules`, `vendor`, `.venv`) — walked past.
 * - `build-output`: compiler/bundler output (`dist`, `build`, `__pycache__`).
 * - `tool-output`: tool state and generated artifacts (`.terraform`, `cdk.out`, `.serverless`).
 * - `test-layout`: a directory whose contents are tests of the package around it.
 */
export const ECOSYSTEM_DIR_ROLES = [
  'dependencies',
  'build-output',
  'tool-output',
  'test-layout',
] as const;

export type EcosystemDirRole = typeof ECOSYSTEM_DIR_ROLES[number];

/**
 * One directory name an ecosystem owns, with the role that says what the host does with it and the
 * reason it is claimed. `because` is required: a pruning fact with no stated reason is the shape
 * that accumulates unowned names.
 */
export interface EcosystemDirFact {
  /** Single path segment, e.g. `node_modules`. Not a glob and not a path. */
  name: string;
  role: EcosystemDirRole;
  /** Why this ecosystem claims the name, in one line. */
  because: string;
}

/**
 * One value a plugin adds to an axis. A canonical axis carries an SDK name and general semantics; a
 * plugin-specific axis is namespaced `<pluginId>/<name>` and stays opaque to generic consumers.
 */
export interface PluginValueDeclaration {
  axis: string;
  value: string;
  label?: string;
  because: string;
}

/**
 * Metadata for one resource kind, keyed by the composite `(namespace, provider, kind)`.
 *
 * `kind` alone cannot be the key: `queue`, `function` and `service` recur across providers, and a
 * single-component key makes the second declaration overwrite the first. `namespace` is the stable
 * identity domain that reaches the minted resource id; `provider` is an opaque ecosystem label the
 * host stores and compares without branching on its value.
 */
export interface ResourceKindDeclaration {
  namespace: string;
  provider: string;
  kind: string;
  /** Optional ecosystem service label, e.g. `lambda`, `sqs`. Opaque to the host. */
  service?: string;
  /** The host tries to resolve this resource's handler attribute to a code module. */
  hasCodeHandler?: boolean;
}

/**
 * Metadata for one trigger type. `namespace`/`provider` are present when the type is
 * ecosystem-specific; a globally meaningful type may omit both.
 */
export interface TriggerTypeDeclaration {
  type: string;
  namespace?: string;
  provider?: string;
  /** The host derives a `consumes` edge from the trigger source to its target. */
  isStreamLike?: boolean;
  /** Canonical entrypoint kind this trigger projects into. */
  entrypointKind?: TriggerEntryKind;
}

/**
 * Where one runtime action writes, by the identity namespace of its target.
 *
 * A source plugin reports that code calls `sqs.sendMessage`; nothing in that fact says which
 * resource receives the message. The namespace owner states it here, so the host pairs a call with a
 * resource by comparing two declared strings instead of by recognising an ecosystem's id spelling.
 * The action is named as its producer spells it, which keeps the pairing producer-neutral: the same
 * normalised action from another language resolves through the same declaration.
 */
export interface RuntimeActionDeclaration {
  action: string;
  /** Identity namespace of the resources this action targets. */
  namespace: string;
}

export interface PluginDeclarationCatalog {
  /** Ecosystem label these declarations belong to, e.g. `aws-sam`. Opaque to the host. */
  ecosystem?: string;
  dirs?: EcosystemDirFact[];
  values?: PluginValueDeclaration[];
  resourceKinds?: ResourceKindDeclaration[];
  triggerTypes?: TriggerTypeDeclaration[];
  runtimeActions?: RuntimeActionDeclaration[];
}

/** Package identity the host stamps onto every declaration and contribution it accepts. */
export interface PluginOwnerIdentity {
  pluginId: string;
  packageName: string;
  packageVersion: string;
}

/** A declaration after the host stamped ownership onto it. */
export type Declared<T> = T & { readonly declaredBy: PluginOwnerIdentity };

/** A catalog after the host stamped ownership onto every entry. */
export interface StampedDeclarationCatalog {
  ecosystem?: string;
  dirs: Declared<EcosystemDirFact>[];
  values: Declared<PluginValueDeclaration>[];
  resourceKinds: Declared<ResourceKindDeclaration>[];
  triggerTypes: Declared<TriggerTypeDeclaration>[];
  runtimeActions: Declared<RuntimeActionDeclaration>[];
}

/* ---------------------------------- schemas ---------------------------------- */

const zContractId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must match [A-Za-z0-9][A-Za-z0-9._-]*');

const zBecause = z.string().min(1).max(200);

const zEcosystemDirFact = z.strictObject({
  name: z.string().min(1).max(128).refine(
    v => !v.includes('/') && !v.includes('\\') && v !== '.' && v !== '..',
    'must be a single path segment',
  ),
  role: z.enum(ECOSYSTEM_DIR_ROLES),
  because: zBecause,
});

const zPluginValueDeclaration = z.strictObject({
  axis: z.string().min(1).max(96).regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/,
    'must be "<axis>" or "<pluginId>/<axis>"',
  ),
  value: z.string().min(1).max(128),
  label: z.string().min(1).max(200).optional(),
  because: zBecause,
});

const zResourceKindDeclaration = z.strictObject({
  namespace: zContractId,
  provider: zContractId,
  kind: z.string().min(1).max(128),
  service: z.string().min(1).max(128).optional(),
  hasCodeHandler: z.boolean().optional(),
});

const zTriggerTypeDeclaration = z.strictObject({
  type: z.string().min(1).max(128),
  namespace: zContractId.optional(),
  provider: zContractId.optional(),
  isStreamLike: z.boolean().optional(),
  entrypointKind: z.enum(TRIGGER_ENTRY_KINDS).optional(),
});

const zRuntimeActionDeclaration = z.strictObject({
  action: z.string().min(1).max(128),
  namespace: zContractId,
});

/** Strict: an unknown key, or a payload spelling its own `declaredBy`, fails here. */
export const zPluginDeclarationCatalog = z.strictObject({
  ecosystem: zContractId.optional(),
  dirs: z.array(zEcosystemDirFact).max(512).optional(),
  values: z.array(zPluginValueDeclaration).max(512).optional(),
  resourceKinds: z.array(zResourceKindDeclaration).max(512).optional(),
  triggerTypes: z.array(zTriggerTypeDeclaration).max(512).optional(),
  runtimeActions: z.array(zRuntimeActionDeclaration).max(512).optional(),
});

/**
 * Stamp package ownership onto every entry of a validated catalog. One implementation, so the
 * `declaredBy` a consumer reads always came from package identity rather than plugin payload.
 */
export function stampDeclarationCatalog(
  catalog: PluginDeclarationCatalog | undefined,
  declaredBy: PluginOwnerIdentity,
): StampedDeclarationCatalog {
  const owner = Object.freeze({ ...declaredBy });
  const stamp = <T>(entries: T[] | undefined): Declared<T>[] =>
    (entries ?? []).map(entry => ({ ...entry, declaredBy: owner }));
  return {
    ...(catalog?.ecosystem === undefined ? {} : { ecosystem: catalog.ecosystem }),
    dirs: stamp(catalog?.dirs),
    values: stamp(catalog?.values),
    resourceKinds: stamp(catalog?.resourceKinds),
    triggerTypes: stamp(catalog?.triggerTypes),
    runtimeActions: stamp(catalog?.runtimeActions),
  };
}

/**
 * Composite metadata key for a resource kind, and the spelling `plugins.retract` accepts for one.
 *
 * `namespace` and `provider` are charset-restricted and cannot contain `/`, so splitting on the
 * first two separators recovers all three components even when `kind` carries one. That is what lets
 * the key stay a legible selector a user can write instead of an encoded blob.
 */
export function resourceKindMetaKey(
  declaration: Pick<ResourceKindDeclaration, 'namespace' | 'provider' | 'kind'>,
): string {
  return `${declaration.namespace}/${declaration.provider}/${declaration.kind}`;
}

/**
 * Composite metadata key for a trigger type. A globally meaningful type declares no namespace or
 * provider, and the absent component is spelled `*` so it cannot collide with a declared one.
 */
export function triggerTypeMetaKey(
  declaration: Pick<TriggerTypeDeclaration, 'type' | 'namespace' | 'provider'>,
): string {
  return `${declaration.namespace ?? '*'}/${declaration.provider ?? '*'}/${declaration.type}`;
}
