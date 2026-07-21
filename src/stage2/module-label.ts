/**
 * Short two-segment label for module and infra-module nodes. Neutral helper shared by the
 * structural and infra-link layers (both previously called the inline copy in stage2/index.ts).
 */
export function shortModuleLabel(relPath: string): string {
  const parts = relPath.replace(/\.(tsx?|jsx?)$/, '').split('/');
  if (parts.length <= 2) return parts.join('/');
  return `…/${parts.slice(-2).join('/')}`;
}
