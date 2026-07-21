/**
 * Map an export-symbol node id to its owning module id (pure string transform).
 *
 * Export-symbol ids are built in stage2 as `export:${moduleId.slice(4)}/${exportName}`, so the owning
 * module is `mod:` + everything in the export id before its final path segment. Used by annotation
 * provenance: an `export:` anchor inspected in a session grounds its owning module (but a coarser
 * `pkg:`/`domain:` anchor deliberately does not). Returns `undefined` for non-`export:` ids or ids
 * with no separable export segment.
 */
export function owningModuleId(exportSymbolId: string): string | undefined {
  if (!exportSymbolId.startsWith('export:')) return undefined;
  const rest = exportSymbolId.slice('export:'.length);
  const lastSlash = rest.lastIndexOf('/');
  if (lastSlash <= 0) return undefined;
  return `mod:${rest.slice(0, lastSlash)}`;
}
