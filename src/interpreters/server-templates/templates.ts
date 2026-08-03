import type { GraphDelta, RepositoryGraph, TemplateFileInfo } from '../../types.js';
import { addNode, addEdge, emptyGraphDelta, hasEdge } from '../../graph/index.js';
import type { InterpreterGraphContext } from '../../interpreter/types.js';
import { exportSymbolId } from '../../graph/node-ids.js';
import { lastPathSegment, toPosixPath } from '../../platform/paths.js';

export const SERVER_TEMPLATES_INTERPRETER_ID = 'server-templates';

/**
 * Project discovered template artifacts (`snapshot.templates`) as `template` nodes, then link each
 * route's render unit to the template(s) it renders via `renders` edges. The render fact itself
 * comes from RouteInfo.rendersTemplate; this interpreter resolves the template name to a discovered
 * template node and materializes the cross-file `renders` edge. Template-to-template inheritance
 * (`extends`/`includes`) comes from the stage1 template-body parser.
 */
export function contributeServerTemplates(ctx: InterpreterGraphContext): GraphDelta {
  const { graph, snapshot } = ctx;
  const templates = snapshot.templates ?? [];

  // 1. Every discovered template becomes a node (a layout like base.html exists even if only
  //    referenced via inheritance later; needed for "who renders base.html").
  for (const t of templates) {
    if (graph.nodes.has(t.id)) continue;
    addNode(graph, {
      id: t.id,
      type: 'template',
      label: templateLabel(t.relPath),
      description: `Template ${t.relPath}`,
      data: {
        relPath: t.relPath,
        contentHash: t.contentHash,
        ...(t.engine ? { engine: t.engine } : {}),
        ...(t.blocks && t.blocks.length > 0 ? { blocks: t.blocks } : {}),
      },
    });
  }

  // 2. renders edges: view → resolved template node; extends/includes edges: template → template.
  if (templates.length > 0) {
    const resolve = makeTemplateResolver(templates);
    for (const mod of snapshot.modules) {
      for (const route of mod.semanticHints?.routes ?? []) {
        const names = route.rendersTemplate;
        if (!names || names.length === 0) continue;
        const viewId = resolveViewNodeId(graph, mod.id, route.component);
        for (const name of names) {
          const templateId = resolve(name);
          if (!templateId) continue;
          if (hasEdge(graph, viewId, 'renders', templateId)) continue;
          addEdge(graph, viewId, templateId, 'renders');
        }
      }
    }

    for (const t of templates) {
      if (t.extendsTemplate) {
        const parentId = resolve(t.extendsTemplate);
        if (parentId && parentId !== t.id && !hasEdge(graph, t.id, 'extends', parentId)) {
          addEdge(graph, t.id, parentId, 'extends');
        }
      }

      for (const name of t.includesTemplate ?? []) {
        const partialId = resolve(name);
        if (partialId && partialId !== t.id && !hasEdge(graph, t.id, 'includes', partialId)) {
          addEdge(graph, t.id, partialId, 'includes');
        }
      }
    }
  }

  return emptyGraphDelta();
}

/** Basename of the template path (`users/profile.html` → `profile.html`); id carries the full path. */
function templateLabel(relPath: string): string {
  return lastPathSegment(relPath);
}

/**
 * Resolve a template *name* (the literal a view passes to `render`, e.g. `users/profile.html`) to a
 * discovered template *node id*. Framework-neutral suffix resolution, ranked:
 *   1. the path under the last `templates/` segment equals the name (Django per-app / Flask folder);
 *   2. the repo-relative path equals the name;
 *   3. exactly one template ends with `/<name>`.
 * Ambiguous (multiple equally-good matches) → undefined: honest under-capture, never a wrong edge.
 */
export function makeTemplateResolver(
  templates: TemplateFileInfo[],
): (name: string) => string | undefined {
  const byAnchored = new Map<string, string[]>();
  const byRel = new Map<string, string>();
  for (const t of templates) {
    byRel.set(t.relPath, t.id);
    const idx = t.relPath.lastIndexOf('templates/');
    if (idx >= 0) {
      const anchored = t.relPath.slice(idx + 'templates/'.length);
      const list = byAnchored.get(anchored);
      if (list) list.push(t.id);
      else byAnchored.set(anchored, [t.id]);
    }
  }

  return (rawName: string): string | undefined => {
    const name = toPosixPath(rawName).replace(/^\.?\//, '').trim();
    if (!name) return undefined;

    const anchored = byAnchored.get(name);
    if (anchored) return anchored.length === 1 ? anchored[0] : undefined;

    const exact = byRel.get(name);
    if (exact) return exact;

    const suffixHits: string[] = [];
    for (const t of templates) {
      if (t.relPath.endsWith(`/${name}`)) suffixHits.push(t.id);
    }
    return suffixHits.length === 1 ? suffixHits[0] : undefined;
  };
}

/**
 * The view that renders the template. Prefer the export-symbol of the view function/class (so
 * "who renders T" answers at view granularity); `ClassName.method` falls back to `ClassName`; an
 * unresolved view falls back to the module node (the same-file module is always present).
 */
function resolveViewNodeId(graph: RepositoryGraph, modId: string, component: string): string {
  for (const candidate of [component, component.split('.')[0]]) {
    if (!candidate) continue;
    const exportId = exportSymbolId(modId, candidate);
    if (graph.nodes.has(exportId)) return exportId;
  }
  return modId;
}
