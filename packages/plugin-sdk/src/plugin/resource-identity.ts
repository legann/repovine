import { isPluginContractId } from './ids.js';

/**
 * Resource identity: the plugin computes components, the SDK encodes them, the host mints the id.
 *
 * A plugin knows what makes one of its resources distinct; the host does not, and a recipe language
 * that tried to express every ecosystem's rule would become the constant this contract exists to
 * remove. So `localKey` is opaque — the plugin builds it however its ecosystem demands — and the
 * only shared rule is how the two components combine into one id.
 *
 * ENCODING
 *
 * `resource:<namespace>:<localKey>`, where `namespace` is a contract id (no `:`) and `localKey` is
 * the terminal segment. Splitting on the first two `:` recovers both components exactly, so the
 * encoding is lossless and unambiguous with no escaping — and escaping would be worse than
 * unnecessary here: existing ids such as `resource:vercel:function:api/hello` carry a `:` inside
 * their local key, and percent-encoding it would move an id that annotations are keyed on.
 */

export const RESOURCE_ID_PREFIX = 'resource';

export interface ResourceIdentity {
  /** Stable identity domain, e.g. `aws-lambda`, `k8s`, `vercel`. */
  namespace: string;
  /** Opaque key, unique within the namespace. May carry `/` and `:`. */
  localKey: string;
}

/** Why this identity cannot be encoded, or undefined when it can. */
export function resourceIdentityProblem(identity: ResourceIdentity): string | undefined {
  if (!isPluginContractId(identity.namespace)) {
    return 'resource namespace must match [A-Za-z0-9][A-Za-z0-9._-]* (no ":", "/" or whitespace)';
  }
  if (typeof identity.localKey !== 'string' || identity.localKey.length === 0) {
    return 'resource localKey must be a non-empty string';
  }
  if (/[\u0000-\u001F\u007F]/.test(identity.localKey)) {
    return 'resource localKey must not contain control characters';
  }
  return undefined;
}

/**
 * Mint the graph id for one resource identity. Throws on an unusable identity: callers validate
 * plugin output at the contribution boundary, so reaching this with a bad namespace is a host bug.
 */
export function makeResourceId(identity: ResourceIdentity): string {
  const problem = resourceIdentityProblem(identity);
  if (problem) throw new Error(problem);
  return `${RESOURCE_ID_PREFIX}:${identity.namespace}:${identity.localKey}`;
}

/** Recover the components from a minted id. Undefined when the string is not one. */
export function parseResourceId(id: string): ResourceIdentity | undefined {
  const prefix = `${RESOURCE_ID_PREFIX}:`;
  if (!id.startsWith(prefix)) return undefined;
  const rest = id.slice(prefix.length);
  const split = rest.indexOf(':');
  if (split <= 0 || split === rest.length - 1) return undefined;
  const namespace = rest.slice(0, split);
  const localKey = rest.slice(split + 1);
  if (!isPluginContractId(namespace)) return undefined;
  return { namespace, localKey };
}
