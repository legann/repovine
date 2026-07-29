import { normalizeType } from './ts-utils.js';

/** Type text from source annotations only — never invokes the TypeChecker. */
export function syntaxTypeText(node: { getTypeNode(): { getText(): string } | undefined }): string | undefined {
  const text = node.getTypeNode()?.getText();
  if (!text) return undefined;
  return normalizeType(text);
}

/** Return type from source annotations only — never invokes the TypeChecker. */
export function syntaxReturnTypeText(fn: { getReturnTypeNode(): { getText(): string } | undefined }): string | undefined {
  const text = fn.getReturnTypeNode()?.getText();
  if (!text) return undefined;
  return normalizeType(text);
}

export function paramTypeLabel(name: string, type: string | undefined): string {
  return type ? `${name}: ${type}` : name;
}

export function functionTypeLabel(params: string, returnType: string | undefined): string {
  return returnType ? `(${params}): ${returnType}` : `(${params})`;
}
