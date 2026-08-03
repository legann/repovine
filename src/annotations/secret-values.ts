/**
 * Whether a string in an annotation is a credential rather than a description of one.
 *
 * Annotations record env var and config NAMES; the value behind a name belongs in the deployment,
 * not in a file the repository commits. Two surfaces ask this question — the write path refuses a
 * submitted annotation, and the annotation-secret-hygiene detector reports one already on disk —
 * and they must answer it identically, or a value the writer refuses stays invisible once it is in
 * the file by another route.
 *
 * The order of the three rules is the rule. A provider credential and a PEM header have shapes no
 * variable name shares, so they decide first. Only then does the name exemption apply, and it
 * guards exactly one rule: the loose `secret=…` assignment, which a bare name cannot spell.
 */

/** Credential shapes issued by a provider: Stripe, Slack, GitHub, AWS access key id. */
const CREDENTIAL_SHAPE_RE =
  /\b(sk_(?:live|test)_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/;

const PEM_HEADER_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * A whole string that is nothing but an upper-case identifier — `API_TOKEN`, `DATABASE_URL`. This
 * is what an annotation is asked to record, so it is not a secret. An AWS access key id is spelled
 * the same way, which is why the credential dictionary is consulted before this exemption.
 */
const ENV_VAR_NAME_RE = /^(?:[A-Z][A-Z0-9_]{5,}|[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*)$/;

/** `token = <value>` and its spellings: a keyword, an assignment, and enough characters to be one. */
const ASSIGNED_SECRET_RE =
  /\b(?:secret|token|password|api[_ -]?key|client[_ -]?secret)\b\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{8,}/i;

/** True when the string is a literal secret value rather than the name of one. */
export function containsSecretValue(text: string): boolean {
  if (CREDENTIAL_SHAPE_RE.test(text) || PEM_HEADER_RE.test(text)) return true;
  if (ENV_VAR_NAME_RE.test(text.trim())) return false;
  return ASSIGNED_SECRET_RE.test(text);
}

/**
 * Walk an annotation body and return the dotted paths of every string field that is a secret value.
 * `rootPath` labels the top of the tree; the write path reports these paths back so the author can
 * see which field to rewrite.
 */
export function annotationSecretFieldPaths(annotationBody: unknown, rootPath = 'annotation'): string[] {
  const paths: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (containsSecretValue(value)) paths.push(path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, idx) => visit(item, `${path}[${idx}]`));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        visit(nested, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(annotationBody, rootPath);
  return paths;
}
