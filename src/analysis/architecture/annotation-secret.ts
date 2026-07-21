/**
 * Shared secret-value heuristics for annotation content.
 *
 * The annotation-secret-hygiene detector (detectors.ts) and its detail view (detail.ts)
 * must agree byte-for-byte on what counts as a secret; a drifting second copy is a
 * security-relevant hazard. This is the single source of truth for both.
 */

/**
 * True when a string looks like a literal secret value (provider token, private key,
 * or a `secret=…`-style assignment). An all-caps env-var NAME (e.g. `API_TOKEN`) is
 * explicitly not a secret — only values are.
 */
export function containsSecretValue(text: string): boolean {
  if (/^(?:[A-Z][A-Z0-9_]{5,}|[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Z0-9_]*)$/.test(text.trim())) return false;
  return /\b(sk_(?:live|test)_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/.test(text)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)
    || /\b(?:secret|token|password|api[_ -]?key|client[_ -]?secret)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{16,}/i.test(text);
}

/**
 * Walk an annotation body and return the dotted paths of every string field that
 * looks like a secret value. `rootPath` labels the top of the tree (default `annotation`).
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
